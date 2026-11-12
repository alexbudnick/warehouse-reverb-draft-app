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

const DEFAULT_SHIPPING_PROFILE_ID = process.env.REVERB_DEFAULT_SHIPPING_PROFILE_ID || "";


function normalizeCost(value) {
  if (value === null || value === undefined || value === "") return null;

  const cleaned = String(value)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();

  const parsed = parseFloat(cleaned);

  return Number.isNaN(parsed) ? null : parsed;
}

const airtable = new Airtable({
  apiKey: process.env.AIRTABLE_PAT
}).base(process.env.AIRTABLE_BASE_ID);

const CONDITION_UUIDS = {
  "Brand New": "7c3f45de-2ae0-4c81-8400-fdb6b1d74890",
  "B-Stock": "9225283f-60c2-4413-ad18-1f5eba7a856f",
  "Mint": "ac5b9c1e-dc78-466d-b0b3-7cf712967a48",
  "Mint (With Inventory)": "6db7df88-293b-4017-a1c1-cdb5e599fa1a",
  "Mint (with inventory)": "6db7df88-293b-4017-a1c1-cdb5e599fa1a",
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
  const raw = String(conditionRanking || "").trim();

  // Airtable currently uses "Mint (With Inventory)" while Reverb documents
  // the label as "Mint (with inventory)". Accept either capitalization.
  if (CONDITION_UUIDS[raw]) return CONDITION_UUIDS[raw];

  const wanted = normalize(raw);
  const match = Object.entries(CONDITION_UUIDS).find(([name]) => normalize(name) === wanted);
  if (match) return match[1];

  // Do not silently create an incorrect Very Good listing when a new/typo'd
  // Airtable condition appears. Failing the record is safer than mislisting it.
  throw new Error(`Unsupported Reverb condition: ${conditionRanking || "(blank)"}`);
}

function isInventoryCondition(conditionRanking) {
  const condition = normalize(conditionRanking);
  return condition === normalize("Mint (with inventory)") || condition === normalize("B-Stock");
}

