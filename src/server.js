import express from "express";
import dotenv from "dotenv";
import { findReadyWarehouseReverbDrafts } from "./services/airtable.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

function requireSecret(req, res, next) {
  const expected = process.env.SYNC_TRIGGER_SECRET;

  if (!expected) {
    return next();
  }

  const supplied = req.query.secret || req.headers["x-sync-secret"];

  if (supplied !== expected) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized: missing or invalid secret"
    });
  }

  next();
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    purpose: "Find Airtable records ready for Warehouse Reverb draft creation",
    status: "running"
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

app.listen(PORT, () => {
  console.log(`Warehouse Reverb Draft App listening on port ${PORT}`);
});
