# Warehouse Reverb Draft App

Fresh Railway app for the Flash Flood Warehouse Deals Reverb drafting workflow.

## Current Step

This first version only finds Airtable records where:

```txt
Ready for Draft = checked
AND Listing Destination = Warehouse Reverb
AND Reverb Listing ID is empty
```

It does **not** create Reverb drafts yet.

## Endpoints

### Health check

```txt
GET /
```

### Find eligible Warehouse Reverb draft records

```txt
GET /jobs/warehouse-reverb/ready-drafts?secret=YOUR_SECRET
```

Expected response:

```json
{
  "ok": true,
  "count": 1,
  "records": [
    {
      "recordId": "rec...",
      "sku": "A01012601",
      "price": 999,
      "status": "..."
    }
  ]
}
```

## Railway Start Command

```txt
npm start
```

## Next Step

After this successfully returns the correct Airtable records, add the Reverb draft creation function.


## Patch Notes

This version supports:
- Ready for Guitar Draft
- Ready for Gear Draft
- Final Listing Description

Old Ready for Draft remains supported as a fallback.


## Patch Notes 1.1.0

Adds:
- explicit Reverb photo update after draft creation using PUT /listings/[id]
- `photo_upload_method: override_position`
- treats Reverb duplicate-SKU response with returned listing object as an existing draft/recoverable success
- writes Reverb Listing ID / URL back to Airtable
- clears Ready for Draft, Ready for Guitar Draft, and Ready for Gear Draft after success

Optional Railway variable:
```env
AIRTABLE_REVERB_URL_FIELD=Reverb URL
```


## Patch Notes 1.2.0

Fixes:
- Adds real `DRY_RUN=true` support.
- No Reverb drafts are created when DRY_RUN=true.
- No Airtable writeback happens when DRY_RUN=true.
- Reverb photo updates now follow the API-provided `_links.update.href` / `_links.self.href` instead of constructing `/listings/[id]` manually.


## Patch Notes 1.3.0

Fixes:
- Uses Reverb's exact returned `_links.update.href` for photo updates.
- If photo update fails, the draft creation is still treated as success.
- Airtable writeback/checkbox clearing still happens even if photo upload fails.
- Response includes `photoUploadError` when photos need manual attention.


## Patch Notes 1.4.0

Fixes:
- After creating/recovering a draft, finds the Reverb listing by SKU using `/my/listings?sku=[sku]&state=all`.
- Uses the found listing ID for photo updates and Airtable writeback.
- This avoids sparse create responses where `_links.update` / `_links.self` are missing.