function inventoryQuantity(value) {
  const parsed = numberOrNull(value);
  if (parsed === null) return 1;
  return Math.max(0, Math.floor(parsed));
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

// Explicit Airtable labels, verified against Reverb /categories/flat.
// Broad shared labels use a broad category; do not guess a subtype by substring.
const AIRTABLE_CATEGORY_UUIDS = {
  "Acoustic Electric Guitars": "09ea109a-5df1-4156-b00c-7456a3e5abf3",
  "Effects and Pedals": "fa10f97c-dd98-4a8f-933b-8cb55eb653dd",
  "Electric Guitars": "dfd39027-d134-4353-b9e4-57dc6be791b9",
  "Drum Machines and Samplers": "e36bdc32-abba-45e2-948b-ce60153cbdd9",
  "Bass Guitars": "53a9c7d7-d73d-4e7f-905c-553503e50a90",
  "Keyboard Accessories": "62835d2e-ac92-41fc-9b8d-4aba8c1c25d5",
  "Bass Guitar Necks": "3852c31e-5019-4cd6-8c60-ba5fd397cf43",
  "Hollow Body Electric Guitars": "5db35d7e-2b7e-4dcf-a73b-6a144c710956",
  "Synths": "d002db05-ab63-4c79-999c-d49bbe8d7739",
  "Semi-Hollow Body Electric Guitars": "6a63ac2e-f2a5-4064-b6ea-0393f42ee497",
  "Short Scale Basses": "07276aa7-6f18-4cae-a691-e6043b002fa4",
  "Multi-Effects Pedals and Processors": "2d6093b4-6b33-474e-b07c-25f6657d7956",
  "Guitar Pickups": "ed9714d2-2b98-4e1e-b85e-eb2f948a8985",
  "Guitar Necks": "c33e4de7-7ec0-4de9-912c-98a4dcb268c8",
  "Wireless Receivers": "58d52275-f213-4c21-919e-c38a7c9f35bc",
  "Bass 5+ String": "3178be7d-f1cd-4da5-a606-bf3c1b8e834d",
  "Microphones": "0f2bbf76-3225-44d5-8a5b-c540cc1fd058",
  "Gates and Expanders": "10187eaa-7746-4978-9f44-7670e95a40da",
  "Audio Interfaces": "dfb72735-b7a3-4c8f-9b14-0d1dd904af1e",
  "Acoustic Guitars": "3ca3eb03-7eac-477d-b253-15ce603d2550",
  "Pro Audio": "b021203f-1ed8-476c-a8fc-32d4e3b0ef9e",
  "Modeling Amps": "0338462f-285a-4273-afde-47c4fc752e3f",
  "Baritone Electric Guitars": "8f8b1f88-83f5-449c-8c93-b57cf3ba1fd7",
  "Classical Guitars": "a7f470d1-266d-4495-b4d6-998cc84b7474",
  "Compressors and Limiters": "8865016e-edbb-4ee7-a704-6ea0652d6bf4",
  "Recording Gear": "36a0faca-93b7-4ad1-ab09-02629ec1e900",
  "12 String Electric Guitars": "80d6ce96-487c-4ac1-ad10-d4bef6336fe6",
  "Tuner Pedals": "69a7e38f-0ce8-42ea-a0f6-8a30b7f6886e",
  "Preamps": "4d45f512-4dd5-4dae-95b7-7eb400ce406b",
  "Amplifiers": "09055aa7-ed49-459d-9452-aa959f288dc2",
  "Amp Heads": "19d53222-297e-410c-ba4f-b48678e917f9",
  "7 String Electric Guitars": "dfd39027-d134-4353-b9e4-57dc6be791b9",
  "Bass Effect Pedals": "c6602a28-e2e7-4e70-abeb-0fa38b320be6",
  "Drum Machines": "e36bdc32-abba-45e2-948b-ce60153cbdd9",
  "Digital Synthesizers": "75b1e4a3-dbb4-46c5-8386-fa18546e097a",
  "Guitar Synth": "7e6b6d7c-cdd5-4a42-bceb-6ea12899137b",
  "Straps": "1b357626-300e-47dd-85b0-bf657bca1a96",
  "12 String Acoustic Guitars": "14d6cc96-ed7b-4521-bc21-7713c61e9dc5",
  "Noise Reduction and Gates": "8745626e-3273-4f9d-b7a1-ca5b202a8e6e",
  "Left Handed Guitars": "c86f64cf-43df-4430-a2bf-b4126d81c5bd",
  "Multi-Effect Reverb": "101acc1f-ae38-4e27-9fde-1948498618aa",
  "DI Boxes": "0bbe9f3e-7a6e-4654-862f-96dd6136c9b3",
  "Utility": "4a1f4a3a-c266-4771-b473-ec547b835e55",
  "Amp Parts": "eb1827f3-c02c-46ff-aea9-7983e2aae1b4",
  "Grooveboxes": "b3608028-206e-467c-8d93-db5489b1727b",
  "Bass Pickups": "96843abf-85ee-4d86-93e9-3140d698f1b7",
  "DJ Controllers": "5737678f-8d15-4df2-b402-869d5bfc04bd",
  "Accessories": "62835d2e-ac92-41fc-9b8d-4aba8c1c25d5"
};

async function getCategoryUuid(record) {
  const value = String(record.reverbCategoryUuid || record.productType || "").trim();
  const fallback = process.env.REVERB_DEFAULT_CATEGORY_UUID || "dfd39027-d134-4353-b9e4-57dc6be791b9";
  if (looksLikeUuid(value)) return value;
  const categoryMap = parseJsonEnv("REVERB_CATEGORY_MAP_JSON", {});
  const wanted = normalize(value);
  const configured = Object.entries(categoryMap).find(([key]) => normalize(key) === wanted);
  if (configured && looksLikeUuid(configured[1])) return String(configured[1]).trim();
  const known = Object.entries(AIRTABLE_CATEGORY_UUIDS).find(([key]) => normalize(key) === wanted);
  if (known) return known[1];
  if (wanted) {
    try {
      if (!categoryCache) {
        const data = await reverbRequest("/categories/flat", { method: "GET" });
        categoryCache = (data.categories || []).filter(item => item?.uuid && item.listable !== false);
      }
      const matches = categoryCache.filter(category =>
        [category.full_name, category.name, category.collection_title].some(name => normalize(name) === wanted)
      );
      const unique = [...new Set(matches.map(category => category.uuid))];
      if (unique.length === 1) return unique[0];
    } catch (error) {
      console.warn("Could not resolve Reverb category; sending draft with default:", error.message);
    }
  }
  console.warn("Using default Reverb category:", { sku: record.sku, productType: value || "(blank)", categoryUuid: fallback });
  return fallback;
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
  result = result?.listing || result;
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
    throw error;
  }
}

