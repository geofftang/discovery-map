#!/usr/bin/env python3
"""Local server for the OWNER build: static dist-private/ plus the same edit endpoint the phone uses.

The laptop copy at http://127.0.0.1:8765/ used to be plain `python3 -m http.server`, so its edits could
only queue (POST /api/edits -> 501). This serves the bundle AND accepts the four verbs, writing each
mutation to a local inbox directory that the vault applier drains alongside the Vercel Blob inbox:

    edits-inbox-local/<ts>-<mid>.json     (gitignored; same shape as the Blob objects)

Same contract as private-api/api/edits.js: token (constant-time), origin, verb schema, batch cap.
The token is VITE_EDIT_TOKEN from .env.private.local, the one baked into the bundle it serves.
Bound to 127.0.0.1 only. Run by launchd com.user.discovery-map-private.
"""
from __future__ import annotations
import hmac, json, re, sys, uuid
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DIST = REPO / "dist-private"
INBOX = REPO / "edits-inbox-local"
ENV = REPO / ".env.private.local"
ALLOWED_HOSTS = {"127.0.0.1:8765", "localhost:8765"}
MID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
MAX_BATCH = 50


def token() -> str:
    for ln in ENV.read_text(encoding="utf-8").splitlines() if ENV.exists() else []:
        if ln.startswith("VITE_EDIT_TOKEN="):
            return ln.split("=", 1)[1].strip().strip('"')
    return ""


def payload_ok(verb: str, p) -> bool:
    p = p or {}
    if verb in ("hide", "unhide"):
        return p == {}
    if verb == "set-status":
        return set(p) == {"status"} and p["status"] in ("open", "closed")
    if verb == "move-pin":
        return set(p) == {"lat", "lon"} and all(isinstance(p[k], (int, float)) for k in p) and -90 <= p["lat"] <= 90 and -180 <= p["lon"] <= 180
    if verb == "append-note":
        return set(p) == {"text"} and isinstance(p["text"], str) and 0 < len(p["text"].strip()) and len(p["text"]) <= 2000
    return False


def validate(m) -> str | None:
    if not isinstance(m, dict):
        return "not an object"
    if not MID_RE.match(str(m.get("mid", ""))):
        return "bad mid"
    if not isinstance(m.get("place_id"), str) or not 8 <= len(m["place_id"]) <= 64:
        return "bad place_id"
    if m.get("verb") not in ("hide", "unhide", "set-status", "move-pin", "append-note"):
        return f"unknown verb {m.get('verb')}"
    if not payload_ok(m["verb"], m.get("payload")):
        return f"bad payload for {m['verb']}"
    try:
        datetime.fromisoformat(str(m.get("ts", "")).replace("Z", "+00:00"))
    except ValueError:
        return "bad ts"
    return None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(DIST), **kw)

    def log_message(self, fmt, *args):  # quiet; launchd captures stderr anyway
        if self.path.startswith("/api/"):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send_json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        if self.path.split("?")[0] != "/api/edits":
            return self.send_json(404, {"error": "not found"})
        src = self.headers.get("Origin") or self.headers.get("Referer") or ""
        host = re.sub(r"^https?://", "", src).split("/")[0]
        if host not in ALLOWED_HOSTS:
            return self.send_json(403, {"error": "origin"})
        expected = token()
        given = self.headers.get("X-Edit-Token", "")
        if not expected or not hmac.compare_digest(given, expected):
            return self.send_json(401, {"error": "token"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self.send_json(400, {"error": "bad json"})
        muts = body.get("mutations") if isinstance(body, dict) else None
        if not isinstance(muts, list) or not 1 <= len(muts) <= MAX_BATCH:
            return self.send_json(400, {"error": f"mutations[] required, 1..{MAX_BATCH}"})
        INBOX.mkdir(exist_ok=True)
        accepted, rejected = [], []
        for m in muts:
            why = validate(m)
            if why:
                rejected.append({"mid": m.get("mid") if isinstance(m, dict) else None, "why": why})
                continue
            clean = {"mid": m["mid"], "place_id": m["place_id"], "verb": m["verb"], "payload": m.get("payload") or {},
                     "ts": m["ts"], "received_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"), "via": "map-local"}
            if m.get("confirmed_stale") is True:
                clean["confirmed_stale"] = True
            stamp = clean["received_at"].replace("-", "").replace(":", "").replace(".", "")[:15]
            tmp = INBOX / f".{uuid.uuid4()}.tmp"
            tmp.write_text(json.dumps(clean), encoding="utf-8")
            tmp.replace(INBOX / f"{stamp}-{clean['mid']}.json")  # idempotent on mid: same mid overwrites
            accepted.append(clean["mid"])
        self.send_json(200, {"accepted": accepted, "rejected": rejected})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    if not DIST.exists():
        sys.exit(f"{DIST} missing -- run npm run build:private")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
