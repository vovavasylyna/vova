# tree.vasylyna.net

A static family tree viewer. No build step: `index.html`, `app.js`, `style.css`
and `data.json` are served as they are, from the `tree` Vercel project.

## Updating the tree

1. Export the tree from MyHeritage as GEDCOM (Family tree → Manage trees → Export to GEDCOM).
2. Convert it:

   ```bash
   node tree/scripts/import-gedcom.mjs ~/Downloads/export.ged
   ```

3. Commit `tree/data.json` and deploy.

Never commit the `.ged` file itself — this repository is public and the export
has full birth dates of living relatives. The importer keeps only the birth
year (and drops the place) for anyone born in the last 100 years; pass
`--full-dates` to keep everything.

## Local preview

```bash
cd tree && python3 -m http.server 8000
```

Open http://localhost:8000. People are addressed by their GEDCOM id, e.g. `#I2`.