async function buildDraftPayload(req, record) {
  const rawDescription = record.listingDescriptionDraft || `SKU: ${record.sku}`;
  const photoUrls = await prepareStaticImageUrls(req, record);
  const categoryUuid = await getCategoryUuid(record);
  const shippingProfileId = await getShippingProfileId(record);
  const cost = numberOrNull(record.cost);
  const supportsInventory = isInventoryCondition(record.conditionRanking);
  const qtyOnHand = inventoryQuantity(record.qtyOnHand);

  const payload = {
    state: "draft",
    offers_enabled: false,
    title: record.generatedListingTitle || record.name || record.sku,
    description: formatDescriptionForReverb(rawDescription),
    make: record.make || "Unknown",
    model: record.model || record.name || "Unknown Model",
    finish: record.color || "Unknown",
    year: record.year ? String(record.year) : "Unknown",
    categories: [{ uuid: categoryUuid }],
    condition: { uuid: getConditionUuid(record.conditionRanking) },
    price: { amount: Number(record.price || 0), currency: "USD" },
    inventory: supportsInventory ? qtyOnHand : 1,
    sku: record.sku || undefined,
    photos: photoUrls
  };

  // Reverb requires has_inventory=true together with inventory=N for
  // retail/multi-quantity listings. Unique used items retain the app's
  // existing one-off behavior.
  if (supportsInventory) {
    payload.has_inventory = true;
  }

  if (shippingProfileId) {
    payload.shipping_profile_id = shippingProfileId;
  }

  if (cost !== null) {
    payload.seller_cost = cost.toFixed(2);
  }

  return payload;
}


