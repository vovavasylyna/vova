# tree.vasylyna.net

A static family tree viewer. No build step: `index.html`, `app.js`, `style.css`
and `data.json` are served as they are, from the `tree` Vercel project.

## Updating the tree

1. Export both trees from MyHeritage as GEDCOM (Family tree → Manage trees →
   Export to GEDCOM): Volodymyr's tree and Anastasiia's (her side of the family).
2. Convert them, with Volodymyr's tree first:

   ```bash
   node tree/scripts/import-gedcom.mjs ~/Downloads/vova.ged --merge ~/Downloads/nastia.ged
   ```

   The script matches people found in both trees (by name and birth year, then
   by their place in the family), fills in names the main tree is missing, adds
   everyone else, and prints every match and conflict. On a conflict the more
   precise date wins; on a tie, the merged tree wins.
3. Commit `tree/data.json` and push to `main`.

Fixes that aren't in MyHeritage yet live in `tree/corrections.json`: pairs of
duplicates to fold into one person (`keep` takes over everything `drop` had)
and people to remove. They are applied on every import; once a fix is also
made in MyHeritage, the entry is skipped and can be deleted. People from a
merged tree get the prefix `A` (Anastasiia's `I500016` becomes `A500016`).

Never commit the `.ged` files — this repository is public and the exports have
full birth dates of living relatives (and Anastasiia's has her email). The
importer keeps only the birth year, and drops places and marriage details,
for anyone who may still be alive: not marked as dead and born in the last
100 years or with no birth date. Pass `--full-dates` to keep everything.

## Local preview

```bash
cd tree && python3 -m http.server 8000
```

Open http://localhost:8000. People are addressed by their GEDCOM id, e.g. `#I2`.
