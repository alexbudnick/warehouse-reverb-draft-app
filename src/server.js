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
      error: "Unauthorized: missing or invalid secret"
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
      "Authorization": `Bearer ${token}`,
      ...(options.headers || {})
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
    throw new Error(`Reverb API error ${response.status}: ${JSON.stringify(data)}`);
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

function pickTitle(record) {
  return (
    record.generatedListingTitle ||
    record.name ||
    record.sku ||
    "Untitled Warehouse Reverb Draft"
  );
}

function pickDescription(record) {
  return (
    record.listingDescriptionDraft ||
    record.description ||
    `SKU: ${record.sku || ""}`
  );
}

function buildDraftPayload(record) {
  return {
    state: "draft",
    title: pickTitle(record),
    description: pickDescription(record),
    make: record.make || "Unknown",
    model: record.model || pickTitle(record),
    finish: record.color || "Unknown",
    year: record.year ? String(record.year) : "Unknown",
    categories: [
      {
        uuid: ELECTRIC_GUITARS_CATEGORY_UUID
      }
    ],
    condition: {
      uuid: "b6f849d4-8c3f-4a65-9b40-6b018d0b7b80"
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
    status: "running",
    version: "create-draft-test-1"
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

app.get("/jobs/warehouse-reverb/test-reverb-shop", requireSecret, async (req, res) => {
  try {
    const shop = await reverbGet("/shop");

    res.json({
      ok: true,
      shopName: shop.name || null,
      shopId: shop.id || null,
      shippingProfiles: shop.shipping_profiles || []
    });
  } catch (error) {
    console.error("test-reverb-shop error:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/jobs/warehouse-reverb/test-categories", requireSecret, async (req, res) => {
  try {
    const data = await reverbGet("/categories/flat");
    const categories = data.categories || [];

    res.json({
      ok: true,
      count: categories.length,
      categories: categories.slice(0, 50)
    });
  } catch (error) {
    console.error("test-categories error:", error);

    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/jobs/warehouse-reverb/create-drafts", requireSecret, async (req, res) => {
  try {
    const records = await findReadyWarehouseReverbDrafts();

    if (records.length === 0) {
      return res.json({
        ok: true,
        message: "No eligible Warehouse Reverb drafts found.",
        created: []
      });
    }

    const created = [];

    for (const record of records) {
      const payload = buildDraftPayload(record);

      console.log("Creating Warehouse Reverb draft payload:");
      console.log(JSON.stringify(payload, null, 2));

      const result = await reverbPost("/listings", payload);

      created.push({
        sku: record.sku,
        title: payload.title,
        reverbResponse: result
      });
    }

    res.json({
      ok: true,
      count: created.length,
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
