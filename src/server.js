import express from "express";
import dotenv from "dotenv";
import { findReadyWarehouseReverbDrafts } from "./services/airtable.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const ELECTRIC_GUITARS_CATEGORY_UUID = "dfd39027-d134-4353-b9e4-57dc6be791b9";
const GUITAR_SHIPPING_PROFILE_ID = "115306";

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

async function reverbGet(path) {
  return reverbRequest(path, { method: "GET" });
}

async function reverbPost(path, body) {
  return reverbRequest(path, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function buildDraftPayload(record) {
  return {
    state: "draft",
    title: record.generatedListingTitle || record.name || record.sku,
    description: record.listingDescriptionDraft || `SKU: ${record.sku}`,
    make: record.make || "Unknown",
    model: record.model || record.name || "Unknown Model",
    finish: record.color || "Unknown",
    year: record.year ? String(record.year) : "Unknown",
    categories: [
      {
        uuid: ELECTRIC_GUITARS_CATEGORY_UUID
      }
    ],
    condition: {
      uuid: "TEMP_CONDITION_UUID"
    },
    price: {
      amount: Number(record.price || 0),
      currency: "USD"
    },
    inventory: 1,
    sku: record.sku || undefined,
    shipping_profile_id: GUITAR_SHIPPING_PROFILE_ID
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    version: "conditions-test"
  });
});

app.get("/jobs/warehouse-reverb/test-conditions", requireSecret, async (req, res) => {
  try {
    const data = await reverbGet("/conditions");

    res.json({
      ok: true,
      conditions: data.conditions || data
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
      console.log(JSON.stringify(payload, null, 2));

      const result = await reverbPost("/listings", payload);

      created.push({
        sku: record.sku,
        title: payload.title,
        reverbListingId: result.id || null,
        reverbUrl: result._links?.web?.href || null
      });
    }

    res.json({
      ok: true,
      created
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Warehouse Reverb Draft App listening on port ${PORT}`);
});
