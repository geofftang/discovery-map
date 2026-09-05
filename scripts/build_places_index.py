#!/usr/bin/env python3
"""Build the derived index and the map payloads from per-place records (council step 4).

    parse L0 (places/*.md) -> join L1 (signals/<id>.json) -> emit
        index.db       SQLite + FTS5 + coordinate index   derived, disposable
        private.json   full payload for the OWNER build   never under docs/
        public.json    CONSTRUCTED field-by-field from public-allowlist.yml (step 5 deploys it)

Deploy-blocking assertions (any failure = nothing written):
  every kind/cuisine value is in vocab/; every merged_into target exists; ids unique;
  status in {open, closed, moved}; coordinates in range; every file parses.
Public build additionally: emitted field set == declared allowlist; a private-field canary is
absent; the egress scan finds no forbidden pattern.

Egress boundary -- see the vault's data-engineering patterns §F "Public-egress projection".
The public artifact is a POSITIVE ALLOWLIST projection; a new record field is excluded by
construction. Reviews (## Visits) are never published (decision 2026-08-23).

Usage:
  python3 scripts/build_places_index.py --vault "<vault root>" [--out .] [--seed-signals-from-legacy] [--public]
"""
from __future__ import annotations
import argparse, json, os, re, sqlite3, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
import yaml

REPO = Path(__file__).resolve().parents[1]
DEFAULT_VAULT = Path.home() / "Library" / "Application Support" / "executive-function-test"
STATUS_OK = {"open", "closed", "moved"}
APP_CATEGORY = {"meal": "Meal", "cafe": "Cafe", "dessert": "Dessert", "drinks": "Drinks", "activities": "Activities"}
SECTIONS = ("Why", "Evidence", "Visits", "Log")

# Patterns that must NEVER appear in the public artifact. Fail closed if seen.
FORBIDDEN_PATTERNS = [
    re.compile(r"obsidian://", re.I),
    re.compile(r"vault=", re.I),
    re.compile(r"/Users/"),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),  # email address
    re.compile(r"\[\[[^\]]+\]\]"),  # wikilink into the vault
]
# Planted in a private field of every private record; the public build must not contain it.
CANARY = "CANARY-PRIVATE-FIELD-7f3a"


class BuildError(SystemExit):
    pass


# --- L0: parse records ---------------------------------------------------------------------------
def split_record(text: str):
    if not text.startswith("---\n"):
        raise ValueError("no frontmatter")
    fm_text, _, body = text[4:].partition("\n---\n")
    return yaml.safe_load(fm_text), body


def sections(body: str) -> dict[str, str]:
    out = {}
    parts = re.split(r"^## (\w[\w ]*)\n", body, flags=re.M)
    # parts: [preamble, name, text, name, text, ...]
    for i in range(1, len(parts) - 1, 2):
        out[parts[i].strip()] = parts[i + 1].strip("\n")
    return out


def load_vocab(path: Path) -> set[str]:
    return {ln.strip() for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.startswith("#")}


