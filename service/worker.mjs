// Hashikko store service (Cloudflare Worker).
// Creators sign in with Google and share under a channel name they choose (like YouTube).
// The service checks each part, files it for review in the store repository, and keeps channels, follows, use counts
// and the moderation record (warnings, strikes, appeals).
//
// Sign-in (Google). The app opens /v1/auth/start in the browser and asks /v1/auth/poll until the person has signed in.
//   GET  /v1/auth/start?s=<session>        → Google sign-in
//   GET  /v1/auth/callback                 ← Google sends the person back here
//   GET  /v1/auth/poll?s=<session>         → { ok, token, suggestedName } once signed in
//   GET  /v1/me                (token)     → { ok, channel, status, appeals }
//   POST /v1/channel           (token)     { name, handle } → create or rename your channel
// Sharing and reporting (both need sign-in):
//   POST /v1/submit            (token)     { html, ownerKey, agree: true } → { ok, number }
//   GET  /v1/status?n=12,15                → { ok, items: [{ number, state, message }] }
//   POST /v1/report            (token)     { id, reason, details, reporterKey } → { ok }
//   POST /v1/appeal            (token)     { ref, text } → { ok }
// Everyone (no sign-in, a Hashikko ID instead):
//   POST /v1/follow                        { channel, key, on } → { ok, followers }
//   POST /v1/used                          { id, key } → { ok }
//   GET  /v1/stats                         → { ok, uses, followers, paused, channels }
// Reviewers (ADMIN_TOKEN): POST /v1/admin { action, ... } — see admin() below.
//
// What we keep about a person: their Google account number ("sub"), never their email or Google name,
// plus the channel name and handle they chose. People in the store only ever see the channel.
//
// Settings: STORE_REPO, GITHUB_TOKEN (secret), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (secret), PUBLIC_URL, ADMIN_TOKEN (secret),
// and a KV namespace bound as DB. Without DB the service keeps everything in memory (only for testing).
// DEMO_GOOGLE = "1" replaces Google with a pretend sign-in page (only for testing on your computer).
import { checkPart, extractHtml } from '../tools/part-rules.mjs';

const MAX_BODY = 450_000;
const LIMITS = { submit: [10, 3600], report: [20, 3600], status: [240, 3600], social: [600, 3600], auth: [60, 3600] };
const REASONS = [
  'Harmful, hateful or sexual content',
  'Tries to trick people (fake login, scam)',
  "Copies someone else's work, name or logo",
  'Does not work or does something unexpected',
  'Something else',
];
// Reports in these categories pause a part (hidden from the store, still works for people who have it)
// once 3 different signed-in people send them, until a reviewer decides.
const SERIOUS = REASONS.slice(0, 2);
const AUTO_PAUSE_REPORTERS = 3;
// Names people can't use, so no one can pretend to be the Hashikko team
const RESERVED_NAMES = /hashikko|official|admin|moderator|anthropic|claude|support|team|google|youtube/i;
const DAY = 86400000;
const STRIKE_DAYS = 90;                       // warnings and strikes count for 90 days (as on YouTube)
const RESTRICT_DAYS = { 1: 7, 2: 14 };        // 1st strike: no sharing for 1 week, 2nd: 2 weeks; 3rd within 90 days: channel removed

