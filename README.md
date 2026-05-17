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


## Minimal Description Routing Patch

This version intentionally preserves the original Reverb draft/photo behavior.

Only changes:
- Adds support for Ready for Guitar Draft
- Adds support for Ready for Gear Draft
- Uses Final Listing Description when available
- Falls back to Listing Description Draft

No photo upload logic was changed.
No checkbox-clearing logic was added.
No Reverb writeback behavior was added.
