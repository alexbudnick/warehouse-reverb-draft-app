import Airtable from "airtable";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function escapeFormulaString(value) {
  return String(value || "").replace(/"/g, '\\"');
}

function getField(fields, name, fallback = null) {
  if (!name) return fallback;
  const value = fields[name];
  return value === undefined || value === null ? fallback : value;
}

function getAttachmentObjects(fields, name) {
  const attachments = fields[name];
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((attachment) => attachment?.url)
    .map((attachment) => ({
      url: attachment.url,
      filename: attachment.filename || "photo.jpg",
      type: attachment.type || null,
      size: attachment.size || null
    }));
}

function getAttachmentUrls(fields, name) {
  return getAttachmentObjects(fields, name).map((attachment) => attachment.url);
}

export async function findReadyWarehouseReverbDrafts() {
  const apiKey = requiredEnv("AIRTABLE_PAT");
  const baseId = requiredEnv("AIRTABLE_BASE_ID");
  const tableName = requiredEnv("AIRTABLE_TABLE_NAME");

  const readyField = process.env.AIRTABLE_READY_FOR_DRAFT_FIELD || "Ready for Draft Push";
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

  const airtableRecords = await base(tableName).select({
    filterByFormula: formula,
    pageSize: 100
  }).all();

  return airtableRecords.map((record) => {
    const fields = record.fields;
    const photoAttachments = getAttachmentObjects(fields, process.env.AIRTABLE_PHOTOS_FIELD || "Photos");
    const techPhotoAttachments = getAttachmentObjects(fields, process.env.AIRTABLE_TECH_PHOTOS_FIELD || "Tech Photos");

    const result = {
      recordId: record.id,
      sku: getField(fields, process.env.AIRTABLE_SKU_FIELD || "SKU"),
      name: getField(fields, process.env.AIRTABLE_NAME_FIELD || "Name"),
      generatedListingTitle: getField(fields, process.env.AIRTABLE_TITLE_FIELD || "Generated Listing Title"),
      listingDescriptionDraft:
        getField(fields, process.env.AIRTABLE_DESCRIPTION_FIELD || "Final Listing Description") ||
        getField(fields, "Final Listing Description") ||
        getField(fields, "Listing Description Draft"),
      price: getField(fields, process.env.AIRTABLE_PRICE_FIELD || "Price"),
      cost: getField(fields, process.env.AIRTABLE_COST_FIELD || "Cost"),
      productType: getField(fields, process.env.AIRTABLE_PRODUCT_CATEGORY_FIELD || "Product Type"),
      reverbCategoryUuid: getField(fields, process.env.AIRTABLE_REVERB_CATEGORY_UUID_FIELD || "Reverb Category UUID"),
      conditionRanking: getField(fields, process.env.AIRTABLE_CONDITION_RANKING_FIELD || "Condition Ranking"),
      shippingProfile: getField(fields, process.env.AIRTABLE_SHIPPING_PROFILE_FIELD || "Shipping Profile"),
      reverbShippingProfileId: getField(fields, process.env.AIRTABLE_REVERB_SHIPPING_PROFILE_ID_FIELD || "Reverb Shipping Profile ID"),
      make: getField(fields, process.env.AIRTABLE_MAKE_FIELD || "Make"),
      model: getField(fields, process.env.AIRTABLE_MODEL_FIELD || "Model"),
      year: getField(fields, process.env.AIRTABLE_YEAR_FIELD || "Year"),
      color: getField(fields, process.env.AIRTABLE_FINISH_FIELD || "Color"),
      countryOfOrigin: getField(fields, process.env.AIRTABLE_COUNTRY_FIELD || "Country of Origin"),
      conditionNotes: getField(fields, process.env.AIRTABLE_CONDITION_NOTES_FIELD || "Condition Notes"),
      photoAttachments,
      techPhotoAttachments,
      photos: getAttachmentUrls(fields, process.env.AIRTABLE_PHOTOS_FIELD || "Photos"),
      techPhotos: getAttachmentUrls(fields, process.env.AIRTABLE_TECH_PHOTOS_FIELD || "Tech Photos"),
      photosCount: photoAttachments.length,
      techPhotosCount: techPhotoAttachments.length
    };

    console.log("READY WAREHOUSE REVERB RECORD:");
    console.log(JSON.stringify({
      recordId: result.recordId,
      sku: result.sku,
      title: result.generatedListingTitle || result.name,
      price: result.price,
      cost: result.cost,
      productType: result.productType,
      reverbCategoryUuid: result.reverbCategoryUuid,
      conditionRanking: result.conditionRanking,
      shippingProfile: result.shippingProfile,
      reverbShippingProfileId: result.reverbShippingProfileId,
      descriptionLength: result.listingDescriptionDraft ? String(result.listingDescriptionDraft).length : 0,
      photosCount: result.photosCount,
      techPhotosCount: result.techPhotosCount
    }, null, 2));

    return result;
  });
}
