#!/usr/bin/env python3
"""Tests for build_places_index.py -- the record assertions, the private payload, and the public
egress projection ported from test_build_discovery_geojson.py (allowlist construction, closed-status
gating, hidden gating, reviews never published, leak scan, canary).

Run:  python3 scripts/test_build_places_index.py   (also works under pytest)
"""
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_places_index as b  # noqa: E402

REPO = Path(__file__).resolve().parents[1]

PRIVATE_VALUES = {
    "note": "[[katzs-delicatessen]]",
    "visit": "Dana thought the potato was too much; she would not come back.",
    "list": "owner-priority",
    "legacy_link": "obsidian://open?vault=life&file=notes/katz.md",
    "legacy_note": "checked by geoff@example.com",
}


def record(slug, **over):
    fm = {
        "id": over.pop("id", f"id-{slug}"), "name": over.pop("name", slug.title()),
        "locations": over.pop("locations", [{"coord": [40.722, -73.987]}]),
        "city": "NYC", "provider_ids": {"maps": over.pop("pid", "ChIJCar0f49ZwokR6ozLV-dHNTE")},
        "kind": over.pop("kind", ["meal", "bakery"]), "cuisine": over.pop("cuisine", ["jewish"]),
        "lists": [PRIVATE_VALUES["list"]], "tags": ["deli", "classic"], "signal": "High",
        "stage": "pinned", "status": over.pop("status", "open"), "hidden": over.pop("hidden", False),
        "note": PRIVATE_VALUES["note"],
        "legacy_import": {"Listing_Status": over.pop("listing", "verified"), "Sanity_Status": "",
                          "Obsidian Link": PRIVATE_VALUES["legacy_link"],
                          "Verification_Note": PRIVATE_VALUES["legacy_note"],
                          "Business_Status": over.pop("business", ""), "Rating": "4.6",
                          "Google_Details_Refreshed_At": "2026-08-01"},
    }
    fm.update(over)
    import yaml
    text = "---\n" + yaml.safe_dump(fm, sort_keys=False, allow_unicode=True) + "---\n\n## Why\n\nBest pastrami in the city.\n\n"
    text += "## Evidence\n\n- michelin · bib-gourmand — legacy tag `bib gourmand`\n\n"
    text += f"## Visits\n\n{PRIVATE_VALUES['visit']}\n\n## Log\n\n- 2026-09-04 legacy tag: walk-up\n"
    return text


class Tree:
    def __init__(self, records: dict[str, str]):
        self.root = Path(tempfile.mkdtemp())
        self.vault = self.root / "vault"
        places = self.vault / "domains" / "things-to-do" / "places"
        vocab = self.vault / "domains" / "things-to-do" / "vocab"
        places.mkdir(parents=True)
        vocab.mkdir()
        (vocab / "kind.txt").write_text("# kinds\nmeal\nbakery\ncafe\n")
        (vocab / "cuisine.txt").write_text("jewish\n")
        for slug, text in records.items():
            (places / f"{slug}.md").write_text(text)
        self.out = self.root / "out"
        self.out.mkdir()

    def build(self, public=True, seed=True):
        return b.build(self.vault, self.out, seed, public)

    def private(self):
        return json.loads((self.out / "private" / "private.json").read_text())

    def public(self):
        return json.loads((self.out / "public.json").read_text())

    def cleanup(self):
        shutil.rmtree(self.root)


def expect_block(tree, needle):
    try:
        tree.build()
    except b.BuildError as e:
        assert needle in str(e), f"blocked for the wrong reason: {e}"
        assert not (tree.out / "public.json").exists() and not (tree.out / "index.db").exists(), "blocked build wrote artifacts"
        return
    raise AssertionError(f"build should have been blocked: {needle}")


# --- record assertions -------------------------------------------------------------------------
def test_facet_outside_vocab_blocks_build():
    t = Tree({"katz": record("katz", kind=["meal", "spaceport"])})
    expect_block(t, "not in vocab")
    t.cleanup()


def test_merged_into_missing_target_blocks_build():
    t = Tree({"katz": record("katz", merged_into="id-nobody")})
    expect_block(t, "merged_into")
    t.cleanup()


def test_duplicate_id_blocks_build():
    t = Tree({"a": record("a", id="same"), "b": record("b", id="same")})
    expect_block(t, "duplicate id")
    t.cleanup()


