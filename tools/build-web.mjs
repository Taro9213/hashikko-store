// Builds the public store website (web/) from catalog.json and parts/.
// App Store side: a page for every part with a clear description, who made it, and what it may do.
// GitHub side: the full code of every part is shown, so anyone can see exactly what it does.
//   node tools/build-web.mjs        → web/index.html, web/share.html, web/parts/<id>.html
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTINS } from './similar.mjs';

const tools = dirname(fileURLToPath(import.meta.url));
// HASHIKKO_STORE_ROOT: build a copy of the store somewhere else (the review demo uses this)
const root = process.env.HASHIKKO_STORE_ROOT || join(tools, '..');
const out = join(root, 'web');
const SITE = process.env.HASHIKKO_SITE || 'https://hashikko.app/';   // the main website (placeholder until it is decided)
const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8')).parts;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PERMS = { storage: 'Saves its own data on your computer', 'clipboard.write': 'Copies text when you ask it to' };
const official = (p) => p.creator === 'hashikko';
const creatorIdOk = (id) => /^[a-z0-9-]{1,40}$/.test(String(id || '')) && id !== 'unknown';

// People who made parts. The name shown is the one they used most recently.
const creators = new Map();
for (const p of catalog) {
  if (!creatorIdOk(p.creator)) continue;
  const c = creators.get(p.creator) || { id: p.creator, name: p.author, handle: p.handle || '', parts: [], first: p.added || p.updated || '', last: '' };
  if (p.handle) c.handle = p.handle;
  c.parts.push(p);
  if ((p.updated || '') >= c.last) { c.last = p.updated || ''; c.name = official(p) ? 'Hashikko' : p.author; }
  if (p.updated && (!c.first || p.updated < c.first)) c.first = p.updated;
  creators.set(p.creator, c);
}
const byLine = (p, rootRel) => official(p) ? '<span class="badge">By Hashikko</span>'
  : creatorIdOk(p.creator) ? `Made by <a href="${rootRel}creators/${esc(p.creator)}.html">${esc(p.author)}</a>` : 'Made by ' + esc(p.author);
// Live numbers (uses, followers, paused parts) come from the store service, so the pages stay plain files.
// HASHIKKO_STATS_URL: e.g. https://hashikko-submit.<you>.workers.dev/v1/stats. Without it the pages show no numbers.
const STATS = process.env.HASHIKKO_STATS_URL || '';
const NEW_DAYS = 14;
const isNew = (p) => p.added && (Date.now() - Date.parse(p.added)) / 86400000 <= NEW_DAYS;
const statsScript = () => !STATS ? '' : `<script>
(async () => {
  let s; try { s = await (await fetch(${JSON.stringify(STATS)}, { cache: 'no-store' })).json(); } catch { return; }
  if (!s || !s.ok) return;
  const fmt = (n) => n >= 1000000 ? (n / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'K' : String(n);
  // Use counts show only from 10 uses, and in lists only under Most used / Popular
  document.querySelectorAll('[data-uses]').forEach((e) => { const n = (s.uses || {})[e.dataset.uses] || 0; const g = e.closest('.grid'); if (n < 10 || (g && g.dataset.sort !== 'uses')) return; e.textContent = fmt(n) + ' uses'; e.hidden = false; });
  document.querySelectorAll('[data-sum-uses]').forEach((e) => { const n = e.dataset.sumUses.split(',').reduce((a, id) => a + ((s.uses || {})[id] || 0), 0); e.textContent = fmt(n) + ' uses'; e.hidden = false; });
  document.querySelectorAll('[data-followers]').forEach((e) => { const n = (s.followers || {})[e.dataset.followers] || 0; e.textContent = fmt(n) + (n === 1 ? ' follower' : ' followers'); e.hidden = false; });
  // Parts paused while a reviewer looks at reports are not offered to new people
  (s.paused || []).forEach((id) => document.querySelectorAll('[data-part="' + id + '"]').forEach((e) => { e.hidden = true; }));
  // Old look-alikes that few people use go to the bottom of each list
  document.querySelectorAll('[data-stale]').forEach((c) => { if (((s.uses || {})[c.dataset.part] || 0) < 10 && c.parentElement) c.parentElement.append(c); });
  // "Popular": most used first
  document.querySelectorAll('[data-sort="uses"]').forEach((g) => [...g.children].sort((a, b) => ((s.uses || {})[b.dataset.part] || 0) - ((s.uses || {})[a.dataset.part] || 0)).forEach((c) => g.append(c)));
})();
</script>`;
const avatar = (name) => `<span class="avatar" aria-hidden="true">${esc((String(name || '?').trim()[0] || '?').toUpperCase())}</span>`;

