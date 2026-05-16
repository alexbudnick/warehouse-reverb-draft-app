import express from "express";
import dotenv from "dotenv";
import { findReadyWarehouseReverbDrafts } from "./services/airtable.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

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

async function reverbGet(path) {
  const base = process.env.REVERB_API_BASE || "https://api.reverb.com/api";
  const token = process.env.REVERB_PERSONAL_TOKEN;

  if (!token) {
    throw new Error("Missing REVERB_PERSONAL_TOKEN");
  }

  const response = await fetch(`${base}${path}`, {
    method: "GET",
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
    throw new Error(`Reverb API error ${response.status}: ${JSON.stringify(data)}`);
  }

  return data;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    status: "running",
    version: "categories-clean-1"
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

app.listen(PORT, () => {
  console.log(`Warehouse Reverb Draft App listening on port ${PORT}`);
});
