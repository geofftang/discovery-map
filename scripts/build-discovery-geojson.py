#!/usr/bin/env python3
import argparse
import csv
import json
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Build GeoJSON from the discovery CSV.")
    parser.add_argument(
        "--input",
        default="system/discovery/master-discovery.csv",
        help="Path to the discovery CSV",
    )
    parser.add_argument(
        "--output",
        default="docs/discovery.geojson",
        help="Path to write the GeoJSON output",
    )
    return parser.parse_args()


def clean_value(value):
    if value is None:
        return None
    value = str(value).strip()
    return value if value else None


def build_feature(row):
    lat = clean_value(row.get("Latitude"))
    lon = clean_value(row.get("Longitude"))
    if not lat or not lon:
        return None

    properties = {
        "name": clean_value(row.get("Name")),
        "category": clean_value(row.get("Category")),
        "signal": clean_value(row.get("Signal")),
        "description": clean_value(row.get("Description")),
        "obsidian_link": clean_value(row.get("Obsidian Link")),
        "secondary_tags": clean_value(row.get("Secondary Tags")),
        "city": clean_value(row.get("City")),
        "google_place_id": clean_value(row.get("Google_Place_ID")),
        "rating": clean_value(row.get("Rating")),
        "hours_summary": clean_value(row.get("Hours_Summary")),
        "sanity_status": clean_value(row.get("Sanity_Status")),
    }

    # Drop null properties to keep the file compact and easier to inspect.
    properties = {k: v for k, v in properties.items() if v is not None}

    return {
        "type": "Feature",
        "properties": properties,
        "geometry": {
            "type": "Point",
            "coordinates": [float(lon), float(lat)],
        },
    }


def main():
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    features = []
    with input_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            feature = build_feature(row)
            if feature:
                features.append(feature)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "type": "FeatureCollection",
        "name": "discovery-map",
        "features": features,
    }

    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(features)} features to {output_path}")


if __name__ == "__main__":
    main()
