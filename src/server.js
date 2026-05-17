import express from "express";
import dotenv from "dotenv";
import {
  findReadyWarehouseReverbDrafts,
  updateWarehouseReverbDraftResult
} from "./services/airtable.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const ELECTRIC_GUITARS_CATEGORY_UUID = "dfd39027-d134-4353-b9e4-57dc6be791b9";
const GUITAR_SHIPPING_PROFILE_ID = "115306";

const CONDITION_UUIDS = {
  "Brand New": "7c3f45de-2ae0-4c81-8400-fdb6b1d74890",
  "B-Stock": "9225283f-60c2-4413-ad18-1f5eba7a856f",
  "Mint": "ac5b9c1e-dc78-466d-b0b3-7cf712967a48",
  "Excellent": "df268ad1-c462-4ba6-b6db-e007e23922ea",
  "Very Good": "ae4d9114-1bd7-4ec5-a4ba-6653af5ac84d",
  "Good": "f7a3f48c-972a-44c6-b01a-0cd27488d3f6",
  "Fair": "98777886-76d0-44c8-865e-bb40e669e934",
  "Poor": "6a9dfcad-600b-46c8-9e08-ce6e5057921e",
  "Non Functioning": "fbf35668-96a0-4baa-bcde-ab18d6b1b329"
};

function requireSecret(req, res, next) {
  const expected = process.env.SYNC_TRIGGER_SECRET;

  if (!expected) return next();

  const supplied = req.query.secret || req.headers["x-sync-secret"];

  if (supplied !== expected) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized"
    });
  }

  next();
}

async function reverbRequest(path, options = {}) {
  const base = process.env.REVERB_API_BASE || "https://api.reverb.com/api";
  const token = process.env.REVERB_PERSONAL_TOKEN;

  if (!token) {
    throw new Error("Missing REVERB_PERSONAL_TOKEN");
  }

  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/hal+json",
      "Accept": "application/hal+json",
      "Accept-Version": "3.0",
      "Authorization": `Bearer ${token}`
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`Reverb API ${response.status}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}


async function reverbRequestUrl(url, options = {}) {
  const token = process.env.REVERB_PERSONAL_TOKEN;

  if (!token) {
    throw new Error("Missing REVERB_PERSONAL_TOKEN");
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/hal+json",
      "Accept": "application/hal+json",
      "Accept-Version": "3.0",
      "Authorization": `Bearer ${token}`
    }
  });

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const error = new Error(`Reverb API ${response.status}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    error.url = url;
    throw error;
  }

  return data;
}

