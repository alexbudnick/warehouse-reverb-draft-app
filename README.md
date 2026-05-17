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
