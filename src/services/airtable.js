import Airtable from "airtable";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function escapeFormulaString(value) {
  return String(value).replace(/"/g, '\\"');
}

function getField(fields, name, fallback = null) {
  return fields[name] ?? fallback;
}

function getAttachmentUrls(fields, name) {
  const attachments = fields[name];

  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment) => attachment.url)
    .filter(Boolean);
}

export async function findReadyWarehouseReverbDrafts() {
  const apiKey = requiredEnv("AIRTABLE_PAT");
  const baseId = requiredEnv("AIRTABLE_BASE_ID");
  const tableName = requiredEnv("AIRTABLE_TABLE_NAME");

  const readyField = process.env.AIRTABLE_READY_FOR_DRAFT_FIELD || "Ready for Draft";
  const destinationField = process.env.AIRTABLE_LISTING_DESTINATION_FIELD || "Listing Destination";
  const reverbListingIdField = process.env.AIRTABLE_REVERB_LISTING_ID_FIELD || "Reverb Listing ID";
  const warehouseDestination = process.env.LISTING_DESTINATION_WAREHOUSE_REVERB || "Warehouse Reverb";

  Airtable.configure({ apiKey });
  const base = Airtable.base(baseId);

  const formula = `AND(
    {${readyField}} = 1,
    {${destinationField}} = "${escapeFormulaString(warehouseDestination)}",
    {${reverbListingIdField}} = BLANK()
  )`;

  console.log("Airtable filter formula:", formula);

  const airtableRecords = await base(tableName)
    .select({
      filterByFormula: formula,
      pageSize: 100
    })
    .all();

  return airtableRecords.map((record) => {
    const fields = record.fields;

    const result = {
      recordId: record.id,

      sku: getField(fields, "SKU"),
      name: getField(fields, "Name"),
      generatedListingTitle: getField(fields, "Generated Listing Title"),
      listingDescriptionDraft: getField(fields, "Listing Description Draft"),

      price: getField(fields, "Price"),
      productType: getField(fields, "Product Type"),
      conditionRanking: getField(fields, "Condition Ranking"),
      shippingProfile: getField(fields, "Shipping Profile"),

      make: getField(fields, "Make"),
      model: getField(fields, "Model"),
      year: getField(fields, "Year"),
      color: getField(fields, "Color"),
      countryOfOrigin: getField(fields, "Country of Origin"),

      body: getField(fields, "Body"),
      neck: getField(fields, "Neck"),
      fretboard: getField(fields, "Fretboard"),
      pickups: getField(fields, "Pickups"),
      weight: getField(fields, "Weight"),
      case: getField(fields, "Case"),

      conditionNotes: getField(fields, "Condition Notes"),
      techNotes: getField(fields, "Tech Notes"),
      repairNotes: getField(fields, "Repair Notes"),
      testingNotes: getField(fields, "Testing Notes"),

      photos: getAttachmentUrls(fields, "Photos"),
      techPhotos: getAttachmentUrls(fields, "Tech Photos"),

      photosCount: getAttachmentUrls(fields, "Photos").length,
      techPhotosCount: getAttachmentUrls(fields, "Tech Photos").length
    };

    console.log("READY WAREHOUSE REVERB RECORD:");
    console.log(JSON.stringify({
      recordId: result.recordId,
      sku: result.sku,
      title: result.generatedListingTitle || result.name,
      price: result.price,
      conditionRanking: result.conditionRanking,
      shippingProfile: result.shippingProfile,
      descriptionLength: result.listingDescriptionDraft
        ? String(result.listingDescriptionDraft).length
        : 0,
      photosCount: result.photosCount,
      techPhotosCount: result.techPhotosCount
    }, null, 2));

    return result;
  });
}
