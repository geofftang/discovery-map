// Load-timing readout. Add #perf to the URL (e.g. /map/#perf) and the page shows how long each
// startup step took on THIS device, plus the last few loads. Off by default: no cost otherwise.
const on = typeof location !== 'undefined' && location.hash.includes('perf');
const marks = {};
export function mark(name) {
  if (marks[name] !== undefined) return;
  marks[name] = Math.round(performance.now());
  // The portal's shared real-user timing script (/shared/ef-rum.js) reads these when it reports.
  (window.__efMarks = window.__efMarks || {})[name] = marks[name];
  if (on) render();
}
function transfer(re) {
  const e = performance.getEntriesByType('resource').find((r) => re.test(r.name));
  if (!e) return '?';
  return e.transferSize === 0 ? 'cache' : `net ${Math.round(e.transferSize / 1024)}kB`;
}
let box;
function render() {
  if (!box) {
    box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;margin:0;padding:8px;font:11px/1.35 ui-monospace,monospace;color:#0f0;background:rgba(0,0,0,.82);border-radius:8px;max-width:92vw;white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(box);
  }
  const nav = performance.getEntriesByType('navigation')[0];
  const lines = [
    `page html   ${nav ? Math.round(nav.responseEnd) : '?'}ms`,
    `app start   ${marks.start ?? '-'}ms`,
    `style ready ${marks.style ?? '-'}ms`,
    `data ready  ${marks.data ?? '-'}ms  (${transfer(/private\.json|discovery\.geojson/)})`,
    `dots drawn  ${marks.dots ?? '-'}ms`,
    `map idle    ${marks.idle ?? '-'}ms`,
  ];
  if (marks.idle !== undefined) {
    let hist = [];
    try { hist = JSON.parse(localStorage.getItem('perf_hist') || '[]'); } catch {}
    hist.unshift(`idle ${marks.idle}ms dots ${marks.dots}ms data ${marks.data}ms ${transfer(/private\.json|discovery\.geojson/)}`);
    try { localStorage.setItem('perf_hist', JSON.stringify(hist.slice(0, 5))); } catch {}
    lines.push('--- last loads', ...hist.slice(0, 5));
  }
  box.textContent = lines.join('\n');
}