async function findExistingReverbSku(sku) {
  let apiPath = "/my/listings?sku=" + encodeURIComponent(sku) + "&state=all&per_page=50";
  const found = new Map(), visited = new Set();
  while (apiPath) {
    if (visited.has(apiPath) || visited.size >= 30) throw new Error("Incomplete existing-SKU lookup");
    visited.add(apiPath);
    const data = await reverbRequest(apiPath, {method:"GET"});
    const listings = data.listings || data._embedded?.listings;
    if (!Array.isArray(listings)) throw new Error("Existing-SKU response missing listings");
    for (const item of listings) if (String(item.sku || item.inventory?.sku || "").trim() === sku) found.set(String(item.id),item);
    const next = data._links?.next?.href;
    if (!next) break;
    const url = new URL(next, "https://api.reverb.com/api" + apiPath);
    if (url.origin !== "https://api.reverb.com" || url.pathname !== "/api/my/listings") throw new Error("Unsafe existing-SKU pagination");
    apiPath = url.pathname.slice(4) + url.search;
  }
  if (found.size !== 1) throw new Error("Existing SKU could not be linked uniquely: " + sku + " (" + found.size + " matches)");
  return [...found.values()][0];
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
    version: "2.4.1-inventory-cost-fix",
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
    const allReady = await findReadyWarehouseReverbDrafts();
    const requestedSku = String(req.query.sku || "").trim();
    const records = requestedSku ? allReady.filter(record => record.sku === requestedSku) : allReady;
    if (requestedSku && records.length !== 1) return res.status(409).json({ok:false,error:"Expected exactly one draft-ready record for requested SKU",sku:requestedSku,count:records.length});
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
          sellerCost: payload.seller_cost || null,
          conditionRanking: record.conditionRanking,
          qtyOnHand: record.qtyOnHand,
          reverbInventory: payload.inventory,
          hasInventory: payload.has_inventory === true,
          conditionUuid: payload.condition?.uuid || null,
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
            sellerCost: payload.seller_cost || null,
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
          qtyOnHand: record.qtyOnHand,
          reverbInventory: payload.inventory,
          hasInventory: payload.has_inventory === true,
          conditionUuid: payload.condition?.uuid || null,
          descriptionLength: String(payload.description || "").length,
          photosCount: payload.photos.length,
          firstPhotoUrl: payload.photos[0] || null,
          categoryUuid: payload.categories?.[0]?.uuid || null,
          shippingProfileId: payload.shipping_profile_id || null,
          cost: record.cost || null,
          sellerCost: payload.seller_cost || null,
          ...ids
        });
      } catch (error) {
        const duplicate = duplicateSkuResult(record, error);

        if (duplicate) {
          try {
            const existing = await findExistingReverbSku(record.sku);
            const ids = resultInfo(existing);
            if (!ids.reverbListingId) throw new Error("Existing Reverb listing ID missing");
            await updateReverbWriteback(record.recordId, ids.reverbListingId, ids.reverbUrl);
            skipped.push({...duplicate,...ids,status:"linked_existing",state:existing.state?.slug || existing.state});
            console.log("Linked existing Reverb SKU:", {sku:record.sku,...ids});
          } catch (linkError) {
            failed.push({sku:record.sku,status:"existing_listing_requires_review",error:linkError.message});
            console.error("Existing Reverb SKU needs review:", {sku:record.sku,error:linkError.message});
          }
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


async function inspectExactReverbSkus(skus) {
  const wanted = new Set(skus);
  const matches = [];
  const visited = new Set();
  let apiPath = "/my/listings?state=all&per_page=50&page=1";
  let scanned = 0;
  while (apiPath) {
    if (visited.has(apiPath) || visited.size >= 200) throw new Error("Incomplete or repeated Reverb pagination");
    visited.add(apiPath);
    const data = await reverbRequest(apiPath, {method:"GET"});
    const listings = data.listings || data._embedded?.listings;
    if (!Array.isArray(listings)) throw new Error("Reverb response missing listings");
    for (const listing of listings) {
      scanned++;
      const sku = String(listing.sku || listing.inventory?.sku || "").trim();
      if (wanted.has(sku)) matches.push({
        sku, id:listing.id, title:listing.title,
        state:listing.state?.slug || listing.state,
        url:listing._links?.web?.href || listing.web_url || null,
        photoCount:Array.isArray(listing.photos) ? listing.photos.length : null,
        price:listing.price, offersEnabled:listing.offers_enabled
      });
    }
    const next = data._links?.next?.href;
    if (!next) { apiPath = null; continue; }
    const url = new URL(next, "https://api.reverb.com/api" + apiPath);
    if (url.origin !== "https://api.reverb.com" || !url.pathname.startsWith("/api/my/listings")) throw new Error("Unsafe Reverb pagination");
    apiPath = url.pathname.slice(4) + url.search;
  }
  return {ok:true,complete:true,scanned,matches,missing:skus.filter(sku=>!matches.some(item=>item.sku===sku))};
}
app.get("/jobs/warehouse-reverb/inspect-skus", requireSecret, async(req,res)=>{
  try {
    const skus = [...new Set(String(req.query.skus || "").split(",").map(x=>x.trim()).filter(Boolean))];
    if (!skus.length || skus.length > 25) return res.status(400).json({ok:false,error:"Provide 1 to 25 exact SKUs"});
    res.json(await inspectExactReverbSkus(skus));
  } catch(error) { res.status(500).json({ok:false,error:error.message}); }
});

app.listen(PORT, () => console.log(`Warehouse Reverb Draft App listening on port ${PORT}`));
