import express from "express";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import Airtable from "airtable";
import { findReadyWarehouseReverbDrafts } from "./services/airtable.js";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const IMAGE_DIR = process.env.REVERB_IMAGE_DIR || "/tmp/reverb-images";

const DEFAULT_CATEGORY_UUID = process.env.REVERB_DEFAULT_CATEGORY_UUID || "dfd39027-d134-4353-b9e4-57dc6be791b9";
const DEFAULT_SHIPPING_PROFILE_ID = process.env.REVERB_DEFAULT_SHIPPING_PROFILE_ID || "";

const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_PAT
}).base(process.env.AIRTABLE_BASE_ID);

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

let categoryCache = null;
let shippingProfileCache = null;

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

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseJsonEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn(`Could not parse ${name} as JSON:`, error.message);
    return fallback;
  }
}

function looksLikeUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function looksLikeNumericId(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const cleaned = String(value).replace(/[$,]/g, "").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function flattenObjects(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenObjects(item, output);
  } else if (value && typeof value === "object") {
    output.push(value);
    for (const nested of Object.values(value)) flattenObjects(nested, output);
  }
  return output;
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

async function reverbRequest(apiPath, options = {}) {
  const base = process.env.REVERB_API_BASE || "https://api.reverb.com/api";
  const token = process.env.REVERB_PERSONAL_TOKEN;
  if (!token) throw new Error("Missing REVERB_PERSONAL_TOKEN");

  const response = await fetch(`${base}${apiPath}`, {
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

async function reverbPost(apiPath, body) {
  return reverbRequest(apiPath, { method: "POST", body: JSON.stringify(body) });
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

async function getCategoryUuid(record) {
  const value = record.reverbCategoryUuid || record.productType;
  if (looksLikeUuid(value)) return String(value).trim();

  const categoryMap = parseJsonEnv("REVERB_CATEGORY_MAP_JSON", {});
  const mapped = categoryMap[value] || categoryMap[normalize(value)];
  if (mapped) return mapped;

  if (!value) return DEFAULT_CATEGORY_UUID;

  try {
    if (!categoryCache) {
      const data = await reverbRequest("/categories/flat", { method: "GET" });
      const objects = flattenObjects(data);
      categoryCache = objects
        .filter((item) => item?.uuid)
        .map((item) => ({
          uuid: item.uuid,
          name: item.name || item.display_name || item.full_name || item.slug || "",
          fullName: item.full_name || item.fullName || item.name || item.display_name || ""
        }));
    }

    const wanted = normalize(value);
    const exact = categoryCache.find((category) =>
      normalize(category.fullName) === wanted || normalize(category.name) === wanted
    );
    if (exact?.uuid) return exact.uuid;

    const contains = categoryCache.find((category) =>
      normalize(category.fullName).includes(wanted) || wanted.includes(normalize(category.fullName))
    );
    if (contains?.uuid) return contains.uuid;
  } catch (error) {
    console.warn("Could not resolve Reverb category from API; using default category:", error.message);
  }

  return DEFAULT_CATEGORY_UUID;
}

async function getShippingProfileId(record) {
  const value = record.reverbShippingProfileId || record.shippingProfile;
  if (looksLikeNumericId(value)) return Number(String(value).trim());

  const profileMap = parseJsonEnv("REVERB_SHIPPING_PROFILE_MAP_JSON", {});
  const mapped = profileMap[value] || profileMap[normalize(value)];
  if (mapped && looksLikeNumericId(mapped)) return Number(String(mapped).trim());

  if (value) {
    try {
      if (!shippingProfileCache) {
        const shop = await reverbRequest("/shop", { method: "GET" });
        const objects = flattenObjects(shop);
        shippingProfileCache = objects
          .filter((item) => item?.id && item?.name)
          .map((item) => ({ id: item.id, name: item.name }));
      }

      const wanted = normalize(value);
      const match = shippingProfileCache.find((profile) => normalize(profile.name) === wanted);
      if (match?.id && looksLikeNumericId(match.id)) return Number(match.id);
    } catch (error) {
      console.warn("Could not resolve Reverb shipping profile from /shop:", error.message);
    }
  }

  if (DEFAULT_SHIPPING_PROFILE_ID && looksLikeNumericId(DEFAULT_SHIPPING_PROFILE_ID)) {
    return Number(DEFAULT_SHIPPING_PROFILE_ID);
  }

  return null;
}

function resultInfo(result) {
  const selfHref = result?._links?.self?.href || null;
  const webHref = result?._links?.web?.href || result?.web_url || result?.url || null;
  const idFromHref = selfHref ? selfHref.split("/").filter(Boolean).pop() : null;
  return {
    reverbListingId: result?.id || result?.listing_id || result?.uuid || idFromHref || null,
    reverbUrl: webHref
  };
}

async function updateReverbWriteback(recordId, listingId, listingUrl) {
  try {
    const fields = {};

    if (listingId) {
      fields[process.env.AIRTABLE_REVERB_LISTING_ID_FIELD || "Reverb Listing ID"] = String(listingId);
    }

    if (listingUrl) {
      fields[process.env.AIRTABLE_REVERB_URL_FIELD || "Reverb URL"] = listingUrl;
    }

    if (!Object.keys(fields).length) return;

    await airtable(process.env.AIRTABLE_TABLE_NAME).update([{ id: recordId, fields }]);
    console.log("Updated Airtable writeback:", { recordId, listingId, listingUrl });
  } catch (error) {
    console.error("Failed Airtable writeback:", error);
  }
}

async function buildDraftPayload(req, record) {
  const rawDescription = record.listingDescriptionDraft || `SKU: ${record.sku}`;
  const photoUrls = await prepareStaticImageUrls(req, record);
  const categoryUuid = await getCategoryUuid(record);
  const shippingProfileId = await getShippingProfileId(record);
  const cost = numberOrNull(record.cost);

  const payload = {
    state: "draft",
    title: record.generatedListingTitle || record.name || record.sku,
    description: formatDescriptionForReverb(rawDescription),
    make: record.make || "Unknown",
    model: record.model || record.name || "Unknown Model",
    finish: record.color || "Unknown",
    year: record.year ? String(record.year) : "Unknown",
    categories: [{ uuid: categoryUuid }],
    condition: { uuid: getConditionUuid(record.conditionRanking) },
    price: { amount: Number(record.price || 0), currency: "USD" },
    inventory: 1,
    sku: record.sku || undefined,
    photos: photoUrls
  };

  if (shippingProfileId) {
    payload.shipping_profile_id = shippingProfileId;
  }

  if (cost !== null) {
    payload.cost = { amount: cost, currency: "USD" };
  }

  return payload;
}

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
      reverbListingId: listing?.id || listing?.listing_id || listing?.uuid || null,
      reverbUrl: listing?._links?.web?.href || null
    };
  }

  return null;
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "warehouse-reverb-draft-app",
    version: "2.3.0-category-shipping-cost",
    dryRun: DRY_RUN
  });
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
          productType: record.productType,
          categoryUuid: payload.categories?.[0]?.uuid || null,
          shippingProfile: record.shippingProfile,
          shippingProfileId: payload.shipping_profile_id || null,
          cost: record.cost || null,
          conditionRanking: record.conditionRanking,
          descriptionLength: String(payload.description || "").length,
          photosCount: payload.photos.length,
          firstPhotoUrl: payload.photos[0] || null,
          dryRun: DRY_RUN
        }, null, 2));

        if (DRY_RUN) {
          created.push({
            sku: record.sku,
            title: payload.title,
            conditionRanking: record.conditionRanking,
            descriptionLength: String(payload.description || "").length,
            photosCount: payload.photos.length,
            firstPhotoUrl: payload.photos[0] || null,
            categoryUuid: payload.categories?.[0]?.uuid || null,
            shippingProfileId: payload.shipping_profile_id || null,
            cost: record.cost || null,
            reverbListingId: "DRY_RUN_LISTING_ID",
            reverbUrl: "https://reverb.com/item/DRY_RUN_LISTING_ID"
          });
          continue;
        }

        const result = await reverbPost("/listings", payload);
        const ids = resultInfo(result);
        await updateReverbWriteback(record.recordId, ids.reverbListingId, ids.reverbUrl);

        created.push({
          sku: record.sku,
          title: payload.title,
          conditionRanking: record.conditionRanking,
          descriptionLength: String(payload.description || "").length,
          photosCount: payload.photos.length,
          firstPhotoUrl: payload.photos[0] || null,
          categoryUuid: payload.categories?.[0]?.uuid || null,
          shippingProfileId: payload.shipping_profile_id || null,
          cost: record.cost || null,
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