const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
});
const html = (body, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hashikko</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:460px;margin:12vh auto;padding:0 20px;color:#16161a}h1{font-size:24px}a.b,button{display:block;width:100%;margin:10px 0;padding:12px;border-radius:12px;border:1px solid #ddd;background:#fff;font:inherit;text-align:left;cursor:pointer;color:inherit;text-decoration:none}small{color:#666}</style>${body}`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const clean = (s, n) => String(s || '').replace(/[\r\n<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const isKey = (k) => /^[0-9a-f]{64}$/.test(String(k || ''));

// ---------- storage (Cloudflare KV, or memory for testing) ----------
const memory = new Map();
function db(env) {
  if (env.DB) return {
    get: (k) => env.DB.get(k, 'json'),
    put: (k, v, ttl) => env.DB.put(k, JSON.stringify(v), ttl ? { expirationTtl: Math.max(60, ttl) } : undefined),
    del: (k) => env.DB.delete(k),
  };
  return {
    get: async (k) => { const e = memory.get(k); if (!e || (e.exp && e.exp < Date.now())) return null; return JSON.parse(e.v); },
    put: async (k, v, ttl) => { memory.set(k, { v: JSON.stringify(v), exp: ttl ? Date.now() + ttl * 1000 : 0 }); },
    del: async (k) => { memory.delete(k); },
  };
}

// Rate limits are counted in this worker's memory, not in KV: the free KV plan allows only 1,000 writes a day,
// and writing a counter on every request would use them up. Memory is per Cloudflare location and resets when the
// worker restarts, so this is a brake on runaway clients, not an exact limit.
const rates = new Map();
async function limited(env, req, kind) {
  const [max, secs] = LIMITS[kind];
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const key = `${kind}:${await sha256(ip + (env.RATE_SALT || 'hashikko'))}:${Math.floor(Date.now() / 1000 / secs)}`;
  const n = (rates.get(key) || 0) + 1;
  rates.set(key, n);
  if (rates.size > 5000) for (const k of [...rates.keys()].slice(0, 2500)) rates.delete(k);
  return n > max;
}

async function github(env, path, init = {}) {
  const r = await fetch(`${env.GITHUB_API || 'https://api.github.com'}/repos/${env.STORE_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
      'user-agent': 'hashikko-store-service', 'content-type': 'application/json', ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  return r.json();
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- channels and their record ----------
// A channel's standing, worked out from its record (nothing expires by itself in storage)
function standing(ch, now = Date.now()) {
  const live = (list) => (list || []).filter((x) => !x.reversed && now - x.at < STRIKE_DAYS * DAY);
  const warnings = live(ch.warnings), strikes = live(ch.strikes);
  const last = strikes[strikes.length - 1];
  const until = last ? last.at + (RESTRICT_DAYS[strikes.length] || 0) * DAY : 0;
  return {
    terminated: ch.terminated && !ch.terminated.reversed ? ch.terminated : null,
    warnings, strikes,
    restrictedUntil: until > now ? until : 0,
  };
}

async function me(req, env) {
  const auth = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[0-9a-f]{64}$/.test(auth)) return null;
  const s = db(env);
  const sub = await s.get('tok:' + await sha256(auth));
  if (!sub) return null;
  const acct = (await s.get('g:' + sub)) || { sub };
  const ch = acct.channel ? await s.get('ch:' + acct.channel) : null;
  return { sub, acct, ch, reporter: (await sha256('reporter:' + sub)).slice(0, 12) };
}

// ---------- sign-in with Google ----------
async function authStart(req, env, url) {
  if (await limited(env, req, 'auth')) return html('<h1>Too many tries</h1><p>Please try again in a while.</p>', 429);
  const s = url.searchParams.get('s') || '';
  if (!/^[0-9a-f]{32,64}$/.test(s)) return html('<h1>Something went wrong</h1><p>Go back to Hashikko and try again.</p>', 400);
  const base = env.PUBLIC_URL || url.origin + '/';
  if (env.DEMO_GOOGLE === '1') return Response.redirect(new URL('demo-google?state=' + s, base).href, 302);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: new URL('v1/auth/callback', base).href, response_type: 'code',
    scope: 'openid profile', state: s, prompt: 'select_account',
  });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}

// A pretend Google for testing on your computer
function demoGoogle(url) {
  const s = url.searchParams.get('state') || '';
  const people = [['demo-taro', 'Taro Yamada'], ['demo-maya', 'Maya Chen'], ['demo-sam', 'Sam Rivera'], ['demo-troll', 'Rob Troll']];
  return html(`<h1>Sign in with Google <small>(pretend, for testing)</small></h1><p>Choose an account to continue to Hashikko.</p>
${people.map(([sub, name]) => `<a class="b" href="v1/auth/callback?code=${encodeURIComponent('demo:' + sub + ':' + name)}&state=${s}"><b>${name}</b><br><small>${sub}@example.com</small></a>`).join('')}`);
}

async function authCallback(req, env, url) {
  const s = url.searchParams.get('state') || '', code = url.searchParams.get('code') || '';
  if (!/^[0-9a-f]{32,64}$/.test(s) || !code) return html('<h1>Sign-in didn\'t finish</h1><p>Go back to Hashikko and try again.</p>', 400);
  let sub = '', name = '';
  if (env.DEMO_GOOGLE === '1' && code.startsWith('demo:')) {
    [, sub, name] = code.split(':');
  } else {
    // Swap the one-time code for Google's ID token, straight from Google over HTTPS (OpenID Connect "code flow")
    const base = env.PUBLIC_URL || url.origin + '/';
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: new URL('v1/auth/callback', base).href, grant_type: 'authorization_code' }),
    });
    const t = await r.json().catch(() => ({}));
    const part = String(t.id_token || '').split('.')[1] || '';
    let claims = {};
    try { claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))); } catch { /* below */ }
    const okIss = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    if (!r.ok || !okIss || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp * 1000 > Date.now()) || !claims.sub) {
      return html('<h1>Sign-in didn\'t finish</h1><p>Go back to Hashikko and try again.</p>', 400);
    }
    sub = String(claims.sub); name = String(claims.name || claims.given_name || '');
  }
  const st = db(env);
  const acct = (await st.get('g:' + sub)) || { sub, created: Date.now() };
  if (acct.banned) return html('<h1>This Google account can\'t share in Hashikko</h1><p>Its channel was removed for breaking the store rules.</p>', 403);
  await st.put('g:' + sub, acct);
  const token = randomHex(32);
  await st.put('tok:' + await sha256(token), sub, 180 * 86400);
  // The Google name is only offered once, as a suggestion for the channel name. It isn't stored.
  await st.put('sess:' + s, { token, suggestedName: clean(name, 40) }, 600);
  return html('<h1>You\'re signed in</h1><p>Go back to Hashikko. You can close this tab.</p>');
}

async function authPoll(env, url) {
  const s = url.searchParams.get('s') || '';
  if (!/^[0-9a-f]{32,64}$/.test(s)) return json({ ok: false, reason: 'bad-request' }, 400);
  const st = db(env);
  const v = await st.get('sess:' + s);
  if (!v) return json({ ok: false, reason: 'waiting' });
  await st.del('sess:' + s);
  return json({ ok: true, token: v.token, suggestedName: v.suggestedName || '' });
}

async function meInfo(req, env) {
  const m = await me(req, env);
  if (!m) return json({ ok: false, reason: 'signed-out' }, 401);
  const st = db(env);
  const appeals = [];
  for (const id of (m.acct.appeals || []).slice(-10)) { const a = await st.get('appeal:' + id); if (a) appeals.push(a); }
  return json({ ok: true, channel: m.ch && { id: m.ch.id, name: m.ch.name, handle: m.ch.handle, created: m.ch.created },
    status: m.ch ? standing(m.ch) : null, appeals });
}

async function setChannel(req, env) {
  const m = await me(req, env);
  if (!m) return json({ ok: false, reason: 'signed-out' }, 401);
  const b = await readJson(req);
  const name = clean(b && b.name, 40);
  const handle = String((b && b.handle) || '').trim().toLowerCase().replace(/^@/, '');
  if (name.length < 2) return json({ ok: false, reason: 'name-required' }, 400);
  if (RESERVED_NAMES.test(name) || RESERVED_NAMES.test(handle)) return json({ ok: false, reason: 'name-reserved' }, 400);
  if (!/^[a-z0-9_.]{3,30}$/.test(handle)) return json({ ok: false, reason: 'bad-handle' }, 400);
  const st = db(env);
  if (m.ch && standing(m.ch).terminated) return json({ ok: false, reason: 'terminated' }, 403);
  const owner = await st.get('handle:' + handle);
  if (owner && (!m.ch || owner !== m.ch.id)) return json({ ok: false, reason: 'handle-taken' }, 409);
  const ch = m.ch || { id: randomHex(6), created: Date.now(), warnings: [], strikes: [], terminated: null };
  if (m.ch && m.ch.handle !== handle) await st.del('handle:' + m.ch.handle);
  ch.name = name; ch.handle = handle;
  await st.put('ch:' + ch.id, ch);
  await st.put('handle:' + handle, ch.id);
  if (!m.ch) { m.acct.channel = ch.id; await st.put('g:' + m.sub, m.acct); }
  await bumpStats(env, (s) => { s.channels[ch.id] = { name, handle }; });
  return json({ ok: true, channel: { id: ch.id, name, handle, created: ch.created } });
}

// ---------- sharing ----------
async function submit(req, env) {
  if (await limited(env, req, 'submit')) return json({ ok: false, reason: 'too-many' }, 429);
  const m = await me(req, env);
  if (!m) return json({ ok: false, reason: 'signed-out' }, 401);
  if (!m.ch) return json({ ok: false, reason: 'no-channel' }, 400);
  const sd = standing(m.ch);
  if (sd.terminated) return json({ ok: false, reason: 'terminated' }, 403);
  if (sd.restrictedUntil) return json({ ok: false, reason: 'restricted', until: sd.restrictedUntil }, 403);
  const b = await readJson(req);
  if (!b) return json({ ok: false, reason: 'bad-request' }, 400);
  if (b.agree !== true) return json({ ok: false, reason: 'agree' }, 400);
  if (!isKey(b.ownerKey)) return json({ ok: false, reason: 'bad-request' }, 400);
  const r = checkPart(String(b.html || ''));
  if (!r.ok) return json({ ok: false, reason: 'checks', errors: r.errors }, 422);
  const name = clean(typeof r.manifest.name === 'object' ? r.manifest.name.en : r.manifest.name, 60);
  const fence = r.html.includes('````') ? '`````' : '````';
  const body = [
    '_Sent from the Hashikko app._', '',
    '### Part code', '', fence + 'html', r.html, fence, '',
    '### Channel', '', `${m.ch.name} (@${m.ch.handle}) · ${m.ch.id}`, '',
    '### Your name as shown in the store', '', m.ch.name, '',
    '### Owner key', '', await sha256('owner:' + b.ownerKey), '',
    '### Before you submit', '',
    '- [X] My part follows the Guidelines.',
    '- [X] I made this part (with or without AI help), and it does not copy anyone else\'s work, name or logo.',
    '- [X] The part contains no personal information (mine or anyone else\'s).',
    '', r.warnings.length ? '### Notes from the automatic checks\n\n' + r.warnings.map((w) => `- ${w}`).join('\n') : '',
  ].join('\n');
  const issue = await github(env, '/issues', {
    method: 'POST',
    body: JSON.stringify({ title: `Submit: ${name} (${r.manifest.id})`, body, labels: ['submission'] }),
  });
  return json({ ok: true, number: issue.number, warnings: r.warnings });
}

// What the person who sent the part sees in the app.
function stateOf(issue, comments) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  const note = [...comments].reverse().find((c) => /^note:/i.test(String(c.body || '').trim()));
  const message = note ? clean(String(note.body).trim().replace(/^note:\s*/i, ''), 400) : '';
  if (labels.includes('listed') || (issue.state === 'closed' && issue.state_reason === 'completed')) return { state: 'listed', message };
  if (labels.includes('declined') || issue.state === 'closed') return { state: 'declined', message };
  if (labels.includes('needs-changes')) return { state: 'needs-changes', message };
  return { state: 'reviewing', message };
}

async function status(req, env, url) {
  if (await limited(env, req, 'status')) return json({ ok: false, reason: 'too-many' }, 429);
  const nums = [...new Set(String(url.searchParams.get('n') || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20);
  const items = [];
  for (const n of nums) {
    try {
      const issue = await github(env, `/issues/${n}`);
      if (!(issue.labels || []).some((l) => (l.name || l) === 'submission')) continue;
      const comments = issue.comments ? await github(env, `/issues/${n}/comments?per_page=50`) : [];
      items.push({ number: n, ...stateOf(issue, comments) });
    } catch { items.push({ number: n, state: 'unknown', message: '' }); }
  }
  return json({ ok: true, items });
}

// ---------- reports (need sign-in, so every report has a person behind it) ----------
async function report(req, env) {
  if (await limited(env, req, 'report')) return json({ ok: false, reason: 'too-many' }, 429);
  const m = await me(req, env);
  if (!m) return json({ ok: false, reason: 'signed-out' }, 401);
  if (m.ch && standing(m.ch).terminated) return json({ ok: false, reason: 'terminated' }, 403);
  const b = await readJson(req);
  const id = String((b && b.id) || '');
  if (!b || !/^[a-z0-9_-]{1,40}$/.test(id) || !REASONS.includes(b.reason)) return json({ ok: false, reason: 'bad-request' }, 400);
  const details = String(b.details || '').replace(/[<>`]/g, ' ').slice(0, 2000).trim();
  const st = db(env);
  // One open report per person per part (sending it again just updates it)
  const rk = 'rep:' + id;
  const reps = (await st.get(rk)) || { reporters: {} };
  const first = !reps.reporters[m.reporter];
  reps.reporters[m.reporter] = b.reason;
  await st.put(rk, reps);
  const serious = Object.values(reps.reporters).filter((x) => SERIOUS.includes(x)).length;
  let paused = false;
  if (serious >= AUTO_PAUSE_REPORTERS) paused = await bumpStats(env, (s) => { if (!s.paused.includes(id)) s.paused.push(id); return true; });
  if (first) {
    // The issue is public (the store repository is public), so it never says who reported.
    // Who reported is kept here in KV, and only reviewers can read it (admin action "report-meta").
    const issue = await github(env, '/issues', {
      method: 'POST',
      body: JSON.stringify({
        title: `Report: ${id}`, labels: ['report'],
        body: ['_Sent from the Hashikko app._', '', '### Part id', '', id, '', '### What is wrong?', '', b.reason, '',
          '### Details', '', details || '_No response_',
          ...(paused ? ['', '### Paused', '', `${AUTO_PAUSE_REPORTERS} people reported it as serious, so it was hidden from the store until a reviewer decides.`] : [])].join('\n'),
      }),
    });
    await st.put('repmeta:' + issue.number, { reporter: m.reporter, channel: m.ch ? { name: m.ch.name, handle: m.ch.handle, id: m.ch.id } : null });
  }
  return json({ ok: true });
}

async function appeal(req, env) {
  const m = await me(req, env);
  if (!m) return json({ ok: false, reason: 'signed-out' }, 401);
  const b = await readJson(req);
  const ref = clean(b && b.ref, 80), text = clean(b && b.text, 1000);
  if (!ref || text.length < 5) return json({ ok: false, reason: 'bad-request' }, 400);
  const st = db(env);
  m.acct.appeals = m.acct.appeals || [];
  for (const id of m.acct.appeals) { const a = await st.get('appeal:' + id); if (a && a.ref === ref) return json({ ok: false, reason: 'already-appealed' }, 409); }
  const id = randomHex(5);
  const a = { id, ref, text, channel: m.ch ? m.ch.id : '', channelName: m.ch ? m.ch.name : '', at: Date.now(), state: 'open', answer: '' };
  await st.put('appeal:' + id, a);
  m.acct.appeals.push(id);
  await st.put('g:' + m.sub, m.acct);
  const idx = (await st.get('appeals')) || [];
  idx.push(id);
  await st.put('appeals', idx.slice(-500));
  return json({ ok: true, id });
}

// ---------- follows and uses (no sign-in: a Hashikko ID, counted once each) ----------
async function bumpStats(env, fn) {
  const st = db(env);
  const s = (await st.get('stats')) || { uses: {}, followers: {}, paused: [], channels: {} };
  s.channels = s.channels || {};
  const r = fn(s);
  await st.put('stats', s);
  return r;
}

async function follow(req, env) {
  if (await limited(env, req, 'social')) return json({ ok: false, reason: 'too-many' }, 429);
  const b = await readJson(req);
  if (!b || !/^[0-9a-f]{12}$/.test(String(b.channel || '')) || !isKey(b.key)) return json({ ok: false, reason: 'bad-request' }, 400);
  const st = db(env);
  const k = `fol:${b.channel}:${(await sha256('follower:' + b.key)).slice(0, 24)}`;
  const was = !!(await st.get(k));
  if (b.on && !was) await st.put(k, 1); else if (!b.on && was) await st.del(k);
  const n = await bumpStats(env, (s) => { s.followers[b.channel] = Math.max(0, (s.followers[b.channel] || 0) + (b.on && !was ? 1 : !b.on && was ? -1 : 0)); return s.followers[b.channel]; });
  return json({ ok: true, followers: n });
}

async function used(req, env) {
  if (await limited(env, req, 'social')) return json({ ok: false, reason: 'too-many' }, 429);
  const b = await readJson(req);
  if (!b || !/^[a-z0-9_-]{1,40}$/.test(String(b.id || '')) || !isKey(b.key)) return json({ ok: false, reason: 'bad-request' }, 400);
  const st = db(env);
  const k = `use:${b.id}:${(await sha256('user:' + b.key)).slice(0, 24)}`;
  if (!(await st.get(k))) { await st.put(k, 1); await bumpStats(env, (s) => { s.uses[b.id] = (s.uses[b.id] || 0) + 1; }); }
  return json({ ok: true });
}

async function stats(env) {
  const s = (await db(env).get('stats')) || { uses: {}, followers: {}, paused: [], channels: {} };
  return json({ ok: true, ...s }, 200, { 'access-control-allow-origin': '*' });
}

// ---------- reviewers ----------
// Decisions, modeled on YouTube's Community Guidelines strikes: the first rule-break is a warning,
// then strikes (sharing paused 1 week, then 2 weeks), and a 3rd strike within 90 days removes the channel.
// Severe cases (scams, fake logins, sexual content involving minors, malware) remove the channel at once.
export async function admin(env, b) {
  const st = db(env);
  const ch = b.channel ? await st.get('ch:' + b.channel) : null;
  const save = async () => { await st.put('ch:' + ch.id, ch); };
  switch (b.action) {
    case 'channels': {
      const s = (await st.get('stats')) || { channels: {} };
      const out = [];
      for (const id of Object.keys(s.channels || {})) { const c = await st.get('ch:' + id); if (c) out.push({ ...c, standing: standing(c), followers: (s.followers || {})[id] || 0 }); }
      return { ok: true, channels: out };
    }
    case 'channel': return ch ? { ok: true, channel: { ...ch, standing: standing(ch) } } : { ok: false, reason: 'not-found' };
    case 'violation': {
      if (!ch) return { ok: false, reason: 'not-found' };
      const sd = standing(ch);
      if (sd.terminated) return { ok: true, result: 'already-removed' };
      const entry = { id: randomHex(4), at: Date.now(), rule: clean(b.rule, 80), note: clean(b.note, 400), ref: clean(b.ref, 80) };
      let result;
      if (b.severe) { ch.terminated = { ...entry, severe: true }; result = 'removed'; }
      else if (!sd.warnings.length && !sd.strikes.length) { (ch.warnings = ch.warnings || []).push(entry); result = 'warning'; }
      else {
        (ch.strikes = ch.strikes || []).push(entry);
        const n = standing(ch).strikes.length;
        result = n >= 3 ? 'removed' : 'strike-' + n;
        if (n >= 3) ch.terminated = { ...entry, after: 'three strikes' };
      }
      if (result === 'removed') {
        // The Google account can't make a new channel, so a removed creator can't just start over
        const acctKey = await findAccountOf(st, ch.id);
        if (acctKey) { const a = await st.get(acctKey); a.banned = true; await st.put(acctKey, a); }
      }
      await save();
      return { ok: true, result, standing: standing(ch) };
    }
    case 'reverse': {
      if (!ch) return { ok: false, reason: 'not-found' };
      for (const list of [ch.warnings || [], ch.strikes || []]) for (const x of list) if (x.id === b.entry) x.reversed = Date.now();
      if (ch.terminated && (b.entry === ch.terminated.id || b.entry === 'terminated')) {
        ch.terminated.reversed = Date.now();
        const acctKey = await findAccountOf(st, ch.id);
        if (acctKey) { const a = await st.get(acctKey); a.banned = false; await st.put(acctKey, a); }
      }
      await save();
      return { ok: true, standing: standing(ch) };
    }
    case 'appeals': {
      const out = [];
      for (const id of ((await st.get('appeals')) || []).slice().reverse()) { const a = await st.get('appeal:' + id); if (a) out.push(a); }
      return { ok: true, appeals: out };
    }
    case 'answer-appeal': {
      const a = await st.get('appeal:' + b.id);
      if (!a) return { ok: false, reason: 'not-found' };
      a.state = b.decision === 'reverse' ? 'reversed' : 'upheld';
      a.answer = clean(b.note, 600); a.answered = Date.now();
      await st.put('appeal:' + a.id, a);
      return { ok: true };
    }
    case 'pause': return { ok: true, paused: await bumpStats(env, (s) => { if (!s.paused.includes(b.id)) s.paused.push(b.id); return s.paused; }) };
    case 'unpause': return { ok: true, paused: await bumpStats(env, (s) => { s.paused = s.paused.filter((x) => x !== b.id); return s.paused; }) };
    case 'report-meta': return { ok: true, meta: (await st.get('repmeta:' + Number(b.number))) || null };
    case 'reports': return { ok: true, reporters: ((await st.get('rep:' + b.id)) || { reporters: {} }).reporters };
    default: return { ok: false, reason: 'unknown' };
  }
}

async function findAccountOf(st, channelId) {
  const s = (await st.get('owners')) || {};
  return s[channelId] ? 'g:' + s[channelId] : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } });
      if (p === '/v1/auth/start') return await authStart(req, env, url);
      if (p === '/v1/auth/callback') return await authCallback(req, env, url);
      if (p === '/v1/auth/poll') return await authPoll(env, url);
      if (p === '/demo-google' && env.DEMO_GOOGLE === '1') return demoGoogle(url);
      if (req.method === 'GET' && p === '/v1/me') return await meInfo(req, env);
      if (req.method === 'POST' && p === '/v1/channel') {
        const r = await setChannel(req.clone(), env);
        // Remember which Google account owns the channel (to stop a removed creator from starting over)
        if (r.ok) { const m = await me(req, env); if (m && m.ch) { const st = db(env); const o = (await st.get('owners')) || {}; o[m.ch.id] = m.sub; await st.put('owners', o); } }
        return r;
      }
      if (req.method === 'POST' && p === '/v1/submit') return await submit(req, env);
      if (req.method === 'GET' && p === '/v1/status') return await status(req, env, url);
      if (req.method === 'POST' && p === '/v1/report') return await report(req, env);
      if (req.method === 'POST' && p === '/v1/appeal') return await appeal(req, env);
      if (req.method === 'POST' && p === '/v1/follow') return await follow(req, env);
      if (req.method === 'POST' && p === '/v1/used') return await used(req, env);
      if (req.method === 'GET' && p === '/v1/stats') return await stats(env);
      if (req.method === 'POST' && p === '/v1/admin') {
        if (!env.ADMIN_TOKEN || req.headers.get('authorization') !== 'Bearer ' + env.ADMIN_TOKEN) return json({ ok: false, reason: 'forbidden' }, 403);
        return json(await admin(env, (await readJson(req)) || {}));
      }
      if (req.method === 'GET' && p === '/') return new Response('Hashikko store service', { headers: { 'content-type': 'text/plain' } });
      return json({ ok: false, reason: 'not-found' }, 404);
    } catch (e) {
      return json({ ok: false, reason: 'server' }, 502);
    }
  },
};
export { extractHtml, standing };