def test_bad_status_blocks_build():
    t = Tree({"katz": record("katz", status="verified")})
    expect_block(t, "status")
    t.cleanup()


# --- private payload + index -------------------------------------------------------------------
def test_private_carries_owner_fields_and_index_answers_fts():
    t = Tree({"katz": record("katz"), "closed": record("closed", status="closed"), "hid": record("hid", hidden=True)})
    rep = t.build()
    feats = {f["properties"]["slug"]: f["properties"] for f in t.private()["features"]}
    assert set(feats) == {"katz", "closed", "hid"}, "the owner build renders every record; status/hidden govern display in the app"
    k = feats["katz"]
    assert k["my_take"] == PRIVATE_VALUES["visit"] and k["lists"] == ["owner-priority"] and k["note"] == "katzs-delicatessen"
    assert k["category"] == "Meal" and k["kind"] == ["meal", "bakery"] and k["evidence"][0].startswith("michelin")
    assert k["provider_rating"] == "4.6" and rep["signals_seeded"] == 3, "legacy provider facts seed the L1 cache"
    assert feats["closed"]["status"] == "closed" and feats["hid"]["hidden"] is True
    con = sqlite3.connect(t.out / "index.db")
    assert {r[0] for r in con.execute("SELECT name FROM place_fts WHERE place_fts MATCH 'pastrami'")} == {"Katz", "Closed", "Hid"}
    assert con.execute("SELECT count(*) FROM place WHERE status='open' AND hidden=0").fetchone()[0] == 1
    assert con.execute("SELECT kind FROM place_kind WHERE id='id-katz'").fetchall() == [("meal",), ("bakery",)]
    t.cleanup()


def test_private_json_never_under_docs():
    t = Tree({"katz": record("katz")})
    docs = t.root / "docs"
    docs.mkdir()
    try:
        b.build(t.vault, docs, False, False)
        raise AssertionError("private.json under docs/ must be refused")
    except b.BuildError as e:
        assert "docs/" in str(e)
    assert not (docs / "private").exists()
    assert not (REPO / "docs" / "private.json").exists() and not (REPO / "docs" / "private").exists(), "private payload sitting in the published dir"
    gi = (REPO / ".gitignore").read_text()
    for entry in ("private/", "dist-private/", "signals/", "index.db"):
        assert entry in gi, f".gitignore must list {entry}"
    t.cleanup()


# --- public projection (ported) ----------------------------------------------------------------
def test_public_emits_only_allowlisted_fields_in_declared_order():
    t = Tree({"katz": record("katz")})
    t.build()
    allow = b.load_allowlist(REPO / "public-allowlist.yml")["fields"]
    props = t.public()["features"][0]["properties"]
    assert set(props) <= set(allow), f"non-allowlisted keys leaked: {set(props) - set(allow)}"
    assert list(props) == [f for f in allow if f in props], "fields must come out in allowlist order (constructed, not copied)"
    assert props["kind"] == "meal" and props["why"] == "Best pastrami in the city." and props["tags"] == ["deli", "classic"]
    t.cleanup()


def test_private_values_never_appear_in_public():
    t = Tree({"katz": record("katz")})
    t.build()
    blob = json.dumps(t.public())
    for name, value in PRIVATE_VALUES.items():
        assert value not in blob, f"private value leaked into public.json: {name}={value!r}"
    for key in ("my_take", "visits", "lists", "note", "legacy_import", "evidence", "status", "hidden", "id", "slug", "_canary"):
        assert f'"{key}"' not in blob, f"private key leaked into public.json: {key}"
    assert b.CANARY not in blob
    t.cleanup()


def test_reviews_are_never_published():
    """## Visits must not reach the public artifact under any key (decision 2026-08-23)."""
    allow = b.load_allowlist(REPO / "public-allowlist.yml")["fields"]
    for forbidden in ("visits", "my_take", "review", "take"):
        assert forbidden not in allow, f"{forbidden} re-added to the allowlist; see decisions/2026-08-23-reviews-not-published.md"
    t = Tree({"katz": record("katz")})
    t.build()
    assert "she would not come back" not in json.dumps(t.public()).lower()
    t.cleanup()


def test_closed_and_hidden_records_are_not_published():
    t = Tree({"katz": record("katz"), "closed": record("closed", status="closed"), "hid": record("hid", hidden=True),
              "moved": record("moved", status="moved"), "optout": record("optout", share=False)})
    t.build()
    names = {f["properties"]["name"] for f in t.public()["features"]}
    assert names == {"Katz"}, names
    t.cleanup()


