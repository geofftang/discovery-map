#!/usr/bin/env python3
"""Tests for the public-egress projection in build-discovery-geojson.py.

These assert the load-bearing security property the README claims: the public
artifact is a POSITIVE ALLOWLIST projection, and a forbidden pattern fails the
build closed. Zero dependencies.

This file is kept byte-identical in the vault (`system/scripts/`) and in the
public repo (`~/code/discovery-map/scripts/`). It loads the builder sitting
NEXT TO IT, so each copy tests its own local builder — which is what makes a
forked/drifted builder fail its own tests instead of silently regenerating a
bad feed. If you edit one copy, copy it to the other.

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
    allowed = set(build.PUBLIC_FIELDS) | {"google_place_id", "temporarily_closed"}
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


# --- Closure suppression ---------------------------------------------------
# A closed venue must never render as a live recommendation. There are TWO
# independent closure signals and nothing propagates between them:
#   Listing_Status == "closed"      -- hand-maintained  (2026-08-03 fix)
#   Business_Status  CLOSED_*       -- what Google says (2026-08-11 fix)
# Both were regressions that shipped to the public map. These tests are the
# tripwire: a builder missing either filter fails here instead of silently
# republishing closed venues.


def test_listing_status_closed_is_suppressed():
    assert build.build_feature({**SOURCE_ROW, "Listing_Status": "closed"}) is None


def test_google_confirmed_closed_is_suppressed():
    # Listing_Status still says `verified` -- exactly the live 2026-08-11 state,
    # where 18 Google-confirmed-closed venues published as live recommendations.
    for status in ("CLOSED_PERMANENTLY", "CLOSED_LONG_TERM_RENOVATION"):
        row = {**SOURCE_ROW, "Listing_Status": "verified", "Business_Status": status}
        assert build.build_feature(row) is None, f"{status} must not publish"


def test_temporarily_closed_publishes_with_a_flag():
    """Temporary closure must NOT suppress -- it is a different fact from permanent.

    This map is a catalogue of places worth going, not an is-it-open-now service.
    Shipped 2026-08-11 suppressing both; corrected 2026-08-12. The failure this
    guards is seasonal: ~507 rows are Italian and Italian venues close en masse
    for August ferie, so suppressing temporary closures silently removes a sixth
    of the dataset for a few weeks a year.
    """
    row = {**SOURCE_ROW, "Listing_Status": "verified", "Business_Status": "CLOSED_TEMPORARILY"}
    feature = build.build_feature(row)
    assert feature is not None, "CLOSED_TEMPORARILY must still publish"
    assert feature["properties"].get("temporarily_closed") is True


def test_open_venues_carry_no_closure_flag():
    for status in ("OPERATIONAL", "", None):
        row = {**SOURCE_ROW, "Business_Status": status}
        feature = build.build_feature(row)
        assert feature is not None, f"Business_Status={status!r} must publish"
        assert "temporarily_closed" not in feature["properties"]


def test_visibility_hide_suppresses():
    """The single-purpose, human-only publish gate.

    Distinct from every other filter here: those answer "what is true about this
    place", this answers "do I want it on my map". An operational, open,
    correctly-identified venue must still be hideable.
    """
    row = {**SOURCE_ROW, "Listing_Status": "verified", "Business_Status": "OPERATIONAL",
           "Visibility": "hide"}
    assert build.build_feature(row) is None
    # Case-insensitive, and blank/absent/show all publish.
    assert build.build_feature({**SOURCE_ROW, "Visibility": "HIDE"}) is None
    for value in ("show", "", None):
        assert build.build_feature({**SOURCE_ROW, "Visibility": value}) is not None


def test_visibility_is_never_published():
    """Visibility gates the feed; it must not itself appear in the feed."""
    feature = build.build_feature({**SOURCE_ROW, "Visibility": "show"})
    assert "visibility" not in feature["properties"]
    assert "Visibility" not in feature["properties"]


def test_my_take_publishes_separately_from_description():
    """My_Take is its own public field, not appended into description.

    The whole point is that the app can render the user's own verdict as a
    distinct block from third-party sourced notes. Merging them into one string
    would recreate the mixed-purpose field this exists to avoid.
    """
    row = {**SOURCE_ROW, "My_Take": "Order the cumin flounder; skip the pumpkin."}
    props = build.build_feature(row)["properties"]
    assert props["my_take"] == "Order the cumin flounder; skip the pumpkin."
    assert props["description"] == SOURCE_ROW["Description"]
    assert "cumin flounder" not in props["description"]


def test_my_take_absent_when_empty():
    for value in ("", "   ", None):
        props = build.build_feature({**SOURCE_ROW, "My_Take": value})["properties"]
        assert "my_take" not in props


def test_closure_check_is_not_substring_matched():
    # Guard the prefix match: a value merely CONTAINING "closed" is not a closure
    # signal, and a lowercase/mixed-case CLOSED_* still is.
    assert build.build_feature({**SOURCE_ROW, "Business_Status": "closed_permanently"}) is None
    assert build.build_feature({**SOURCE_ROW, "Business_Status": "NOT_CLOSED"}) is not None
    # Case-insensitive on the temporary branch too, or a lowercase value would
    # fall through the `!= "CLOSED_TEMPORARILY"` check and be suppressed as permanent.
    lower = build.build_feature({**SOURCE_ROW, "Business_Status": "closed_temporarily"})
    assert lower is not None and lower["properties"].get("temporarily_closed") is True


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"\n{len(tests)} passed")
