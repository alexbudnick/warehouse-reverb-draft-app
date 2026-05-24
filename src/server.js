import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { findReadyWarehouseReverbDrafts } from "./services/airtable.js";
import Airtable from "airtable";

dotenv.config();

const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_PAT
}).base(process.env.AIRTABLE_BASE_ID);

async function updateReverbWriteback(recordId, listingId, listingUrl) {
  try {
    const fields = {};

    if (listingId) {
      fields[process.env.AIRTABLE_REVERB_LISTING_ID_FIELD || "Reverb Listing ID"] = String(listingId);
    }

    if (listingUrl) {
      fields[process.env.AIRTABLE_REVERB_URL_FIELD || "Reverb URL"] = listingUrl;
    }

    await airtable(process.env.AIRTABLE_TABLE_NAME).update([
      {
        id: recordId,
        fields
      }
    ]);

    console.log("Updated Airtable writeback:", {
      recordId,
      listingId,
      listingUrl
    });
  } catch (error) {
    console.error("Failed Airtable writeback:", error);
  }
}


const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");

const IMAGE_DIR = process.env.REVERB_IMAGE_DIR || "/tmp/reverb-images";

const ELECTRIC_GUITARS_CATEGORY_UUID = process.env.REVERB_DEFAULT_CATEGORY_UUID || "dfd39027-d134-4353-b9e4-57dc6be791b9";
const DEFAULT_SHIPPING_PROFILE_ID = process.env.REVERB_DEFAULT_SHIPPING_PROFILE_ID || "115306";

const CONDITION_UUIDS = {
  "Brand New": "7c3f45de-2ae0-4c81-8400-fdb6b1d74890",
  "B-Stock": "9225283f-60c2-4413-ad18-1f5eba7a856f",
  "Mint": "ac5b9c1e-dc78-466d-b0b3-7cf712967a48",
  "Excellent": "df268ad1-c462-4ba6-b6db-e007e23922ea",
  "Very Good": "ae4d9114-1bd7-4ec5-a4ba-6653af5ac84d",
  "Good": "f7a3f48c-972a-44c6-b01a-0cd27488d3f6",
  "Fair": "98777886-76d0-44c8-865e-bb40e669e934",
  "Poor": "6a9dfcad-600b-46c8-865e-bb40e669e934".replace("6e0","6e0"),
  "Non Functioning": "fbf35668-96a0-4baa-bcde-ab18d6b1b329"
};
CONDITION_UUIDS["Poor"] = "6a9dfcad-600b-46c8-9e08-ce6e5057921e";