def test_google_permanent_closure_suppresses_public_but_never_private():
    t = Tree({"gone": record("gone", business="CLOSED_PERMANENTLY"), "reno": record("reno", business="CLOSED_LONG_TERM_RENOVATION"),
              "temp": record("temp", business="CLOSED_TEMPORARILY"), "ok": record("ok", business="OPERATIONAL")})
    t.build()
    pub = {f["properties"]["name"]: f["properties"] for f in t.public()["features"]}
    assert set(pub) == {"Temp", "Ok"}, pub.keys()
    assert pub["Temp"]["temporarily_closed"] is True and "temporarily_closed" not in pub["Ok"]
    priv = {f["properties"]["slug"]: f["properties"] for f in t.private()["features"]}
    assert set(priv) == {"gone", "reno", "temp", "ok"}, "a provider claim can never hide a pin on the owner build"
    assert priv["gone"]["provider_status"] == "CLOSED_PERMANENTLY" and priv["gone"]["status"] == "open"
    t.cleanup()


def test_place_id_is_status_gated():
    t = Tree({"ok": record("ok", listing="verified"), "amb": record("amb", listing="ambiguous_match", pid="ChIJamb"),
              "none": record("none", pid="")})
    t.build()
    pub = {f["properties"]["name"]: f["properties"] for f in t.public()["features"]}
    assert pub["Ok"]["google_place_id"] == "ChIJCar0f49ZwokR6ozLV-dHNTE"
    assert "google_place_id" not in pub["Amb"] and "google_place_id" not in pub["None"]
    t.cleanup()


def test_scan_catches_planted_leaks():
    for poisoned in ({"x": "obsidian://open?vault=life"}, {"x": "/Users/geoff/vault/note.md"},
                     {"x": "reach me at geoff@example.com"}, {"nested": {"deep": ["vault=life-design"]}},
                     {"x": "see [[katzs-delicatessen]]"}):
        assert b.scan_for_leaks(poisoned), f"scan failed to catch: {poisoned}"


def test_leak_in_public_text_blocks_build():
    t = Tree({"katz": record("katz", tags=["deli", "obsidian://open?vault=x"])})
    expect_block(t, "forbidden pattern")
    t.cleanup()


def test_unknown_allowlist_field_blocks_build():
    """A field declared on the allowlist with no projector source is a build error, not a silent gap."""
    t = Tree({"katz": record("katz")})
    orig = b.load_allowlist
    b.load_allowlist = lambda p: {"fields": ["name", "secret_field"]}
    try:
        expect_block(t, "no source")
    finally:
        b.load_allowlist = orig
        t.cleanup()


def test_history_from_git_lists_commits_and_field_changes():
    import subprocess
    t = Tree({"katz": record("katz")})
    env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@x", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@x", "PATH": "/usr/bin:/bin:/usr/local/bin"}
    g = lambda *a: subprocess.run(["git", *a], cwd=t.vault, check=True, capture_output=True, env=env)
    g("init", "-q"); g("add", "."); g("commit", "-q", "-m", "import")
    p = t.vault / "domains" / "things-to-do" / "places" / "katz.md"
    p.write_text(p.read_text().replace("status: open", "status: closed") + "- 2026-09-05 via map: set-status -> closed (mutation abc)\n")
    g("add", "."); g("commit", "-q", "-m", "map edit")
    rep = t.build()
    assert rep["history_files"] == 1
    h = json.loads((t.out / "private" / "history" / "katz.json").read_text())
    assert [e["subject"] for e in h["entries"]] == ["map edit", "import"]
    assert h["entries"][0]["changed"] == [{"field": "status", "before": "open", "after": "closed"}]
    assert h["entries"][0]["log_added"] == ["2026-09-05 via map: set-status -> closed (mutation abc)"]
    assert h["entries"][1]["changed"][0]["after"] == "created" and h["uncommitted"] is False
    assert "legacy_import" not in json.dumps(h)
    t.cleanup()


def test_history_skipped_outside_git():
    t = Tree({"katz": record("katz")})
    rep = t.build()
    assert rep["history_files"] == 0 and not (t.out / "private" / "history").exists()
    t.cleanup()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in tests:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(tests)} passed")