def parse_tree(places: Path) -> list[dict]:
    recs = []
    for p in sorted(places.glob("*.md")):
        try:
            fm, body = split_record(p.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            raise BuildError(f"ASSERTION: {p.name} does not parse: {e}")
        sec = sections(body)
        recs.append({"slug": p.stem, "fm": fm, "sec": sec, "path": p})
    return recs


def assert_records(recs: list[dict], vocab_dir: Path) -> None:
    kinds, cuisines = load_vocab(vocab_dir / "kind.txt"), load_vocab(vocab_dir / "cuisine.txt")
    ids = {}
    problems = []
    for r in recs:
        fm, slug = r["fm"], r["slug"]
        for k in ("id", "name", "kind", "status", "locations"):
            if k not in fm:
                problems.append(f"{slug}: missing {k}")
        if fm.get("id") in ids:
            problems.append(f"{slug}: duplicate id {fm.get('id')} (also {ids[fm.get('id')]})")
        ids[fm.get("id")] = slug
        problems += [f"{slug}: kind {k!r} not in vocab" for k in fm.get("kind", []) if k not in kinds]
        problems += [f"{slug}: cuisine {c!r} not in vocab" for c in (fm.get("cuisine") or []) if c not in cuisines]
        if fm.get("status") not in STATUS_OK:
            problems.append(f"{slug}: status {fm.get('status')!r} not in {sorted(STATUS_OK)}")
        for loc in fm.get("locations") or []:
            lat, lon = loc.get("coord", [None, None])
            if not (isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and -90 <= lat <= 90 and -180 <= lon <= 180):
                problems.append(f"{slug}: coordinate out of range {loc.get('coord')}")
    for r in recs:
        tgt = r["fm"].get("merged_into")
        if tgt and tgt not in ids:
            problems.append(f"{r['slug']}: merged_into {tgt} does not exist")
        if tgt and r["sec"].get("Evidence", "").strip():
            problems.append(f"{r['slug']}: tombstone retains a non-empty ## Evidence")
    if problems:
        for p in problems[:25]:
            print("ASSERTION:", p, file=sys.stderr)
        raise BuildError(f"build blocked: {len(problems)} record assertion(s) failed; nothing written -- first: {problems[0]}")


# --- L1: signals cache ----------------------------------------------------------------------------
LEGACY_SIGNAL_COLS = {"provider_status": "Business_Status", "rating": "Rating", "review_count": "Review_Count",
                      "hours": "Hours_Summary"}


def seed_signals_from_legacy(recs: list[dict], signals_dir: Path) -> int:
    """One-time seed: provider facts the CSV carried (Google's own numbers, taken at face value)
    become the regenerable L1 cache, stamped with the CSV's refresh date. Never written back to L0."""
    signals_dir.mkdir(exist_ok=True)
    n = 0
    for r in recs:
        leg = r["fm"].get("legacy_import") or {}
        vals = {k: (leg.get(col) or "").strip() for k, col in LEGACY_SIGNAL_COLS.items()}
        if not any(vals.values()):
            continue
        observed = (leg.get("Google_Details_Refreshed_At") or leg.get("Last_Updated_At") or "").strip() or None
        target = signals_dir / f"{r['fm']['id']}.json"
        if target.exists():
            continue  # a real on-demand check owns it from now on
        sig = {k: v for k, v in vals.items() if v}
        sig["observed_at"] = observed
        sig["last_checked"] = observed
        sig["seeded_from"] = "master-discovery.csv legacy_import"
        target.write_text(json.dumps(sig, indent=2) + "\n", encoding="utf-8")
        n += 1
    return n


def load_signals(signals_dir: Path) -> dict[str, dict]:
    if not signals_dir.exists():
        return {}
    out = {}
    for p in signals_dir.glob("*.json"):
        try:
            out[p.stem] = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            print(f"WARNING: unreadable signal {p.name}, skipped", file=sys.stderr)
    return out


# --- emit: private -------------------------------------------------------------------------------
def private_feature(r: dict, sig: dict | None) -> dict | None:
    fm, sec = r["fm"], r["sec"]
    locs = fm.get("locations") or []
    if not locs:
        return None
    lat, lon = locs[-1]["coord"]
    kind = fm.get("kind") or []
    props = {
        "id": fm["id"], "slug": r["slug"], "name": fm.get("name", ""),
        "category": APP_CATEGORY.get(kind[0] if kind else "", "Activities"),
        "kind": kind, "cuisine": fm.get("cuisine") or [], "lists": fm.get("lists") or [], "tags": fm.get("tags") or [],
        "signal": fm.get("signal") or "", "city": fm.get("city") or "", "country": fm.get("country") or "",
        "status": fm.get("status"), "hidden": bool(fm.get("hidden")), "stage": fm.get("stage"),
        "description": sec.get("Why", ""),
        "evidence": [ln[2:] for ln in sec.get("Evidence", "").splitlines() if ln.startswith("- ")],
        "note": (fm.get("note") or "").strip("[]") or None,
        "_canary": CANARY,
    }
    if fm.get("aka"):
        props["aka"] = fm["aka"]
    if fm.get("verdict"):
        props["verdict"] = fm["verdict"]
    if sec.get("Visits", "").strip():
        props["my_take"] = sec["Visits"]
    pid = (fm.get("provider_ids") or {}).get("maps")
    if pid:
        props["google_place_id"] = pid
    if sig:
        for k in ("provider_status", "rating", "review_count", "hours", "observed_at"):
            if sig.get(k):
                props[f"provider_{k}" if k != "provider_status" else k] = sig[k]
    return {"type": "Feature", "properties": {k: v for k, v in props.items() if v not in (None, "", [])},
            "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]}}


# --- emit: public --------------------------------------------------------------------------------
def load_allowlist(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def trusted_place_id(r: dict) -> str | None:
    """Status-gated. TRANSITIONAL RULE (until council step 8): the record does not yet carry an
    identity-confidence field, so the legacy verification state is the only trust signal there is.
    Mirrors build-discovery-geojson.trusted_place_id so the public surface does not change at cutover."""
    pid = (r["fm"].get("provider_ids") or {}).get("maps")
    if not pid:
        return None
    leg = r["fm"].get("legacy_import") or {}
    listing = (leg.get("Listing_Status") or "").strip()
    sanity = (leg.get("Sanity_Status") or "").strip()
    if listing in {"verified", "closed"} or (not listing and sanity == "VERIFIED"):
        return pid
    return None


def public_feature(r: dict, allow: dict, sig: dict | None) -> dict | None:
    fm, sec = r["fm"], r["sec"]
    if fm.get("status") != "open" or fm.get("hidden") or fm.get("share") is False or fm.get("merged_into"):
        return None
    locs = fm.get("locations") or []
    if not locs:
        return None
    # Google's own permanent-closure claim ends the recommendation on the public surface, as today
    # (build-discovery-geojson 2026-08-11/12). It never hides anything on the owner build.
    ps = (sig or {}).get("provider_status", "").upper()
    if ps.startswith("CLOSED") and ps != "CLOSED_TEMPORARILY":
        return None
    lat, lon = locs[-1]["coord"]
    sources = {
        "name": lambda: fm.get("name"),
        "kind": lambda: (fm.get("kind") or [None])[0],
        "signal": lambda: fm.get("signal"),
        "why": lambda: sec.get("Why", "").strip(),
        "tags": lambda: fm.get("tags") or [],
        "city": lambda: fm.get("city"),
        "google_place_id": lambda: trusted_place_id(r),
        "temporarily_closed": lambda: True if ps == "CLOSED_TEMPORARILY" else None,
    }
    props = {}
    for field in allow["fields"]:  # positive construction: ONLY declared fields, in declared order
        if field not in sources:
            raise BuildError(f"allowlist declares {field!r} but the projector has no source for it")
        v = sources[field]()
        if v not in (None, "", []):
            props[field] = v
    return {"type": "Feature", "properties": props, "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]}}


def scan_for_leaks(payload) -> list[tuple[str, str, str]]:
    hits = []

    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")
        elif isinstance(node, str):
            for pat in FORBIDDEN_PATTERNS:
                if pat.search(node):
                    hits.append((path, pat.pattern, node[:80]))
    walk(payload, "$")
    return hits


def assert_public(payload: dict, allow: dict) -> None:
    declared = set(allow["fields"])
    emitted = {k for f in payload["features"] for k in f["properties"]}
    extra = emitted - declared
    if extra:
        raise BuildError(f"PUBLIC BUILD BLOCKED: emitted field(s) not on the allowlist: {sorted(extra)}")
    blob = json.dumps(payload, ensure_ascii=False)
    if CANARY in blob:
        raise BuildError("PUBLIC BUILD BLOCKED: private-field canary present in public.json")
    leaks = scan_for_leaks(payload)
    if leaks:
        for path, pat, sample in leaks[:10]:
            print(f"  {path}  ~/{pat}/  ::  {sample!r}", file=sys.stderr)
        raise BuildError(f"PUBLIC BUILD BLOCKED: {len(leaks)} forbidden pattern(s) in public.json")


# --- emit: index.db ------------------------------------------------------------------------------
def build_index(recs: list[dict], signals: dict, db_path: Path) -> None:
    tmp = db_path.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    con = sqlite3.connect(tmp)
    con.executescript("""
      CREATE TABLE place(id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT, city TEXT, country TEXT,
        kind_primary TEXT, status TEXT, hidden INTEGER, stage TEXT, verdict TEXT, signal TEXT,
        lat REAL, lon REAL, provider_id TEXT, note TEXT, why TEXT, visits TEXT, merged_into TEXT,
        provider_status TEXT, provider_observed_at TEXT);
      CREATE TABLE place_kind(id TEXT, kind TEXT);      CREATE INDEX ix_kind ON place_kind(kind);
      CREATE TABLE place_cuisine(id TEXT, cuisine TEXT); CREATE INDEX ix_cuisine ON place_cuisine(cuisine);
      CREATE TABLE place_list(id TEXT, list TEXT);      CREATE INDEX ix_list ON place_list(list);
      CREATE TABLE place_tag(id TEXT, tag TEXT);        CREATE INDEX ix_tag ON place_tag(tag);
      CREATE TABLE evidence(id TEXT, n INTEGER, line TEXT);
      CREATE TABLE log(id TEXT, n INTEGER, line TEXT);
      CREATE INDEX ix_place_city ON place(city);
      CREATE INDEX ix_place_coord ON place(lat, lon);
      CREATE VIRTUAL TABLE place_fts USING fts5(id UNINDEXED, name, city, why, visits, tags, kinds, evidence);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    for r in recs:
        fm, sec = r["fm"], r["sec"]
        locs = fm.get("locations") or []
        lat, lon = (locs[-1]["coord"] if locs else (None, None))
        sig = signals.get(fm["id"]) or {}
        kinds = fm.get("kind") or []
        con.execute("INSERT INTO place VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
            fm["id"], r["slug"], fm.get("name"), fm.get("city"), fm.get("country"), kinds[0] if kinds else None,
            fm.get("status"), int(bool(fm.get("hidden"))), fm.get("stage"), fm.get("verdict"), fm.get("signal"),
            lat, lon, (fm.get("provider_ids") or {}).get("maps"), fm.get("note"), sec.get("Why", ""),
            sec.get("Visits", ""), fm.get("merged_into"), sig.get("provider_status"), sig.get("observed_at")))
        con.executemany("INSERT INTO place_kind VALUES (?,?)", [(fm["id"], k) for k in kinds])
        con.executemany("INSERT INTO place_cuisine VALUES (?,?)", [(fm["id"], c) for c in fm.get("cuisine") or []])
        con.executemany("INSERT INTO place_list VALUES (?,?)", [(fm["id"], l) for l in fm.get("lists") or []])
        con.executemany("INSERT INTO place_tag VALUES (?,?)", [(fm["id"], t) for t in fm.get("tags") or []])
        ev = [ln[2:] for ln in sec.get("Evidence", "").splitlines() if ln.startswith("- ")]
        con.executemany("INSERT INTO evidence VALUES (?,?,?)", [(fm["id"], i, ln) for i, ln in enumerate(ev)])
        lg = [ln[2:] for ln in sec.get("Log", "").splitlines() if ln.startswith("- ")]
        con.executemany("INSERT INTO log VALUES (?,?,?)", [(fm["id"], i, ln) for i, ln in enumerate(lg)])
        con.execute("INSERT INTO place_fts VALUES (?,?,?,?,?,?,?,?)", (
            fm["id"], fm.get("name"), fm.get("city"), sec.get("Why", ""), sec.get("Visits", ""),
            " ".join(fm.get("tags") or []), " ".join(kinds + (fm.get("cuisine") or []) + (fm.get("lists") or [])), "\n".join(ev)))
    con.execute("INSERT INTO meta VALUES ('built_at', ?)", (datetime.now(timezone.utc).isoformat(timespec="seconds"),))
    con.execute("INSERT INTO meta VALUES ('records', ?)", (str(len(recs)),))
    con.commit()
    con.close()
    os.replace(tmp, db_path)


# --- emit: per-place history (council step 6, downstream read 8) --------------------------------
HISTORY_CAP = 20
HISTORY_SKIP_KEYS = {"legacy_import", "import"}


def _git(vault: Path, *args) -> str | None:
    import subprocess
    try:
        return subprocess.run(["git", *args], cwd=vault, text=True, capture_output=True, check=True, timeout=300).stdout
    except Exception:  # noqa: BLE001  (not a repo, git missing, path untracked)
        return None


def _field_changes(before_text: str | None, after_text: str) -> dict:
    """Frontmatter fields that differ between two versions of a record, plus ## Log lines added."""
    try:
        a_fm, a_body = split_record(after_text)
    except Exception:  # noqa: BLE001
        return {}
    b_fm, b_body = ({}, "")
    if before_text:
        try:
            b_fm, b_body = split_record(before_text)
        except Exception:  # noqa: BLE001
            pass
    changed = []
    for k in sorted(set(a_fm) | set(b_fm)):
        if k in HISTORY_SKIP_KEYS or a_fm.get(k) == b_fm.get(k):
            continue
        changed.append({"field": k, "before": b_fm.get(k), "after": a_fm.get(k)})
    a_log = [ln for ln in sections(a_body).get("Log", "").splitlines() if ln.startswith("- ")]
    b_log = set(ln for ln in sections(b_body).get("Log", "").splitlines() if ln.startswith("- "))
    log_added = [ln[2:] for ln in a_log if ln not in b_log]
    out = {}
    if changed:
        out["changed"] = changed
    if log_added:
        out["log_added"] = log_added
    return out


def build_history(vault: Path, places: Path, recs: list[dict], out_dir: Path) -> int:
    """One git log pass -> commits per record; field diffs only where a record has >1 commit."""
    rel = str(places.relative_to(vault))
    raw = _git(vault, "log", "--format=%x1e%H%x1f%ct%x1f%an%x1f%s", "--name-only", "--", rel)
    if raw is None:
        return 0
    per_file: dict[str, list[dict]] = {}
    for chunk in raw.split("\x1e"):
        chunk = chunk.strip("\n")
        if not chunk:
            continue
        head, _, files = chunk.partition("\n")
        sha, ts, author, subject = (head.split("\x1f") + ["", "", "", ""])[:4]
        for f in files.splitlines():
            f = f.strip()
            if f.startswith(rel + "/") and f.endswith(".md"):
                per_file.setdefault(f[len(rel) + 1:-3], []).append(
                    {"sha": sha[:10], "ts": datetime.fromtimestamp(int(ts), timezone.utc).isoformat(timespec="seconds"), "author": author, "subject": subject})
    # one status pass, not one per record (3,129 subprocesses cost ~3 minutes)
    dirty = {ln[3:].strip()[len(rel) + 1:-3] for ln in (_git(vault, "status", "--short", "--", rel) or "").splitlines()
             if ln[3:].strip().startswith(rel + "/") and ln.strip().endswith(".md")}
    out_dir.mkdir(parents=True, exist_ok=True)
    created = [{"field": "record", "before": None, "after": "created"}]
    n = 0
    for r in recs:
        entries = per_file.get(r["slug"], [])[:HISTORY_CAP]  # git log is newest-first
        if len(entries) > 1:
            path = f"{rel}/{r['slug']}.md"
            versions = [_git(vault, "show", f"{e['sha']}:{path}") for e in entries]
            for i, e in enumerate(entries):
                if i + 1 >= len(versions):
                    e["changed"] = created  # oldest known version: the whole record is the change
                elif versions[i] is not None:
                    e.update(_field_changes(versions[i + 1], versions[i]))
        elif entries:
            entries[0]["changed"] = created
        write_json_atomic(out_dir / f"{r['slug']}.json", {"slug": r["slug"], "id": r["fm"]["id"], "entries": entries,
                                                            "uncommitted": r["slug"] in dirty})
        n += 1
    return n


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)


# --- main ----------------------------------------------------------------------------------------
MUTATION_RE = re.compile(r"\(mutation ([0-9a-f-]{8,})\)")


def applied_mutations(recs: list[dict]) -> list[str]:
    """Mutation ids the applier stamped into ## Log lines; the owner build drops its pending overlay for these."""
    ids = []
    for r in recs:
        ids += MUTATION_RE.findall(r["sec"].get("Log", ""))
    return sorted(set(ids))


def build(vault: Path, out: Path, seed: bool, public: bool, provoke_leak: bool = False) -> dict:
    places, vocab = vault / "domains" / "things-to-do" / "places", vault / "domains" / "things-to-do" / "vocab"
    signals_dir = out / "signals"
    private_path, public_path, db_path = out / "private" / "private.json", out / "public.json", out / "index.db"
    if "/docs/" in f"/{private_path.resolve()}/" or private_path.resolve().parent.name == "docs":
        raise BuildError("refusing to write private.json under a docs/ directory (that path publishes)")

    recs = parse_tree(places)
    if not recs:
        raise BuildError(f"no records under {places}")
    assert_records(recs, vocab)
    seeded = seed_signals_from_legacy(recs, signals_dir) if seed else 0
    signals = load_signals(signals_dir)

    private = {"type": "FeatureCollection", "name": "discovery-map-private",
               "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
               "applied_mutations": applied_mutations(recs),
               "features": [f for f in (private_feature(r, signals.get(r["fm"]["id"])) for r in recs) if f]}
    report = {"records": len(recs), "private_features": len(private["features"]),
              "no_coords": sum(1 for r in recs if not r["fm"].get("locations")),
              "signals_seeded": seeded, "signals_joined": sum(1 for r in recs if r["fm"]["id"] in signals)}
    pub = None
    if public:
        allow = load_allowlist(REPO / "public-allowlist.yml")
        pub = {"type": "FeatureCollection", "name": "discovery-map",
               "features": [f for f in (public_feature(r, allow, signals.get(r["fm"]["id"])) for r in recs) if f]}
        if provoke_leak and pub["features"]:
            # Step 5 drill: plant a vault deep link inside an ALLOWLISTED field. The field-set diff
            # cannot see it (the key is legal); the egress scan must, and the build must die.
            pub["features"][0]["properties"]["why"] = "obsidian://open?vault=executive-function&file=notes/x -- PROVOKED LEAK"
        assert_public(pub, allow)
        report["public_features"] = len(pub["features"])

    # all gates passed -> publish (WAP)
    build_index(recs, signals, db_path)
    write_json_atomic(private_path, private)
    report["history_files"] = build_history(vault, places, recs, private_path.parent / "history")
    if pub is not None:
        write_json_atomic(public_path, pub)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=str(DEFAULT_VAULT))
    ap.add_argument("--out", default=str(REPO))
    ap.add_argument("--seed-signals-from-legacy", action="store_true")
    ap.add_argument("--public", action="store_true", help="also build public.json (step 5 deploys it)")
    ap.add_argument("--provoke-leak", action="store_true", help="drill: plant a forbidden value in a public field; the build MUST abort")
    a = ap.parse_args()
    report = build(Path(a.vault).expanduser(), Path(a.out).resolve(), a.seed_signals_from_legacy, a.public, a.provoke_leak)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
