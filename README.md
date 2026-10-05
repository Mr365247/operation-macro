# Operation Macro

Personal macro tracker PWA. Plain HTML/CSS/JS, no build step, no backend.
All data is stored on the device in localStorage (use Settings → Export backup now and then).

## Run locally
    cd operation-macro
    python3 -m http.server 8000
    # open http://localhost:8000

## Put it on your phone
Service workers and "Add to Home Screen" need HTTPS, so host the folder on any free static host:
- Netlify Drop: https://app.netlify.com/drop, then drag this folder onto the page.
- GitHub Pages: push the folder to a repo, then Settings → Pages → deploy from branch.

Then open the URL on your phone:
- iPhone (Safari): Share → Add to Home Screen.
- Android (Chrome): ⋮ menu → Add to Home screen / Install app.

## Updating
After changing any file, bump `VERSION` in `sw.js` so installed copies refresh.
`node make-icons.js` regenerates the icons.

## Barcode scanning
Scanning uses the phone camera and looks products up in Open Food Facts
(https://world.openfoodfacts.org), a free public database. Anything you scan or
type in from a label is saved on the phone, so repeat scans work offline.
The barcode reader is bundled in `vendor/` (barcode-detector + zxing-wasm, MIT).

## Cafeteria menu library
`.github/workflows/cafeteria.yml` runs `scripts/update-cafeteria.mjs` every Sunday (or via
Actions → Update cafeteria menu → Run workflow). It pulls North Providence High School's
breakfast and lunch menus with nutrition from Nutrislice and merges them into
`cafeteria.json`. The Log food form autocompletes from favorites, saved barcodes and this library.

## Restaurant library
`.github/workflows/restaurants.yml` runs `scripts/update-restaurants.mjs` every Sunday (or via
Actions → Update restaurant nutrition → Run workflow). It pulls official nutrition info into
`restaurants.json` for Chick-fil-A, Dunkin', McDonald's, Subway and Wendy's (Wendy's carbs are
estimated from calories, protein and fat). Each chain keeps its last good data if its source fails;
`restaurants.json` → `status` shows how the last run went.

## Photo estimates
Log food → 📸 Photo sends a downscaled photo (plus an optional note) to Claude using the
official Anthropic SDK, bundled at `vendor/anthropic-sdk.js` (see `vendor/anthropic-sdk.version`).
Each person pastes their own Anthropic API key in Settings; it is kept in its own localStorage
slot on the phone, never committed and never included in backups. Results fill the form for review.
