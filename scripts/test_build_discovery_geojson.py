#!/usr/bin/env python3
"""Tests for the public-egress projection in build-discovery-geojson.py.

These assert the load-bearing security property the README claims: the public
artifact is a POSITIVE ALLOWLIST projection, and a forbidden pattern fails the
build closed. Zero dependencies.

Run:  python3 scripts/test_build_discovery_geojson.py   (also works under pytest)
"""
import importlib.util
from pathlib import Path

# The builder filename has hyphens, so load it by path rather than import.
_spec = importlib.util.spec_from_file_location(
    "build_discovery_geojson",
    Path(__file__).with_name("build-discovery-geojson.py"),
)
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)


# A source row carrying BOTH public-safe and private columns. The private ones
# must never reach the public feature.
PRIVATE_COLUMNS = {
    "Obsidian Link": "obsidian://open?vault=life&file=places/katz",
    "Sanity_Status": "VERIFIED",
    "Listing_Status": "verified",
    "Verification_Note": "checked by geoff@example.com",
    "Flags": "internal-only",
}
SOURCE_ROW = {
    "Name": "Katz's Delicatessen",
    "Category": "Meal",
    "Signal": "High",
    "Description": "Best pastrami in the city.",
    "Secondary Tags": "deli;classic",
    "City": "NYC",
    "Latitude": "40.722",
    "Longitude": "-73.987",
    "Google_Place_ID": "ChIJCar0f49ZwokR6ozLV-dHNTE",
    **PRIVATE_COLUMNS,
}


def test_feature_emits_only_allowlisted_properties():
    props = build.build_feature(SOURCE_ROW)["properties"]
    allowed = set(build.PUBLIC_FIELDS) | {"google_place_id"}
    leaked = set(props) - allowed
    assert not leaked, f"non-allowlisted keys leaked: {leaked}"


def test_private_columns_never_appear():
    feature = build.build_feature(SOURCE_ROW)
    blob = repr(feature)
    for value in PRIVATE_COLUMNS.values():
        assert value not in blob, f"private value leaked into output: {value!r}"
    for col in ("Obsidian Link", "Listing_Status", "Sanity_Status", "Flags"):
        assert col not in feature["properties"], f"private column became a property: {col}"


def test_place_id_is_status_gated():
    # Trusted listing status -> emitted.
    assert build.trusted_place_id(SOURCE_ROW) == "ChIJCar0f49ZwokR6ozLV-dHNTE"
    # Untrusted listing status -> withheld.
    untrusted = {**SOURCE_ROW, "Listing_Status": "ambiguous", "Sanity_Status": ""}
    assert build.trusted_place_id(untrusted) is None
    # No place id at all -> None.
    assert build.trusted_place_id({**SOURCE_ROW, "Google_Place_ID": ""}) is None


def test_scan_catches_planted_leaks():
    for poisoned in (
        {"x": "obsidian://open?vault=life"},
        {"x": "/Users/geoff/vault/note.md"},
        {"x": "reach me at geoff@example.com"},
        {"nested": {"deep": ["vault=life-design"]}},
    ):
        assert build.scan_for_leaks(poisoned), f"scan failed to catch: {poisoned}"


def test_scan_passes_clean_payload():
    clean = build.build_feature(SOURCE_ROW)
    payload = {"type": "FeatureCollection", "features": [clean]}
    assert build.scan_for_leaks(payload) == []


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")
