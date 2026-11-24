// Startup behaviour in a real browser (Chromium, headless). The bug this guards: pins waited for the whole
// basemap ('load': every tile, font and sprite) because setupPlaces() bailed out on map.isStyleLoaded(), which is
// false on a phone at 'style.load'. Here the basemap's sprite, fonts and tiles are held back for 6 s; pins must
// still appear within 3 s, long before the map is idle.
//   needs: `npm run build` (public build in dist/) and a Chromium: set CHROMIUM_PATH, or have one in the
//   Playwright cache (~/Library/Caches/ms-playwright).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';

const DIST = new URL('../dist/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.geojson': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = join(homedir(), 'Library/Caches/ms-playwright');
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).filter((n) => n.startsWith('chromium_headless_shell')).sort().reverse()) {
    const sub = readdirSync(join(root, d)).find((n) => n.startsWith('chrome-headless-shell'));
    const exe = sub && join(root, d, sub, 'chrome-headless-shell');
    if (exe && existsSync(exe)) return exe;
  }
}

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const file = join(DIST, p === '/' ? 'index.html' : p);
    if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

async function load(holdBasemapMs) {
  const exe = findChromium();
  assert.ok(exe, 'no Chromium found: set CHROMIUM_PATH');
  assert.ok(existsSync(join(DIST, 'index.html')), 'run `npm run build` first');
  const server = await serve();
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })  // headless has no GPU: software WebGL;
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.route(/cartocdn\.com/, async (route) => {
      if (/style\.json/.test(route.request().url()) || holdBasemapMs === 0) return route.continue();
      await new Promise((r) => setTimeout(r, holdBasemapMs));
      await route.continue().catch(() => {});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__efMarks && window.__efMarks.dots !== undefined, null, { timeout: 8000 });
    return await page.evaluate(() => ({ ...window.__efMarks }));
  } finally { await browser.close(); server.close(); }
}

test('pins appear within 3 s even while the basemap sprite, fonts and tiles are held back 6 s', async () => {
  const marks = await load(6000);
  assert.ok(marks.dots < 3000, `pins took ${marks.dots} ms`);
  assert.equal(marks.maploaded, undefined, 'the basemap must still be loading: the delay did not apply, so this test proved nothing');
});

test('with a normal basemap the pins still draw and the map reaches idle', async () => {
  const marks = await load(0);
  assert.ok(marks.dots < 3000, `pins took ${marks.dots} ms`);
});
