import express from "express";
import dotenv from "dotenv";
import { findReadyWarehouseReverbDrafts } from "./services/airtable.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ELECTRIC_GUITARS_CATEGORY_UUID = "dfd39027-d134-4353-b9e4-57dc6be791b9";
const GUITAR_SHIPPING_PROFILE_ID = "115306";

const CONDITION_UUIDS = {
  "Mint": "a1d7f4f1-0e25-4f68-91be-63fbb4145a7f",
  "Excellent": "8b8b8b8b-8b8b-8b8b-8b8b-8b8b8b8b8b8b",
  "Very Good": "ae4d9114-1bd7-4ec5-a4ba-6653af5ac84d",
  "Good": "5c0cb4e0-c5a3-46e2-9386-61ab0ad99d84",
  "Fair": "42c8c9fd-37f9-4f3b-bc6b-6e7b0bdbd8d8",
  "Poor": "c3c9b2d7-1d6c-4f91-b0f3-6e0d7e5a7f99"
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
    throw new Error(`Reverb API ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function reverbPost(path, body) {
  return reverbRequest(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function getConditionUuid(conditionRanking) {
  return (
    CONDITION_UUIDS[conditionRanking] ||
    CONDITION_UUIDS["Very Good"]
  );
}

function buildDraftPayload(record) {
  const allPhotos = [
    ...(record.photos || []),
    ...(record.techPhotos || [])
  ];

  return {
    state: "draft",

    title:
      record.generatedListingTitle ||
      record.name ||
      record.sku,

    description:
      record.listingDescriptionDraft ||
      `SKU: ${record.sku}`,

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

    photos: allPhotos.map((url) => ({
      url
    }))
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    version: "condition-mapping-1"
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
        photosCount: payload.photos.length
      }, null, 2));

      const result = await reverbPost("/listings", payload);

      const selfHref = result?._links?.self?.href || null;
      const webHref = result?._links?.web?.href || null;

      created.push({
        sku: record.sku,
        title: payload.title,
        conditionRanking: record.conditionRanking,
        photosCount: payload.photos.length,
        reverbListingId: selfHref ? selfHref.split("/").pop() : null,
        reverbUrl: webHref
      });
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
