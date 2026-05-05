# Discovery Map

Public map app and generated data feed for the Executive Function discovery database.

The private source of truth is not stored in this repo. Generate `docs/discovery.geojson` from the private vault CSV, commit the artifact here, and deploy the static MapLibre app from this repo.

## Files

- `docs/discovery.geojson` - generated public GeoJSON artifact, copied into the app build
- `src/` - MapLibre app source
- `scripts/build-discovery-geojson.py` - local builder for converting the private CSV to GeoJSON

## Build

From this repo:

```bash
python3 scripts/build-discovery-geojson.py \
  --input "$HOME/Library/Application Support/executive-function/system/discovery/master-discovery.csv" \
  --output docs/discovery.geojson
```

## App

```bash
npm install
npm run dev
```

## Public Data URL

External consumers can read the GeoJSON from:

```text
https://raw.githubusercontent.com/geofftang/discovery-map/main/docs/discovery.geojson
```
