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

    console.log("READY WAREHOUSE REVERB RECORD:");
    console.log(JSON.stringify({
      recordId: record.id,
      sku: fields["SKU"],
      name: fields["Name"],
      generatedListingTitle: fields["Generated Listing Title"],
      listingDescriptionDraft: fields["Listing Description Draft"],
      productType: fields["Product Type"],
      conditionRanking: fields["Condition Ranking"],
      price: fields["Price"],
      make: fields["Make"],
      model: fields["Model"],
      year: fields["Year"],
      color: fields["Color"],
      countryOfOrigin: fields["Country of Origin"],
      shippingProfile: fields["Shipping Profile"],
      weight: fields["Weight"],
      photosCount: Array.isArray(fields["Photos"]) ? fields["Photos"].length : 0,
      techPhotosCount: Array.isArray(fields["Tech Photos"]) ? fields["Tech Photos"].length : 0
    }, null, 2));

    return {
      recordId: record.id,
      sku: fields["SKU"] || null,
      name: fields["Name"] || null,
      generatedListingTitle: fields["Generated Listing Title"] || null,
      productType: fields["Product Type"] || null,
      conditionRanking: fields["Condition Ranking"] || null,
      price: fields["Price"] || null,
      make: fields["Make"] || null,
      model: fields["Model"] || null,
      year: fields["Year"] || null,
      color: fields["Color"] || null,
      countryOfOrigin: fields["Country of Origin"] || null,
      shippingProfile: fields["Shipping Profile"] || null,
      weight: fields["Weight"] || null,
      photosCount: Array.isArray(fields["Photos"]) ? fields["Photos"].length : 0,
      techPhotosCount: Array.isArray(fields["Tech Photos"]) ? fields["Tech Photos"].length : 0
    };
  });
}
