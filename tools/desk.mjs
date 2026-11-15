// The review desk for the real store. Run it on your own computer, inside your copy (git clone) of hashikko-store:
//   node tools/desk.mjs          → open http://127.0.0.1:4360/desk
//
// It reads submissions and reports from GitHub issues, and moderation records from the store service.
// "Approve" and "Take down" change parts/ and blocklist.json here, rebuild catalog.json, then commit and push to GitHub,
// so the app and the store website pick them up (the website rebuilds itself on GitHub).
//
// Settings: desk.secrets.json next to this folder's README (never commit it; it is in .gitignore):
//   { "githubToken": "github_pat_…", "storeRepo": "owner/hashikko-store",
//     "serviceUrl": "https://hashikko-store.<you>.workers.dev/", "adminToken": "…" }
// The GitHub token needs Issues: read and write on hashikko-store. Pushing uses your normal git sign-in.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createDesk } from './desk-core.mjs';

const tools = dirname(fileURLToPath(import.meta.url));
const root = join(tools, '..');
const PORT = 4360;
const secretsFile = join(root, 'desk.secrets.json');
if (!existsSync(secretsFile)) {
  console.error('Missing desk.secrets.json. See the top of tools/desk.mjs (and SETUP.md).');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(secretsFile, 'utf8'));
for (const k of ['githubToken', 'storeRepo', 'serviceUrl', 'adminToken']) if (!cfg[k]) { console.error(`desk.secrets.json: "${k}" is empty.`); process.exit(1); }
const service = cfg.serviceUrl.endsWith('/') ? cfg.serviceUrl : cfg.serviceUrl + '/';

// ---------- GitHub issues ----------
async function api(path, init = {}) {
  const r = await fetch(`${cfg.githubApi || 'https://api.github.com'}/repos/${cfg.storeRepo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${cfg.githubToken}`, accept: 'application/vnd.github+json', 'user-agent': 'hashikko-desk',
      'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
  });
  if (r.status === 404 && init.method === 'DELETE') return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
  return r.status === 204 ? null : r.json();
}
// Comments rarely change once an issue is closed, so they are kept between refreshes
const commentCache = new Map();
async function list() {
  const out = [];
  for (const labelName of ['submission', 'report']) {
    for (let page = 1; page <= 5; page++) {
      const batch = await api(`/issues?state=all&labels=${labelName}&per_page=100&page=${page}`);
      for (const i of batch) {
        if (i.pull_request) continue;
        let comments = [];
        if (i.comments) {
          const c = commentCache.get(i.number);
          if (c && c.updated === i.updated_at) comments = c.list;
          else {
            comments = (await api(`/issues/${i.number}/comments?per_page=100`)).map((x) => ({ body: x.body, at: x.created_at }));
            commentCache.set(i.number, { updated: i.updated_at, list: comments });
          }
        }
        out.push({ number: i.number, title: i.title, body: i.body || '', labels: i.labels.map((l) => ({ name: l.name || l })),
          state: i.state, state_reason: i.state_reason, created: i.created_at, comments });
      }
      if (batch.length < 100) break;
    }
  }
  return out;
}
const gh = {
  list,
  labels: async (i, add, remove) => {
    if (add.length) await api(`/issues/${i.number}/labels`, { method: 'POST', body: JSON.stringify({ labels: add }) });
    for (const name of remove) if (i.labels.some((l) => l.name === name)) await api(`/issues/${i.number}/labels/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },
  comment: async (i, body) => { await api(`/issues/${i.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) }); },
  close: async (i, reason) => { await api(`/issues/${i.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: reason }) }); },
};

// ---------- the store service ----------
async function admin(b) {
  const r = await fetch(service + 'v1/admin', { method: 'POST', headers: { authorization: 'Bearer ' + cfg.adminToken, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  if (r.status === 403) throw new Error('The service said no: check adminToken in desk.secrets.json.');
  return r.json();
}
const stats = async () => (await fetch(service + 'v1/stats')).json();

// ---------- sending changes out ----------
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
async function publish(message) {
  execFileSync(process.execPath, [join(tools, 'build-catalog.mjs')], { cwd: root, stdio: 'ignore' });
  git('add', '--all', 'parts', 'blocklist.json', 'catalog.json');
  try { git('commit', '-m', message); } catch { return; }   // nothing changed
  git('pull', '--rebase');
  git('push');
}

// Start from what is on GitHub, so you never approve on top of an old copy
try { git('pull', '--rebase'); } catch (e) { console.error('git pull failed. Commit or undo your own changes first.\n' + (e.stderr || e.message)); process.exit(1); }

const desk = createDesk({ store: root, gh, admin, stats, publish });
const deskHtml = readFileSync(join(tools, 'review-desk.html'), 'utf8');
const preview = { css: readFileSync(join(tools, 'part-base.css'), 'utf8'), sdk: readFileSync(join(tools, 'preview-sdk.js'), 'utf8') };
const origin = `http://127.0.0.1:${PORT}`;

createServer(async (req, res) => {
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };
  // Only this computer's browser, on this exact address (stops other websites from using the desk behind your back)
  if (req.headers.host !== `127.0.0.1:${PORT}`) return send({ ok: false, reason: 'wrong-host' }, 403);
  if (req.method !== 'GET' && req.headers.origin !== origin) return send({ ok: false, reason: 'wrong-origin' }, 403);
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, origin);
  try {
    if (u.pathname === '/' || u.pathname === '/desk') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(deskHtml); }
    if (u.pathname === '/desk/items') return send({ ...(await desk.items()), preview });
    if (u.pathname === '/desk/act' && req.method === 'POST') return send(await desk.act(JSON.parse(body)));
    send({ ok: false, reason: 'not-found' }, 404);
  } catch (e) {
    send({ ok: false, reason: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Review desk: ${origin}/desk   (store: ${cfg.storeRepo})`);
  console.log('(Close this window to stop the desk.)');
});
