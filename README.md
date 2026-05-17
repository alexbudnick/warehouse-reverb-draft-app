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
