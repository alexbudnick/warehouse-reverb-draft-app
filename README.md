# Warehouse Reverb Draft App

Clean version focused on working photo creation.

Key behavior:
- Finds ready Airtable records using Ready for Draft OR Ready for Guitar Draft OR Ready for Gear Draft.
- Uses Final Listing Description when available; falls back to Listing Description Draft.
- Creates Reverb drafts using `photos` in the original create payload, per Reverb docs.
- Does not clear ready checkboxes.
- Does not write back Reverb fields.
- Does not do a separate photo update step.
- Proxies Airtable attachments through simple public Railway URLs so Reverb sees normal image URLs.

Required Railway variable for photos:

```
PUBLIC_BASE_URL=https://warehouse-reverb-draft-app-production.up.railway.app
```

Test with:

```
DRY_RUN=true
```

Then run:

```
/jobs/warehouse-reverb/create-drafts?secret=YOUR_SECRET
```


## 2.1.0 Static Image Files

Focused photo fix:
- Downloads Airtable attachment files before creating the Reverb draft.
- Serves them from Railway as normal static-looking image files:
  `/reverb-static/[run]/photo.jpg`
- Adds explicit GET and HEAD support.
- Sends those static URLs in the initial Reverb create payload.
- Does not clear ready checkboxes.
- Does not add writeback logic.

## 2.2.1 Continue On Error Fixed

Focused fix:
- Adds the missing `duplicateSkuResult()` helper.
- Keeps the working static-image upload behavior.
- Keeps one-record failure from stopping the whole batch.
