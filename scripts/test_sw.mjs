// Service-worker behaviour tests: run the real docs/sw.js in a vm with fake caches/fetch.
// Each case is a bug that reached the owner's phone: a 401 login page swallowed into a blank
// "can't load" page, and a DATA_UPDATED -> refetch -> DATA_UPDATED loop re-downloading the feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../docs/sw.js', import.meta.url), 'utf8');
const SHELL = 'discovery-map-__BUILD__';
const DATA = 'discovery-map-data-v1';

class FakeCache {
  constructor() { this.m = new Map(); }
  key(r) { return typeof r === 'string' ? new URL(r, 'https://h/map/').href : r.url; }
  async match(r) { const v = this.m.get(this.key(r)); return v ? v.clone() : undefined; }
  async put(r, res) { this.m.set(this.key(r), res); }
  async keys() { return [...this.m.keys()]; }
  async delete(k) { return this.m.delete(k); }
}

function boot(fetchImpl, seed = {}) {
  const stores = new Map(Object.entries(seed));
  const listeners = {};
  const posted = [];
  const self = {
    location: { href: 'https://h/map/sw.js', origin: 'https://h' },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (m) => posted.push(m) }] },
  };
  const caches = {
    open: async (n) => { if (!stores.has(n)) stores.set(n, new FakeCache()); return stores.get(n); },
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
  };
  vm.runInNewContext(SRC, { self, caches, fetch: fetchImpl, URL, Response, console, setTimeout, Promise });
  return { listeners, posted };
}

async function dispatch(listeners, request, settle = true) {
  let out; const waits = [];
  listeners.fetch({ request, respondWith: (p) => { out = p; }, waitUntil: (p) => waits.push(p) });
  const res = await out;
  if (settle) await Promise.all(waits);
  return res;
}
const nav = () => ({ url: 'https://h/map/', method: 'GET', mode: 'navigate', destination: 'document' });
const feed = () => ({ url: 'https://h/map/private.json', method: 'GET', mode: 'cors', destination: '' });

test('401 login page is shown, not turned into a network error', async () => {
  const { listeners } = boot(async () => new Response('login form', { status: 401 }));
  const res = await dispatch(listeners, nav());
  assert.equal(res.status, 401);
  assert.equal(await res.text(), 'login form');
});

test('offline on a first visit still errors', async () => {
  const { listeners } = boot(async () => { throw new TypeError('offline'); });
  const res = await dispatch(listeners, nav());
  assert.equal(res.type, 'error');
});

test('cached shell is served without waiting for the network', async () => {
  const shell = new FakeCache();
  shell.m.set('https://h/map/', new Response('cached shell'));
  let release; const gate = new Promise((r) => { release = r; });
  const { listeners } = boot(async () => { await gate; return new Response('new'); }, { [SHELL]: shell });
  const res = await Promise.race([dispatch(listeners, nav(), false), new Promise((r) => setTimeout(() => r('timeout'), 200))]);
  assert.notEqual(res, 'timeout', 'must not wait for the network');
  assert.equal(await res.text(), 'cached shell');
  release();
});

test('feed revalidation notifies the page only when the feed changed (no refetch loop)', async () => {
  let etag = 'v1';
  const cache = new FakeCache();
  cache.m.set('https://h/map/private.json', new Response('{}', { headers: { etag: 'v1' } }));
  const { listeners, posted } = boot(async () => new Response('{"features":[]}', { headers: { etag } }), { [DATA]: cache });
  await dispatch(listeners, feed()); await dispatch(listeners, feed()); await dispatch(listeners, feed());
  assert.equal(posted.length, 0, 'same version must not notify');
  etag = 'v2';
  await dispatch(listeners, feed());
  assert.equal(posted.length, 1, 'new version notifies once');
  await dispatch(listeners, feed());
  assert.equal(posted.length, 1, 'and not again for the same version');
});

test('files the app does not own (portal /shared scripts) are never frozen in the shell cache', async () => {
  let served = 'v1';
  const shell = new FakeCache();
  const { listeners } = boot(async () => new Response(served), { [SHELL]: shell });
  const req = { url: 'https://h/shared/ef-rum.js', method: 'GET', mode: 'no-cors', destination: 'script' };
  let responded = false;
  listeners.fetch({ request: req, respondWith: () => { responded = true; }, waitUntil: () => {} });
  assert.equal(responded, false, 'the worker must not intercept it, so the browser fetches the current copy');
  assert.equal((await shell.keys()).length, 0, 'and nothing is written to the shell cache');
});

test('hashed bundles are still served cache-first', async () => {
  const shell = new FakeCache();
  shell.m.set('https://h/map/assets/index-abc.js', new Response('bundle'));
  const { listeners } = boot(async () => { throw new Error('should not hit the network'); }, { [SHELL]: shell });
  const res = await dispatch(listeners, { url: 'https://h/map/assets/index-abc.js', method: 'GET', mode: 'no-cors', destination: 'script' });
  assert.equal(await res.text(), 'bundle');
});