async function reverbPutUrl(url, body) {
  return reverbRequestUrl(url, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

async function reverbGet(path) {
  return reverbRequest(path, { method: "GET" });
}

async function findReverbListingBySku(sku) {
  if (!sku) return null;

  const path = `/my/listings?sku=${encodeURIComponent(sku)}&state=all`;
  const data = await reverbGet(path);
  const listings = data?.listings || [];

  if (!listings.length) {
    console.warn("No Reverb listing found by SKU after create", { sku });
    return null;
  }

  return listings[0];
}

async function reverbPost(path, body) {
  return reverbRequest(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function reverbPut(path, body) {
  return reverbRequest(path, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

function getConditionUuid(conditionRanking) {
  return (
    CONDITION_UUIDS[conditionRanking] ||
    CONDITION_UUIDS["Very Good"]
  );
}

function formatDescriptionForReverb(description) {
  if (!description) return "";

  return String(description)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .trim()
        .replace(/\n/g, "<br>")
    )
    .filter(Boolean)
    .join("<br><br>");
}

function buildDraftPayload(record) {
  const allPhotos = [
    ...(record.photos || []),
    ...(record.techPhotos || [])
  ].filter(Boolean);

  const rawDescription =
    record.listingDescriptionDraft ||
    `SKU: ${record.sku}`;

  return {
    state: "draft",

    title:
      record.generatedListingTitle ||
      record.name ||
      record.sku,

    description: formatDescriptionForReverb(rawDescription),

    make: record.make || "Unknown",

    model:
      record.model ||
      record.name ||
      "Unknown Model",

    finish:
      record.color ||
      "Unknown",

    year:
      record.year
        ? String(record.year)
        : "Unknown",

    categories: [
      {
        uuid: ELECTRIC_GUITARS_CATEGORY_UUID
      }
    ],

    condition: {
      uuid: getConditionUuid(record.conditionRanking)
    },

    price: {
      amount: Number(record.price || 0),
      currency: "USD"
    },

    inventory: 1,

    sku: record.sku || undefined,

    shipping_profile_id: GUITAR_SHIPPING_PROFILE_ID,

    // Reverb accepts listing creation without photos. We add photos in a
    // separate explicit PUT after creation so Airtable URLs are applied
    // predictably and image order is preserved.
    photos: []
  };
}


function listingIdFromResult(result) {
  if (!result) return null;
  if (result.id) return String(result.id);
  if (result.uuid) return String(result.uuid);
  if (result.slug) return String(result.slug);

  const selfHref = result?._links?.self?.href || null;
  if (!selfHref) return null;
  return selfHref.split("/").filter(Boolean).pop();
}

function webHrefFromResult(result) {
  return result?._links?.web?.href || null;
}

function apiPathFromHref(href) {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.pathname.replace(/^\/api/, "");
  } catch {
    return String(href).replace(/^https?:\/\/[^/]+\/api/, "");
  }
}

function updateHrefFromResult(result) {
  const listingId = listingIdFromResult(result);
  if (listingId) return `https://api.reverb.com/api/listings/${listingId}`;
  return result?._links?.update?.href || result?._links?.self?.href || null;
}

function isDuplicateSkuWithListing(error) {
  return (
    error?.status === 422 &&
    error?.data &&
    error.data.listing &&
    String(error.data.message || "").toLowerCase().includes("sku already exists")
  );
}

async function createOrRecoverReverbDraft(payload) {
  if (DRY_RUN) {
    console.log("DRY_RUN would create Reverb draft:");
    console.log(JSON.stringify({
      sku: payload.sku,
      title: payload.title,
      descriptionLength: String(payload.description || "").length,
      photosCount: payload.photos?.length || 0
    }, null, 2));

    return {
      _dryRun: true,
      _links: {
        self: { href: "https://api.reverb.com/api/listings/DRY_RUN_LISTING_ID" },
        update: { method: "PUT", href: "https://api.reverb.com/api/listings/DRY_RUN_LISTING_ID" },
        web: { href: "https://reverb.com/item/DRY_RUN_LISTING_ID" }
      }
    };
  }

  try {
    return await reverbPost("/listings", payload);
  } catch (error) {
    if (isDuplicateSkuWithListing(error)) {
      console.warn("Reverb reported duplicate SKU, but returned listing data. Treating as existing draft.");
      return error.data.listing;
    }
    throw error;
  }
}

async function updateReverbListingPhotos(result, photoUrls) {
  const photos = (photoUrls || []).filter(Boolean);
  const updateHref = updateHrefFromResult(result);

  if (!photos.length) {
    console.log("No Reverb photos to update", { photosCount: photos.length });
    return { uploaded: 0, error: null, confirmed: false };
  }

  if (!updateHref) {
    const message = "Could not determine Reverb update link for photo upload";
    console.warn(message);
    return { uploaded: 0, error: message, confirmed: false };
  }

  console.log("UPDATING REVERB PHOTOS:");
  console.log(JSON.stringify({ updateHref, photosCount: photos.length, dryRun: DRY_RUN }, null, 2));

  if (DRY_RUN) {
    console.log("DRY_RUN would update Reverb photos:");
    console.log(JSON.stringify({
      updateHref,
      photosCount: photos.length,
      photo_upload_method: "override_position"
    }, null, 2));
    return { uploaded: photos.length, error: null, confirmed: true };
  }

  try {
    const updateResponse = await reverbPutUrl(updateHref, {
      photos,
      photo_upload_method: "override_position"
    });

    const cloudinaryCount = Array.isArray(updateResponse?.cloudinary_photos)
      ? updateResponse.cloudinary_photos.length
      : null;

    const returnedPhotosCount = Array.isArray(updateResponse?.photos)
      ? updateResponse.photos.length
      : null;

    console.log("REVERB PHOTO UPDATE RESPONSE SUMMARY:");
    console.log(JSON.stringify({
      cloudinaryPhotosCount: cloudinaryCount,
      returnedPhotosCount,
      requestedPhotosCount: photos.length
    }, null, 2));

    // Reverb may process photos asynchronously or not return the complete photo list.
    // Count as "sent" if the PUT succeeded, but include confirmation fields in logs.
    return {
      uploaded: photos.length,
      error: null,
      confirmed: cloudinaryCount === null ? true : cloudinaryCount > 0
    };
  } catch (error) {
    const message = `Photo update failed but draft was created: ${error.message}`;
    console.error(message);
    if (error.url) console.error("Photo update URL:", error.url);

    return { uploaded: 0, error: message, confirmed: false };
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    version: "reverb-final-writeback-photo-debug-1.5.0"
  });
});

app.get("/jobs/warehouse-reverb/ready-drafts", requireSecret, async (req, res) => {
  try {
    const records = await findReadyWarehouseReverbDrafts();

    res.json({
      ok: true,
      count: records.length,
      records
    });
  } catch (error) {
    console.error("ready-drafts error:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/warehouse-reverb/test-listing-conditions", requireSecret, async (req, res) => {
  try {
    const data = await reverbGet("/listing_conditions");

    res.json({
      ok: true,
      data
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/warehouse-reverb/create-drafts", requireSecret, async (req, res) => {
  try {
    const records = await findReadyWarehouseReverbDrafts();

    if (!records.length) {
      return res.json({
        ok: true,
        message: "No draft-ready records found."
      });
    }

    const created = [];

    for (const record of records) {
      const payload = buildDraftPayload(record);

      console.log("CREATING REVERB DRAFT:");
      console.log(JSON.stringify({
        sku: payload.sku,
        title: payload.title,
        conditionRanking: record.conditionRanking,
        descriptionLength: String(payload.description || "").length,
        photosCount: (record.photos || []).length + (record.techPhotos || []).length
      }, null, 2));

      const createResult = await createOrRecoverReverbDraft(payload);

      // Reverb create responses can be sparse. Per Reverb docs, find the
      // listing by SKU with state=all so drafts are included, then use that
      // listing ID for photo updates and Airtable writeback.
      const foundListing = DRY_RUN ? createResult : (await findReverbListingBySku(record.sku)) || createResult;

      const listingId = listingIdFromResult(foundListing);
      const webHref = webHrefFromResult(foundListing);

      const allPhotos = [
        ...(record.photos || []),
        ...(record.techPhotos || [])
      ].filter(Boolean);

      const photoResult = await updateReverbListingPhotos(foundListing, allPhotos);

      const createdResult = {
        sku: record.sku,
        title: payload.title,
        conditionRanking: record.conditionRanking,
        descriptionLength: String(payload.description || "").length,
        photosCount: allPhotos.length,
        photosUploaded: photoResult.uploaded,
        photosConfirmed: photoResult.confirmed || false,
        photoUploadError: photoResult.error || null,
        reverbListingId: listingId,
        reverbUrl: webHref
      };

      if (DRY_RUN) {
        console.log("DRY_RUN would update Airtable with Reverb draft result:");
        console.log(JSON.stringify({
          recordId: record.recordId,
          ...createdResult
        }, null, 2));
      } else {
        await updateWarehouseReverbDraftResult(record.recordId, createdResult);
      }

      created.push(createdResult);
    }

    res.json({
      ok: true,
      created
    });
  } catch (error) {
    console.error("create-drafts error:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Warehouse Reverb Draft App listening on port ${PORT}`);
});
