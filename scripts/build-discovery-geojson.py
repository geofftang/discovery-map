#!/usr/bin/env python3
"""Build the PUBLIC discovery-map GeoJSON from the private master-discovery CSV.

Egress boundary — see `system/data-engineering-patterns.md` §F "Public-egress
projection". The public artifact is a POSITIVE ALLOWLIST projection: every public
field is constructed explicitly from PUBLIC_FIELDS, never the private row with
sensitive fields removed. A new column in the source CSV is therefore excluded by
construction (fail-safe default). A fail-closed egress scan is the secondary backstop.
"""
import argparse
import csv
import json
import re
import sys
from pathlib import Path


# --- Egress contract -------------------------------------------------------
# Public field -> source CSV column. Positive allowlist: ONLY these reach the
# public artifact. Anything not listed is excluded by construction.
# `google_place_id` is derived via trusted_place_id() (status-gated), not copied.
PUBLIC_FIELDS = {
    "name": "Name",
    "category": "Category",
    "signal": "Signal",
    "description": "Description",
    "secondary_tags": "Secondary Tags",
    "city": "City",
}

# Every source column we have classified. A column NOT here is unclassified:
# it is already excluded (only PUBLIC_FIELDS project), and we warn so a newly
# added column gets a deliberate public/private decision instead of silence.
KNOWN_COLUMNS = {
    "Name", "Category", "Signal", "Description", "Obsidian Link", "Latitude",
    "Longitude", "Secondary Tags", "City", "Country", "Google_Place_ID", "Rating",
    "Hours_Summary", "Last_Updated_At", "Sanity_Status", "Listing_Status",
    "Listing_Verified_At", "Google_Details_Refreshed_At", "Verification_Note",
    "Other_Branches", "Flags", "Business_Status", "Review_Count", "Hours_Weekly",
}

# Patterns that must NEVER appear in the public artifact. Fail closed if seen.
FORBIDDEN_PATTERNS = [
    re.compile(r"obsidian://", re.I),
    re.compile(r"vault=", re.I),
    re.compile(r"/Users/"),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),  # email address
]


def scan_for_leaks(payload):
    """Walk every string in the output; return [(json_path, pattern, sample)] of forbidden hits."""
    hits = []

    def walk(node, path):
        if isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{path}[{i}]")
        elif isinstance(node, str):
            for pat in FORBIDDEN_PATTERNS:
                if pat.search(node):
                    hits.append((path, pat.pattern, node[:80]))

    walk(payload, "$")
    return hits


def parse_args():
    parser = argparse.ArgumentParser(description="Build GeoJSON from the discovery CSV.")
    parser.add_argument(
        "--input",
        default="system/discovery/master-discovery.csv",
        help="Path to the discovery CSV",
    )
    parser.add_argument(
        "--output",
        default=str(Path.home() / "code" / "discovery-map" / "docs" / "discovery.geojson"),
        help="Path to write the GeoJSON output",
    )
    return parser.parse_args()


def clean_value(value):
    if value is None:
        return None
    value = str(value).strip()
    return value if value else None


TRUSTED_PLACE_ID_STATUSES = {"verified", "closed"}


def trusted_place_id(row):
    place_id = clean_value(row.get("Google_Place_ID"))
    if not place_id:
        return None

    listing_status = clean_value(row.get("Listing_Status"))
    sanity_status = clean_value(row.get("Sanity_Status"))
    if listing_status in TRUSTED_PLACE_ID_STATUSES:
        return place_id
    if not listing_status and sanity_status == "VERIFIED":
        return place_id
    return None


def build_feature(row):
    lat = clean_value(row.get("Latitude"))
    lon = clean_value(row.get("Longitude"))
    if not lat or not lon:
        return None

    # A closed venue must not render as a live recommendation. Caught 2026-08-03:
    # Listing_Status=closed was tracked internally but nothing ever excluded these
    # rows from the public feed -- ~150 existing closed rows (plus Danieli Bistro,
    # closed 3+ years, reopening under different management) rendered identically
    # to open ones. Filter at the source, not with app-side styling.
    if clean_value(row.get("Listing_Status")) == "closed":
        return None

    # Second closure signal, independent of the first. Business_Status is what Google
    # reports (daemon-maintained); Listing_Status is hand-maintained and nothing
    # propagates between them, so a venue Google calls CLOSED_PERMANENTLY still read
    # `verified` and published. Caught 2026-08-11: 18 confirmed-closed venues live on
    # the map. The STATUS_CHANGED alarm only fires on a *change* from a non-empty
    # prior value, so a first-ever population never trips it -- these were structurally
    # undetectable. Prefix match covers CLOSED_PERMANENTLY / CLOSED_TEMPORARILY /
    # CLOSED_LONG_TERM_RENOVATION. Temporary closures suppress too: a closed door is a
    # closed door, and the pin returns on its own when Google says OPERATIONAL again.
    business_status = clean_value(row.get("Business_Status"))
    if business_status and business_status.upper().startswith("CLOSED"):
        return None

    # Positive allowlist projection: build ONLY declared public fields.
    # Sensitive/internal columns (Obsidian Link, Listing_Status, Sanity_Status,
    # Verification_Note, Flags, ...) are excluded by construction — never copied.
    properties = {}
    for public_key, source_col in PUBLIC_FIELDS.items():
        value = clean_value(row.get(source_col))
        if value is not None:
            properties[public_key] = value

    place_id = trusted_place_id(row)  # status-gated; reads Listing/Sanity but does not emit them
    if place_id is not None:
        properties["google_place_id"] = place_id

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
        unclassified = sorted(set(reader.fieldnames or []) - KNOWN_COLUMNS)
        if unclassified:
            print(
                f"WARNING: unclassified source column(s) {unclassified} — excluded from the "
                f"public artifact by default. Classify them in PUBLIC_FIELDS/KNOWN_COLUMNS.",
                file=sys.stderr,
            )
        for row in reader:
            feature = build_feature(row)
            if feature:
                features.append(feature)

    payload = {
        "type": "FeatureCollection",
        "name": "discovery-map",
        "features": features,
    }

    # Fail-closed egress backstop: never write a public artifact that contains a
    # forbidden pattern (vault deep-link, local path, email). The allowlist above
    # is the boundary; this is the secondary check (§F).
    leaks = scan_for_leaks(payload)
    if leaks:
        print(
            f"REFUSING TO WRITE: {len(leaks)} forbidden pattern(s) in the output (egress leak).",
            file=sys.stderr,
        )
        for path, pattern, sample in leaks[:10]:
            print(f"  {path}  ~/{pattern}/  ::  {sample!r}", file=sys.stderr)
        sys.exit(1)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(features)} features to {output_path}")


if __name__ == "__main__":
    main()
