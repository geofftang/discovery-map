# Discovery Map

An interactive map of curated places — restaurants, bakeries, coffee, shops, parks — built with MapLibre GL and served as a static site from GitHub Pages.

**🗺️ Live map: https://geofftang.github.io/discovery-map/**

## How it works

The data (`docs/discovery.geojson`) is a **public projection of a private dataset.** The source of truth is a personal knowledge-vault CSV that mixes public-safe fields (place name, category, city, notes) with private ones (internal vault links, pipeline/QA state) that must never be published.

```
private vault CSV  ──►  build-discovery-geojson.py  ──►  docs/discovery.geojson  ──►  MapLibre app
  (source of truth)      (public-egress projection)        (public artifact)        (this repo, Pages)
```

### Public-egress projection — why a leak can't happen by accident

The builder constructs each public record **field-by-field from a positive allowlist** (`PUBLIC_FIELDS`); it never takes the private record and strips sensitive fields out. The distinction is load-bearing: a denylist fails *open* the day a new sensitive column is added to the source, while an allowlist fails *closed* — a new column is excluded by construction. Two backstops reinforce it:

- **Fail-closed egress scan** — the build aborts if any forbidden pattern (vault deep-link, local path, email) appears anywhere in the output, including inside an allowed free-text field.
- **Unknown-column alert** — an unclassified source column is flagged so it gets a deliberate public/private decision instead of silent inclusion.

The unattended publisher runs an independent copy of the scan before every push.

## Files

- `docs/discovery.geojson` — generated public GeoJSON artifact (the only data the app reads)
- `src/main.js`, `src/styles.css` — MapLibre app
- `scripts/build-discovery-geojson.py` — the public-egress builder (the canonical pipeline lives in the private vault; this is the projection step)

## Develop

```bash
npm install
npm run dev      # serves on http://127.0.0.1:5173
```

## Rebuild the data (requires the private source CSV)

```bash
python3 scripts/build-discovery-geojson.py \
  --input /path/to/master-discovery.csv \
  --output docs/discovery.geojson
```

## Read the data directly

```text
https://raw.githubusercontent.com/geofftang/discovery-map/main/docs/discovery.geojson
```

## License

MIT — see [LICENSE](LICENSE).