function page({ title, description, rootRel, active, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="stylesheet" href="${rootRel}store.css">
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="${rootRel}index.html"><span class="mark"></span>Hashikko <span class="tag">Store</span></a>
  <nav>
    <a href="${rootRel}index.html"${active === 'all' ? ' aria-current="page"' : ''}>All parts</a>
    <a href="${rootRel}creators.html"${active === 'creators' ? ' aria-current="page"' : ''}>Creators</a>
    <a href="${rootRel}share.html"${active === 'share' ? ' aria-current="page"' : ''}>Share yours</a>
    <a href="${SITE}">Get Hashikko</a>
  </nav>
</div></header>
<main>${body}</main>
${statsScript()}
<footer class="foot"><div class="wrap">
  <span>Every part is reviewed by a person and runs in a sandbox with no internet access.</span>
  <a href="${rootRel}share.html#rules">Store rules</a>
</div></footer>
</body>
</html>
`;
}

// Parts that come with Hashikko (not in the catalog: they are inside the app). Shown with the official parts
// (the list lives in similar.mjs, which also uses it to spot look-alike parts)
// A part that looks like another one (store rules: parts that do the same job): one line on what it does more
// It shows on the part's page, side by side with the parts it looks like (not on the cards in lists)
function compareBox(p) {
  if (!p.differs || !(p.like || []).length) return '';
  const others = p.like.map((id) => {
    const b = BUILTINS.find((x) => x.id === id);
    if (b) return { ...b, by: 'Hashikko', href: `${SITE}parts/${b.id}.html` };
    const o = catalog.find((x) => x.id === id);
    return o && { ...o, by: official(o) ? 'Hashikko' : o.author, href: `${esc(o.id)}.html` };
  }).filter(Boolean);
  if (!others.length) return '';
  const row = (x, me) => `<div class="crow${me ? ' me' : ''}">
      <span class="emoji">${esc(x.emoji)}</span>
      <div><b>${me ? esc(x.name) : `<a href="${x.href}">${esc(x.name)}</a>`}</b> <span class="muted">${me ? 'This part' : 'By ' + esc(x.by)}</span>
        <small>${esc(x.description)}</small>${me ? `<small class="plus">＋ ${esc(p.differs)}</small>` : ''}</div>
    </div>`;
  return `<div class="compare">
    <h2>Compared with similar parts</h2>
    <p class="note">These parts do a similar job. Here's what this one does more.</p>
    ${others.map((x) => row(x, false)).join('')}${row(p, true)}
  </div>`;
}
// Look-alikes that haven't been updated for half a year go to the bottom of lists (unless people use them: see statsScript)
const STALE_DAYS = 180;
const isStale = (p) => !!(p.like && p.like.length) && (Date.now() - Date.parse(p.updated || p.added || 0)) / 86400000 > STALE_DAYS;
const staleLast = (list) => list.filter((p) => !isStale(p)).concat(list.filter(isStale));
const builtinCard = (b) => `<a class="card" href="${SITE}parts/${esc(b.id)}.html" data-q="${esc((b.name + ' ' + b.description).toLowerCase())}">
  <span class="emoji">${esc(b.emoji)}</span>
  <span class="ctext"><b>${esc(b.name)}</b><small>${esc(b.description)}</small>
  <span class="by"><span class="badge">By Hashikko</span></span></span>
</a>`;
const card = (p, rootRel) => `<a class="card" href="${rootRel}parts/${esc(p.id)}.html" data-part="${esc(p.id)}"${isStale(p) ? ' data-stale' : ''} data-q="${esc([p.name, p.description, p.differs, p.author, p.handle, ...(p.keywords || [])].join(' ').toLowerCase())}">
  <span class="emoji">${esc(p.emoji)}</span>
  <span class="ctext"><b>${esc(p.name)}${isNew(p) ? ' <span class="badge new">New</span>' : ''}</b><small>${esc(p.description)}</small>
  <span class="by">${official(p) ? '<span class="badge">By Hashikko</span>' : esc(p.author)} ${sampleBadge(p)}${official(p) ? '' : `<span class="uses" data-uses="${esc(p.id)}" hidden></span>`}</span></span>
</a>`;
// A channel, as a small card (like a creator row on YouTube)
const channelCard = (c, rootRel) => `<a class="card creator" href="${rootRel}creators/${esc(c.id)}.html" data-q="${esc((c.name + ' ' + (c.handle || '')).toLowerCase())}">
  ${c.id === 'hashikko' ? '<span class="avatar brandmark" aria-hidden="true"></span>' : avatar(c.name)}
  <span class="ctext"><b>${esc(c.name)}</b><small>${c.handle ? '@' + esc(c.handle) + ' · ' : ''}${c.parts.length} ${c.parts.length === 1 ? 'part' : 'parts'}</small>
  <span class="by"><span class="followers" data-followers="${esc(c.id)}" hidden></span></span></span>
</a>`;

function index() {
  const ours = catalog.filter(official);
  const theirs = catalog.filter((p) => !official(p));
  const grid = (list, sort) => `<div class="grid"${sort ? ` data-sort="${sort}"` : ''}>${list.map((p) => card(p, '')).join('\n')}</div>`;
  const fresh = theirs.filter(isNew).sort((a, b) => String(b.added).localeCompare(String(a.added))).slice(0, 8);
  const people = [...creators.values()].filter((c) => c.id !== 'hashikko').sort((a, b) => b.parts.length - a.parts.length).slice(0, 8);
  return page({
    title: 'Hashikko Store: small tools for the edge of your screen',
    description: 'Find small tools for Hashikko, made by Hashikko and by people like you. Every part is reviewed and runs in a sandbox.',
    rootRel: '', active: 'all',
    body: `
<section class="hero"><div class="wrap">
  <p class="eyebrow">Hashikko Store</p>
  <h1>Small tools, made by people like you.</h1>
  <p class="lead">Every part opens from the edge of your screen. Each one is reviewed by a person, runs in a sandbox, and can't connect to the internet.</p>
  <input class="search" id="q" type="search" placeholder="Search parts (e.g. timer, calculator)" aria-label="Search parts">
</div></section>
<section class="list"><div class="wrap">
  <div id="browse">
  <h2>Made by Hashikko</h2>
  <p class="sub">Official parts, made by the Hashikko team.</p>
  <div class="grid">${BUILTINS.map(builtinCard).join(String.fromCharCode(10))}${ours.map((p) => card(p, '')).join(String.fromCharCode(10))}</div>
  ${theirs.length ? `<h2 class="section">From creators</h2><p class="sub">Parts made and shared by people who use Hashikko. A person reviews each one before it appears here. <a href="creators.html">See the creators</a></p>` : ''}
  ${fresh.length ? `<h3>New this week</h3>${grid(fresh)}` : ''}
  ${theirs.length > 1 && STATS ? `<h3>Popular</h3>${grid(theirs.slice(0, 8), 'uses')}` : ''}
  ${theirs.length ? `<h3>All parts from creators</h3>${grid(staleLast(theirs))}` : ''}
  </div>
  <!-- 検索の結果：部品を1つずつだけ（上の見出しでは、同じ部品が何回か出るため） -->
  <div class="grid" id="results" hidden>${BUILTINS.map(builtinCard).join(String.fromCharCode(10))}${ours.concat(theirs).map((p) => card(p, '')).join(String.fromCharCode(10))}</div>
  <p class="none" id="none" hidden>No part matches yet. <a href="share.html">Make it with AI and share it.</a></p>
  <div class="cta"><div><b>Made something useful?</b><span>Sign in with Google in the app, pick a channel name, and share it in one click.</span></div><a class="btn primary" href="share.html">How sharing works</a></div>
</div></section>
<script>
const q = document.getElementById('q');
q.addEventListener('input', () => {
  const v = q.value.trim().toLowerCase();
  const results = document.getElementById('results');
  document.getElementById('browse').hidden = !!v;
  results.hidden = !v;
  let shown = 0;
  results.querySelectorAll('.card').forEach((c) => { const on = !!v && c.dataset.q.includes(v); c.hidden = !on; if (on) shown++; });
  document.getElementById('none').hidden = !v || shown > 0;
});
</script>`,
  });
}

// "Try it here": the part runs in a locked box on the page (no network, nothing saved after you leave)
const PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">`;
const baseCssText = readFileSync(join(tools, 'part-base.css'), 'utf8');
const sdkText = readFileSync(join(tools, 'preview-sdk.js'), 'utf8');
function previewDoc(html) {
  return html
    .replace(/<link[^>]+href=["']https:\/\/app\.hashikko\/base\.css["'][^>]*>/i, () => `<style>${baseCssText}</style>`)
    .replace(/<script[^>]+src=["']https:\/\/app\.hashikko\/sdk\.js["'][^>]*><\/script>/i, () => `<script>${sdkText}</script>`)
    .replace(/<head([^>]*)>/i, (m) => m + PREVIEW_CSP);
}
const sampleBadge = (p) => (p.sample ? '<span class="badge sample" title="A made-up example for testing the store">Sample</span>' : '');

function partPage(p) {
  const html = readFileSync(join(root, 'parts', p.id, 'index.html'), 'utf8');
  const reviewed = p.reviewed || p.updated;
  const perms = (p.permissions || []).map((x) => `<li>${esc(PERMS[x] || x)}</li>`).join('');
  const kb = Math.max(1, Math.round(p.size / 1024));
  return page({
    title: `${p.name} for Hashikko`,
    description: `${p.description}. A free part for Hashikko, the toolbox at the edge of your screen.`,
    rootRel: '../', active: 'all',
    body: `
<section class="detail"><div class="wrap">
  <a class="back" href="../index.html">← All parts</a>
  <div class="head">
    <span class="emoji big">${esc(p.emoji)}</span>
    <div>
      <h1>${esc(p.name)}</h1>
      <p class="lead">${esc(p.description)}</p>
      <p class="by">${byLine(p, '../')}${p.handle ? ` <span class="muted">@${esc(p.handle)}</span>` : ''} ${sampleBadge(p)}
        ${official(p) ? '' : `<span class="uses" data-followers="${esc(p.creator)}" hidden></span><span class="uses" data-uses="${esc(p.id)}" hidden></span>`}</p>
      <p class="checked"><span class="tick">✓</span> Reviewed by a person${reviewed ? ` · ${esc(reviewed)}` : ''}</p>
    </div>
  </div>
  <div class="trybox">
    <div class="trytext">
      <h2>Try it here</h2>
      <p>This is the real part, running right on this page, just like in the Hashikko panel. Nothing you type leaves this page, and it's gone when you close it.</p>
    </div>
    <div class="panelframe"><iframe title="${esc(p.name)} preview" sandbox="allow-scripts" srcdoc="${esc(previewDoc(html))}"></iframe></div>
  </div>
  <div class="cols">
    <div class="get" data-part="${esc(p.id)}">
      <h2>Add it to Hashikko</h2>
      <button class="btn primary big" id="copyBtn" type="button">Copy this part</button>
      <p class="then" id="then">Then open Hashikko and tap <b>＋</b>. Your part is waiting under <b>Add a shared part</b>.</p>
      <p class="note">Don't have Hashikko yet? <a href="${SITE}">Get it free</a></p>
    </div>
    <div class="facts">
      <h2>What it can do</h2>
      <ul class="perms">${perms || '<li>Nothing beyond showing itself</li>'}<li class="no">Can't connect to the internet</li><li class="no">Can't see your files or other parts</li></ul>
      <dl>
        <dt>Version</dt><dd>${esc(p.version)}</dd>
        ${p.updated ? `<dt>Updated</dt><dd>${esc(p.updated)}</dd>` : ''}
        <dt>Size</dt><dd>${kb} KB</dd>
        <dt>Works on</dt><dd>Windows and Mac</dd>
      </dl>
    </div>
  </div>
  ${compareBox(p)}
  <details class="code">
    <summary><b>See the code</b><span>Every part is one HTML file. Nothing is hidden.</span></summary>
    <pre><code>${esc(html)}</code></pre>
    <p class="note">Fingerprint (SHA-256): <code>${esc(p.sha256)}</code>. Hashikko checks it before adding the part.</p>
  </details>
  <p class="note">Something wrong with this part? In Hashikko, find it under ＋ and click <b>Report</b>.</p>
</div></section>
<script>
// Copies the part exactly as it is in the store, so Hashikko can recognize it (same fingerprint)
const btn = document.getElementById('copyBtn');
btn.addEventListener('click', async () => {
  const code = document.querySelector('.code code').textContent;
  let ok = false;
  try { await navigator.clipboard.writeText(code); ok = true; } catch {
    const t = document.createElement('textarea'); t.value = code; document.body.append(t); t.select();
    try { ok = document.execCommand('copy'); } catch {} t.remove();
  }
  btn.textContent = ok ? '✓ Copied' : "Couldn't copy. Try again.";
  btn.classList.toggle('done', ok);
  if (ok) document.getElementById('then').classList.add('on');
});
</script>`,
  });
}

function creatorPage(c) {
  const mine = c.parts.slice().sort((a, b) => String(b.added || b.updated).localeCompare(String(a.added || a.updated)));
  return page({
    title: `${c.name} on the Hashikko Store`,
    description: `Parts made by ${c.name} for Hashikko, the toolbox at the edge of your screen.`,
    rootRel: '../', active: 'creators',
    body: `
<section class="detail"><div class="wrap">
  <a class="back" href="../creators.html">← All creators</a>
  <div class="banner" aria-hidden="true"></div>
  <div class="head channel">
    ${c.id === 'hashikko' ? '<span class="avatar big brandmark" aria-hidden="true"></span>' : avatar(c.name).replace('avatar', 'avatar big')}
    <div>
      <h1>${esc(c.name)}</h1>
      <p class="lead">${c.handle ? `<b>@${esc(c.handle)}</b> · ` : ''}${c.id === 'hashikko' ? `${mine.length} official ${mine.length === 1 ? 'part' : 'parts'}` : `<span data-followers="${esc(c.id)}" hidden></span>${STATS ? ' · ' : ''}${mine.length} ${mine.length === 1 ? 'part' : 'parts'}`}</p>
      <p class="by">${c.id === 'hashikko' ? '<span class="badge">The Hashikko team</span>' : `Sharing since ${esc(String(c.first).slice(0, 7))}`} ${c.parts.some((p) => p.sample) ? sampleBadge({ sample: true }) : ''}</p>
      ${c.id === 'hashikko' ? '' : '<p class="note">To follow, open this creator\'s part in Hashikko and tap <b>Follow</b>. You\'ll see their new parts first.</p>'}
    </div>
  </div>
  <div class="tabs" role="tablist">
    <button class="tab on" role="tab" aria-selected="true" data-tab="used">Most used</button>
    <button class="tab" role="tab" aria-selected="false" data-tab="new">Newest</button>
  </div>
  <div class="grid" data-panel="used" data-sort="uses">${mine.map((p) => card(p, '../')).join('\n')}</div>
  <div class="grid" data-panel="new" hidden>${mine.map((p) => card(p, '../')).join('\n')}</div>
  <script>
  document.querySelectorAll('.tabs .tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab').forEach((x) => { const on = x === t; x.classList.toggle('on', on); x.setAttribute('aria-selected', String(on)); });
    document.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t.dataset.tab; });
  }));
  </script>
</div></section>`,
  });
}

function creatorsIndex() {
  const list = [...creators.values()].sort((a, b) => (a.id === 'hashikko') - (b.id === 'hashikko') || b.parts.length - a.parts.length || a.name.localeCompare(b.name));
  return page({
    title: 'Creators: Hashikko Store',
    description: 'The people who make parts for Hashikko.',
    rootRel: '', active: 'creators',
    body: `
<section class="hero"><div class="wrap">
  <p class="eyebrow">Creators</p>
  <h1>The people behind the parts.</h1>
  <p class="lead">Anyone can make a part with AI and share it. No account needed.</p>
</div></section>
<section class="list"><div class="wrap">
  <div class="grid">${list.map((c) => channelCard(c, '')).join('\n')}</div>
  <div class="cta"><div><b>Want your own page?</b><span>Share a part from the app. Your page appears when it's in the store.</span></div><a class="btn primary" href="share.html">How sharing works</a></div>
</div></section>`,
  });
}

function share() {
  return page({
    title: 'Share your part: Hashikko Store',
    description: 'Made a useful part with AI? Share it with everyone from inside Hashikko. No account needed.',
    rootRel: '', active: 'share',
    body: `
<section class="hero"><div class="wrap">
  <p class="eyebrow">Share yours</p>
  <h1>Made something useful? Let everyone use it.</h1>
  <p class="lead">You don't need to know how to code, and you don't need an account. It all happens inside Hashikko.</p>
</div></section>
<section class="list"><div class="wrap">
  <ol class="flow">
    <li><span class="n">1</span><b>Make it</b><small>Click ＋ → Make it with AI, and describe the tool you want.</small></li>
    <li><span class="n">2</span><b>Try it</b><small>Use it for a while. Ask AI to change it until it feels right.</small></li>
    <li><span class="n">3</span><b>Share it</b><small>Right-click its icon → Share to store. Check three boxes and send.</small></li>
    <li><span class="n">4</span><b>We review it</b><small>A person checks that it's useful and safe, usually within a few days.</small></li>
    <li><span class="n">5</span><b>It's in the store</b><small>Anyone can add it, and you get your own creator page. You'll see "In the store" next to your part.</small></li>
  </ol>
  <h2>What you'll see in Hashikko after you send it</h2>
  <div class="states">
    <div><span class="pill s-review">In review</span><small>We got it. A person is looking at it.</small></div>
    <div><span class="pill s-changes">Needs changes</span><small>You'll see a short note on what to fix. Ask AI to fix it, then share again.</small></div>
    <div><span class="pill s-listed">In the store</span><small>Anyone can add it now, and your creator page is live.</small></div>
    <div><span class="pill s-declined">Not accepted</span><small>It doesn't fit the rules below. You'll see why.</small></div>
  </div>
  <h2 id="rules">Store rules</h2>
  <div class="rules">
    <div><b>Good parts</b><ul><li>Finish a small task right in the panel</li><li>Are useful the moment they open</li><li>Say honestly what they do</li><li>Are in English</li></ul></div>
    <div><b>Not allowed</b><ul><li>Hateful, harassing, violent or sexual content</li><li>Anything that tries to trick people, like fake login screens</li><li>Copying someone else's work, name or logo</li><li>A second part that does the same job as one already in the store, without doing anything more</li><li>Personal information about real people</li><li>Hidden code, network access, or other websites</li></ul></div>
  </div>
  <h2>Your parts stay yours</h2>
  <p>There's no sign-up. Hashikko keeps a secret key on your computer that proves the parts you shared are yours, so only you can update them. If you change computers, save your recovery code first: in Hashikko, open Settings → Your shared parts → Copy recovery code.</p>
  <p class="note">Parts that break the rules are removed, and also turned off on computers that already added them. You can update a part you shared by sharing it again. Only you can update your parts.</p>
</div></section>`,
  });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'parts'), { recursive: true });
copyFileSync(join(tools, 'store.css'), join(out, 'store.css'));
writeFileSync(join(out, 'index.html'), index());
writeFileSync(join(out, 'share.html'), share());
writeFileSync(join(out, 'creators.html'), creatorsIndex());
mkdirSync(join(out, 'creators'), { recursive: true });
for (const c of creators.values()) writeFileSync(join(out, 'creators', `${c.id}.html`), creatorPage(c));
for (const p of catalog) if (existsSync(join(root, 'parts', p.id, 'index.html'))) writeFileSync(join(out, 'parts', `${p.id}.html`), partPage(p));
console.log(`web/: ${catalog.length} part page(s), ${creators.size} creator page(s)`);