function requireSecret(req, res, next) {
  const expected = process.env.SYNC_TRIGGER_SECRET;
  if (!expected) return next();
  const supplied = req.query.secret || req.headers["x-sync-secret"];
  if (supplied !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

function requestBaseUrl(req) {
  return PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function safeFilename(filename, index) {
  const raw = String(filename || `photo-${index + 1}.jpg`).trim();
  let clean = raw.replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(clean)) clean += ".jpg";
  return clean;
}

function contentTypeFromFilename(filename) {
  if (/\.png$/i.test(filename)) return "image/png";
  if (/\.gif$/i.test(filename)) return "image/gif";
  if (/\.webp$/i.test(filename)) return "image/webp";
  return "image/jpeg";
}

async function prepareStaticImageUrls(req, record) {
  const attachments = [
    ...(record.photoAttachments || []),
    ...(record.techPhotoAttachments || [])
  ].filter((a) => a?.url);

  const runId = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}`;
  const dir = path.join(IMAGE_DIR, runId);
  await fs.mkdir(dir, { recursive: true });

  const urls = [];

  for (const [index, attachment] of attachments.entries()) {
    const filename = safeFilename(attachment.filename, index);
    const filePath = path.join(dir, filename);

    const upstream = await fetch(attachment.url);
    if (!upstream.ok) {
      throw new Error(`Could not download Airtable image ${upstream.status}: ${attachment.filename || attachment.url}`);
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    await fs.writeFile(filePath, buffer);

    urls.push(`${requestBaseUrl(req)}/reverb-static/${runId}/${encodeURIComponent(filename)}`);
  }

  return urls;
}

async function serveStaticReverbImage(req, res) {
  try {
    const runId = String(req.params.runId || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const filename = String(req.params.filename || "").replace(/[^a-zA-Z0-9._-]/g, "");
    const filePath = path.join(IMAGE_DIR, runId, filename);

    const stat = await fs.stat(filePath);
    res.setHeader("Content-Type", contentTypeFromFilename(filename));
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    if (req.method === "HEAD") return res.end();

    const data = await fs.readFile(filePath);
    res.end(data);
  } catch (error) {
    console.error("reverb-static image error:", error);
    res.status(404).send("Image not found");
  }
}

app.get("/reverb-static/:runId/:filename", serveStaticReverbImage);
app.head("/reverb-static/:runId/:filename", serveStaticReverbImage);

async function reverbRequest(path, options = {}) {
  const base = process.env.REVERB_API_BASE || "https://api.reverb.com/api";
  const token = process.env.REVERB_PERSONAL_TOKEN;
  if (!token) throw new Error("Missing REVERB_PERSONAL_TOKEN");

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
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) {
    const err = new Error(`Reverb API ${response.status}: ${JSON.stringify(data)}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function reverbPost(path, body) {
  return reverbRequest(path, { method: "POST", body: JSON.stringify(body) });
}

function getConditionUuid(conditionRanking) {
  return CONDITION_UUIDS[conditionRanking] || CONDITION_UUIDS["Very Good"];
}

function formatDescriptionForReverb(description) {
  if (!description) return "";
  return String(description)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim().replace(/\n/g, "<br>"))
    .filter(Boolean)
    .join("<br><br>");
}

async function buildDraftPayload(req, record) {
  const rawDescription = record.listingDescriptionDraft || `SKU: ${record.sku}`;
  const photoUrls = await prepareStaticImageUrls(req, record);

  return {
    state: "draft",
    title: record.generatedListingTitle || record.name || record.sku,
    description: formatDescriptionForReverb(rawDescription),
    make: record.make || "Unknown",
    model: record.model || record.name || "Unknown Model",
    finish: record.color || "Unknown",
    year: record.year ? String(record.year) : "Unknown",
    categories: [{ uuid: ELECTRIC_GUITARS_CATEGORY_UUID }],
    condition: { uuid: getConditionUuid(record.conditionRanking) },
    price: { amount: Number(record.price || 0), currency: "USD" },
    inventory: 1,
    sku: record.sku || undefined,
    shipping_profile_id: DEFAULT_SHIPPING_PROFILE_ID,
    photos: photoUrls
  };
}

function resultInfo(result) {
  const selfHref = result?._links?.self?.href || null;
  const webHref = result?._links?.web?.href || null;
  return {
    reverbListingId: selfHref ? selfHref.split("/").filter(Boolean).pop() : null,
    reverbUrl: webHref
  };
}

app.get("/", (req, res) => {
  res.json({ ok: true, app: "warehouse-reverb-draft-app", version: "2.2.1-continue-on-error-fixed", dryRun: DRY_RUN });
});

app.get("/jobs/warehouse-reverb/ready-drafts", requireSecret, async (req, res) => {
  try {
    const records = await findReadyWarehouseReverbDrafts();
    res.json({ ok: true, count: records.length, records });
  } catch (error) {
    console.error("ready-drafts error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});


function duplicateSkuResult(record, error) {
  const message = String(error?.data?.message || error?.message || "");
  const listing = error?.data?.listing || null;

  if (message.toLowerCase().includes("sku already exists")) {
    return {
      sku: record.sku,
      title: record.generatedListingTitle || record.name || record.sku,
      conditionRanking: record.conditionRanking,
      status: "skipped_duplicate",
      error: "SKU already exists in Reverb shop",
      reverbListingId: null,
      reverbUrl: listing?._links?.web?.href || null
    };
  }

  return null;
}

app.get("/jobs/warehouse-reverb/create-drafts", requireSecret, async (req, res) => {
  try {
    const records = await findReadyWarehouseReverbDrafts();
    if (!records.length) return res.json({ ok: true, message: "No draft-ready records found." });

    const created = [];
    const skipped = [];
    const failed = [];

    for (const record of records) {
      try {
        const payload = await buildDraftPayload(req, record);

        console.log("CREATING REVERB DRAFT:");
        console.log(JSON.stringify({
          sku: payload.sku,
          title: payload.title,
          conditionRanking: record.conditionRanking,
          descriptionLength: String(payload.description || "").length,
          photosCount: payload.photos.length,
          firstPhotoUrl: payload.photos[0] || null,
          dryRun: DRY_RUN
        }, null, 2));

        if (DRY_RUN) {
          
        await updateReverbWriteback(
          record.recordId,
          createdListing?.id || null,
          createdListing?._links?.web?.href ||
            createdListing?.web_url ||
            createdListing?.url ||
            null
        );

created.push({
            sku: record.sku,
            title: payload.title,
            conditionRanking: record.conditionRanking,
            descriptionLength: String(payload.description || "").length,
            photosCount: payload.photos.length,
            firstPhotoUrl: payload.photos[0] || null,
            reverbListingId: "DRY_RUN_LISTING_ID",
            reverbUrl: "https://reverb.com/item/DRY_RUN_LISTING_ID"
          });
          continue;
        }

        const result = await reverbPost("/listings", payload);
        const ids = resultInfo(result);

        created.push({
          sku: record.sku,
          title: payload.title,
          conditionRanking: record.conditionRanking,
          descriptionLength: String(payload.description || "").length,
          photosCount: payload.photos.length,
          firstPhotoUrl: payload.photos[0] || null,
          ...ids
        });
      } catch (error) {
        const duplicate = duplicateSkuResult(record, error);

        if (duplicate) {
          console.warn("Skipping duplicate Reverb SKU and continuing batch:", record.sku);
          skipped.push(duplicate);
          continue;
        }

        console.error("Failed one Reverb draft; continuing batch:", {
          sku: record.sku,
          error: error.message
        });

        failed.push({
          sku: record.sku,
          title: record.generatedListingTitle || record.name || record.sku,
          conditionRanking: record.conditionRanking,
          status: "failed",
          error: error.message
        });
      }
    }

    res.json({
      ok: failed.length === 0,
      scannedReadyRecords: records.length,
      createdCount: created.length,
      skippedCount: skipped.length,
      failedCount: failed.length,
      created,
      skipped,
      failed
    });
  } catch (error) {
    console.error("create-drafts fatal error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`Warehouse Reverb Draft App listening on port ${PORT}`));
