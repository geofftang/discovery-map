# Discovery Map

Public map data and lightweight hosting surface for the Executive Function discovery database.

The private source of truth is not stored in this repo. Generate `docs/discovery.geojson` from the private vault CSV, commit the artifact here, and point map consumers such as uMap at the published raw file or GitHub Pages URL.

## Files

- `docs/discovery.geojson` - generated public GeoJSON artifact
- `docs/index.html` - small static index for GitHub Pages
- `scripts/build-discovery-geojson.py` - local builder for converting the private CSV to GeoJSON

## Build

From this repo:

```bash
python3 scripts/build-discovery-geojson.py \
  --input "$HOME/Library/Application Support/executive-function/system/discovery/master-discovery.csv" \
  --output docs/discovery.geojson
```

## Public URL

After pushing to GitHub, uMap can read the GeoJSON from:

```text
https://raw.githubusercontent.com/geofftang/discovery-map/main/docs/discovery.geojson
```
