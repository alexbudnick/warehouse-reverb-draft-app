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

function getField(record, fieldName) {
  return record.get(fieldName);
}

export async function findReadyWarehouseReverbDrafts() {
  const apiKey = requiredEnv("AIRTABLE_PAT");
  const baseId = requiredEnv("AIRTABLE_BASE_ID");
  const tableName = requiredEnv("AIRTABLE_TABLE_NAME");

  const readyField = process.env.AIRTABLE_READY_FOR_DRAFT_FIELD || "Ready for Draft";
  const destinationField = process.env.AIRTABLE_LISTING_DESTINATION_FIELD || "Listing Destination";
  const reverbListingIdField = process.env.AIRTABLE_REVERB_LISTING_ID_FIELD || "Reverb Listing ID";
  const warehouseDestination = process.env.LISTING_DESTINATION_WAREHOUSE_REVERB || "Warehouse Reverb";

  const skuField = process.env.AIRTABLE_SKU_FIELD || "SKU";
  const priceField = process.env.AIRTABLE_PRICE_FIELD || "Price";
  const statusField = process.env.AIRTABLE_STATUS_FIELD || "Status";

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

  return airtableRecords.map((record) => ({
    recordId: record.id,
    sku: getField(record, skuField) || null,
    price: getField(record, priceField) || null,
    status: getField(record, statusField) || null
  }));
}
