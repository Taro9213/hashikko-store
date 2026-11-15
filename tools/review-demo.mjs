// The whole store flow on this computer, so you can try it before the store is public.
//   node tools/review-demo.mjs
//
//   http://127.0.0.1:4330/desk        Review desk: approve, ask for changes, decline, rule-breaks (warnings and strikes),
//                                     reports (pause, take down), appeals, channels
//   http://127.0.0.1:4322/web/        The store website (rebuilt every time something is approved or taken down)
//   http://127.0.0.1:4322/            The store files the app reads (catalog.json, blocklist.json, parts/)
//   http://127.0.0.1:4330/v1/...      The store service the app talks to (same code as service/worker.mjs),
//                                     with a pretend "Sign in with Google" page
//
// Everything happens in a copy of the store (.demo/), so the real parts/ folder is never changed.
// GitHub is faked in memory: in the real store, the same review steps are labels and pull requests on GitHub (see REVIEW.md).
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, rmSync, existsSync, cpSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import worker, { admin } from '../service/worker.mjs';
import { createDesk } from './desk-core.mjs';

const tools = dirname(fileURLToPath(import.meta.url));
const real = join(tools, '..');
const demo = join(real, '.demo');
const today = () => new Date().toISOString().slice(0, 10);
const env = {
  STORE_REPO: 'demo/hashikko-store', GITHUB_TOKEN: 'demo', GITHUB_API: 'http://127.0.0.1:4331',
  DEMO_GOOGLE: '1', PUBLIC_URL: 'http://127.0.0.1:4330/', ADMIN_TOKEN: 'demo-admin',
};

// ---------- a fresh copy of the store ----------
rmSync(demo, { recursive: true, force: true });
mkdirSync(demo, { recursive: true });
for (const f of ['catalog.json', 'blocklist.json']) cpSync(join(real, f), join(demo, f));
cpSync(join(real, 'parts'), join(demo, 'parts'), { recursive: true });
// A made-up creator (Maya Chen) so the demo store looks lived-in. Only in the demo, never in the real store
cpSync(join(tools, 'demo-sample'), join(demo, 'parts'), { recursive: true });
function rebuild() {
  const e = { ...process.env, HASHIKKO_STORE_ROOT: demo, HASHIKKO_STATS_URL: 'http://127.0.0.1:4330/v1/stats' };
  execFileSync(process.execPath, [join(tools, 'build-catalog.mjs')], { env: e, stdio: 'ignore' });
  execFileSync(process.execPath, [join(tools, 'build-web.mjs')], { env: e, stdio: 'ignore' });
}
rebuild();
// Channels that already have parts in the store (the sample creator) are known to the service, with some made-up counts
await (async () => {
  const st = await admin(env, { action: 'channels' });
  void st;
  for (const id of readdirSync(join(demo, 'parts'))) {
    const mf = join(demo, 'parts', id, 'meta.json');
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    if (m.sample) await seedSample(m);
  }
})();
async function seedSample(m) {
  // Pretend this sample channel has followers and uses, so the store looks like it does once people use it
  const fake = (n) => 'f'.repeat(64 - String(n).length) + n;
  const ch = m.channel || '';
  for (let n = 0; n < 37; n++) await worker.fetch(new Request('http://x/v1/used', { method: 'POST', body: JSON.stringify({ id: m.id, key: fake(n) }) }), env);
  if (ch) for (let n = 0; n < 12; n++) await worker.fetch(new Request('http://x/v1/follow', { method: 'POST', body: JSON.stringify({ channel: ch, key: fake(n), on: true }) }), env);
}

// ---------- fake GitHub (issues only, in memory) ----------
const issues = [];
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  let m;
  if (req.method === 'POST' && /\/issues$/.test(u.pathname)) {
    const b = JSON.parse(body);
    const issue = { number: issues.length + 1, title: b.title, body: b.body, labels: (b.labels || []).map((name) => ({ name })),
      state: 'open', state_reason: null, comments: 0, _comments: [], created: new Date().toISOString() };
    issues.push(issue);
    return send(issue, 201);
  }
  if ((m = u.pathname.match(/\/issues\/(\d+)\/comments$/))) return send(issues[m[1] - 1] ? issues[m[1] - 1]._comments : []);
  if ((m = u.pathname.match(/\/issues\/(\d+)$/))) return issues[m[1] - 1] ? send(issues[m[1] - 1]) : send({}, 404);
  send({}, 404);
}).listen(4331, '127.0.0.1');

// ---------- the review desk (same logic as the real store's tools/desk.mjs) ----------
const gh = {
  list: async () => issues.map((i) => ({ ...i, comments: i._comments })),
  labels: async (i, add, remove) => { const x = issues[i.number - 1]; x.labels = x.labels.filter((l) => !remove.includes(l.name)); for (const n of add) if (!x.labels.some((l) => l.name === n)) x.labels.push({ name: n }); },
  comment: async (i, body) => { const x = issues[i.number - 1]; x._comments.push({ body, at: new Date().toISOString() }); x.comments = x._comments.length; },
  close: async (i, reason) => { const x = issues[i.number - 1]; x.state = 'closed'; x.state_reason = reason; },
};
const desk = createDesk({
  store: demo, gh,
  admin: (b) => admin(env, b),
  stats: async () => (await worker.fetch(new Request('http://x/v1/stats'), env)).json(),
  publish: async () => rebuild(),
});

// ---------- the store files and website (what the app and visitors see) ----------
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = resolve(join(demo, p));
  if (!f.startsWith(demo) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(f));
}).listen(4322, '127.0.0.1');

// ---------- the store service and the review desk ----------
const deskHtml = readFileSync(join(tools, 'review-desk.html'), 'utf8');
const previewCss = readFileSync(join(tools, 'part-base.css'), 'utf8');
const previewSdk = readFileSync(join(tools, 'preview-sdk.js'), 'utf8');
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'http://127.0.0.1:4330');
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/desk') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(deskHtml); }
  if (u.pathname === '/desk/items') return send({ ...(await desk.items()), preview: { css: previewCss, sdk: previewSdk } });
  if (u.pathname === '/desk/act' && req.method === 'POST') { try { return send(await desk.act(JSON.parse(body))); } catch (e) { return send({ ok: false, reason: String(e.message || e) }); } }
  const headers = { ...req.headers, 'cf-connecting-ip': req.socket.remoteAddress };
  const r = await worker.fetch(new Request(u, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(await r.text());
}).listen(4330, '127.0.0.1', () => {
  console.log('Review desk:    http://127.0.0.1:4330/desk');
  console.log('Store website:  http://127.0.0.1:4322/web/');
  console.log('(Close this window to stop the demo.)');
});
