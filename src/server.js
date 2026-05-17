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

async function reverbGet(path) {
  return reverbRequest(path, { method: "GET" });
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
  const selfHref = result?._links?.self?.href || null;
  if (!selfHref) return null;
  return selfHref.split("/").filter(Boolean).pop();
}

function webHrefFromResult(result) {
  return result?._links?.web?.href || null;
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

async function updateReverbListingPhotos(listingId, photoUrls) {
  const photos = (photoUrls || []).filter(Boolean);

  if (!listingId || !photos.length) {
    console.log("No Reverb photos to update", { listingId, photosCount: photos.length });
    return { uploaded: 0 };
  }

  console.log("UPDATING REVERB PHOTOS:");
  console.log(JSON.stringify({ listingId, photosCount: photos.length }, null, 2));

  await reverbPut(`/listings/${listingId}`, {
    photos,
    photo_upload_method: "override_position"
  });

  return { uploaded: photos.length };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    version: "reverb-photo-writeback-1.1.0"
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

      const result = await createOrRecoverReverbDraft(payload);

      const listingId = listingIdFromResult(result);
      const webHref = webHrefFromResult(result);

      const allPhotos = [
        ...(record.photos || []),
        ...(record.techPhotos || [])
      ].filter(Boolean);

      const photoResult = await updateReverbListingPhotos(listingId, allPhotos);

      const createdResult = {
        sku: record.sku,
        title: payload.title,
        conditionRanking: record.conditionRanking,
        descriptionLength: String(payload.description || "").length,
        photosCount: allPhotos.length,
        photosUploaded: photoResult.uploaded,
        reverbListingId: listingId,
        reverbUrl: webHref
      };

      await updateWarehouseReverbDraftResult(record.recordId, createdResult);

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
