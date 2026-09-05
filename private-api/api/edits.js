// Owner-build write endpoint (council step 7). Deployed ONLY inside the private Vercel deployment:
// `npm run build:private` copies private-api/ into dist-private/. The public build has no api/.
//
// Three independent barriers stop anyone but the owner writing:
//   1. Vercel Authentication gates the whole deployment (this function included).
//   2. EDIT_TOKEN: a device-provisioned shared secret, baked into the owner bundle as VITE_EDIT_TOKEN
//      and compared here in constant time.
//   3. Origin check: only the deployment's own aliases may call this.
//
// The map captures; it does not author. Exactly four verbs, strict payload shapes, small bodies.
// Each accepted mutation lands in Vercel Blob at edits/inbox/<ts>-<mid>.json (private access,
// idempotent on mid). The vault's serialized applier drains the inbox and commits.
import { put } from '@vercel/blob';
import { timingSafeEqual } from 'node:crypto';

const ALLOWED_HOSTS = new Set([
  'discovery-map.vercel.app',
  'discovery-map-private.vercel.app',
  '127.0.0.1:8765',
]);
const VERBS = {
  'hide': (p) => p == null || Object.keys(p).length === 0,
  'unhide': (p) => p == null || Object.keys(p).length === 0,
  'set-status': (p) => p && (p.status === 'open' || p.status === 'closed') && Object.keys(p).length === 1,
  'move-pin': (p) => p && typeof p.lat === 'number' && typeof p.lon === 'number'
    && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180 && Object.keys(p).length === 2,
  'append-note': (p) => p && typeof p.text === 'string' && p.text.trim().length > 0 && p.text.length <= 2000
    && Object.keys(p).length === 1,
};
const MID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 50;

function tokenOk(header) {
  const expected = process.env.EDIT_TOKEN || '';
  if (!expected || typeof header !== 'string') return false;
  const a = Buffer.from(header), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function originOk(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return false;
  try { return ALLOWED_HOSTS.has(new URL(src).host); } catch { return false; }
}

function validate(m) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (!MID_RE.test(m.mid || '')) return 'bad mid';
  if (typeof m.place_id !== 'string' || m.place_id.length < 8 || m.place_id.length > 64) return 'bad place_id';
  if (!(m.verb in VERBS)) return `unknown verb ${m.verb}`;
  if (!VERBS[m.verb](m.payload)) return `bad payload for ${m.verb}`;
  if (typeof m.ts !== 'string' || Number.isNaN(Date.parse(m.ts))) return 'bad ts';
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!originOk(req)) return res.status(403).json({ error: 'origin' });
  if (!tokenOk(req.headers['x-edit-token'])) return res.status(401).json({ error: 'token' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  const mutations = body && Array.isArray(body.mutations) ? body.mutations : null;
  if (!mutations || mutations.length === 0 || mutations.length > MAX_BATCH) {
    return res.status(400).json({ error: `mutations[] required, 1..${MAX_BATCH}` });
  }

  const accepted = [], rejected = [];
  for (const m of mutations) {
    const why = validate(m);
    if (why) { rejected.push({ mid: m && m.mid, why }); continue; }
    const clean = { mid: m.mid, place_id: m.place_id, verb: m.verb, payload: m.payload || {}, ts: m.ts,
      received_at: new Date().toISOString(), via: 'map' };
    if (m.confirmed_stale === true) clean.confirmed_stale = true;  // >14d edit the owner re-confirmed on the map
    const stamp = clean.received_at.replace(/[-:.]/g, '').slice(0, 15);
    await put(`edits/inbox/${stamp}-${clean.mid}.json`, JSON.stringify(clean), {
      access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true,
    });
    accepted.push(clean.mid);
  }
  return res.status(200).json({ accepted, rejected });
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
