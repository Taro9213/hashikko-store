// The review desk's logic, shared by the demo (tools/review-demo.mjs, fake GitHub in memory)
// and the real store (tools/desk.mjs, real GitHub issues and the real service).
//
// What it needs (see createDesk):
//   store    folder with parts/, blocklist.json, catalog.json
//   gh       { list(), labels(issue, add, remove), comment(issue, body), close(issue, reason) }
//            issues look like { number, title, body, labels: [{ name }], state, state_reason, created, comments: [{ body, at }] }
//   admin    async (body) → the service's /v1/admin answer
//   stats    async () → the service's /v1/stats answer
//   publish  async (message) → rebuild catalog and website, and (real store) commit and push
//
// Every decision leaves a comment starting with "Decision:" (the history), and, when there is a note for the creator,
// a comment starting with "Note:" (the creator sees it in Hashikko).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkPart } from './part-rules.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const section = (body, title) => {
  const i = body.indexOf('### ' + title);
  if (i < 0) return '';
  const rest = body.slice(i + title.length + 4);
  const j = rest.indexOf('\n### ');
  return (j < 0 ? rest : rest.slice(0, j)).trim();
};
// "Name (@handle) · id"
const channelOf = (s) => { const m = String(s || '').match(/^(.*) \(@([a-z0-9_.]+)\) · ([0-9a-f]{12})$/); return m ? { name: m[1], handle: m[2], id: m[3] } : null; };
const ACTIONS = { approve: 'Approved', changes: 'Asked for changes', decline: 'Declined', violation: 'Broke the rules', takedown: 'Taken down',
  dismiss: 'No action needed', pause: 'Paused (hidden from the store)', unpause: 'Back in the store' };
const RESULT = { warning: 'a warning', 'strike-1': 'strike 1 of 3 (no sharing for 1 week)', 'strike-2': 'strike 2 of 3 (no sharing for 2 weeks)',
  removed: 'channel removed', 'already-removed': 'channel was already removed' };

// The decision history, read back from the issue's comments
function historyOf(issue) {
  const out = [];
  for (const c of issue.comments || []) {
    const b = String(c.body || '').trim();
    if (/^decision:/i.test(b)) out.push({ action: b.replace(/^decision:\s*/i, ''), text: '', at: c.at || '' });
    else if (/^note:/i.test(b)) {
      const text = b.replace(/^note:\s*/i, '');
      if (out.length && !out[out.length - 1].text) out[out.length - 1].text = text; else out.push({ action: 'Note', text, at: c.at || '' });
    }
  }
  return out;
}

export function createDesk({ store, gh, admin, stats, publish }) {
  const metaOf = (id) => { const f = join(store, 'parts', id, 'meta.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  const listedParts = (channelId) => readdirSync(join(store, 'parts')).filter((id) => { const m = metaOf(id); return m && m.channel === channelId; });
  const isReport = (i) => i.labels.some((l) => l.name === 'report');

  function readSubmission(issue) {
    const codeBlock = section(issue.body, 'Part code');
    const html = codeBlock.replace(/^`{4,5}html\r?\n/, '').replace(/\r?\n`{4,5}$/, '');
    const r = checkPart(html);
    const labels = issue.labels.map((l) => l.name);
    const state = labels.includes('listed') ? 'listed' : labels.includes('declined') ? 'declined'
      : labels.includes('needs-changes') ? 'needs-changes' : 'reviewing';
    const channel = channelOf(section(issue.body, 'Channel'));
    return {
      number: issue.number, kind: 'submission', state, created: issue.created, channel,
      author: channel ? channel.name : section(issue.body, 'Your name as shown in the store'),
      html: r.html || html, ok: r.ok, errors: r.errors, warnings: r.warnings, manifest: r.manifest || {},
      notes: historyOf(issue),
      updating: state !== 'listed' && !!(r.manifest && existsSync(join(store, 'parts', r.manifest.id))),
    };
  }
  function readReport(issue) {
    return { number: issue.number, kind: 'report', state: issue.state === 'closed' ? 'done' : 'open', created: issue.created,
      id: section(issue.body, 'Part id'), reason: section(issue.body, 'What is wrong?'), details: section(issue.body, 'Details'),
      reporter: section(issue.body, 'Reported by (Hashikko ID)'), reporterChannel: channelOf(section(issue.body, 'Reporter\'s channel')),
      autoPaused: !!section(issue.body, 'Paused'), notes: historyOf(issue) };
  }

  // A channel: its record from the service, plus everything it sent and everything said about its parts
  async function personOf(channelId, items) {
    if (!channelId) return null;
    const c = await admin({ action: 'channel', channel: channelId });
    const subs = items.filter((x) => x.kind === 'submission' && x.channel && x.channel.id === channelId);
    const theirParts = new Set(listedParts(channelId));
    const reportsAgainst = items.filter((x) => x.kind === 'report' && theirParts.has(x.id));
    const reportsSent = items.filter((x) => x.kind === 'report' && x.reporterChannel && x.reporterChannel.id === channelId);
    const count = (list, st) => list.filter((x) => x.state === st).length;
    const acted = (r) => (r.notes || []).some((n) => /Taken down/.test(n.action));
    return {
      id: channelId, name: c.ok ? c.channel.name : (subs[0] && subs[0].author) || '', handle: c.ok ? c.channel.handle : '',
      created: c.ok ? c.channel.created : 0, standing: c.ok ? c.channel.standing : null,
      sent: subs.length, listed: count(subs, 'listed'), changes: count(subs, 'needs-changes'), declined: count(subs, 'declined'),
      reportsAgainst: reportsAgainst.length, takenDown: reportsAgainst.filter(acted).length,
      reportsSent: reportsSent.length, reportsActedOn: reportsSent.filter(acted).length,
    };
  }
  function reporterOf(reporterId, items) {
    const sent = items.filter((x) => x.kind === 'report' && x.reporter === reporterId);
    return { id: reporterId, reportsSent: sent.length, reportsActedOn: sent.filter((r) => (r.notes || []).some((n) => /Taken down/.test(n.action))).length };
  }

  async function record(issue, action, text, extra = '') {
    await gh.comment(issue, 'Decision: ' + (ACTIONS[action] || action) + (extra ? ` · ${extra}` : ''));
    if (text) await gh.comment(issue, 'Note: ' + text);
  }

  // Take parts out of the store and turn them off on every computer (files only; publish() sends them out)
  function takeDownFiles(ids, reason) {
    const file = join(store, 'blocklist.json');
    const bl = JSON.parse(readFileSync(file, 'utf8'));
    for (const id of ids) {
      if (!bl.parts.some((p) => p.id === id)) bl.parts.push({ id, reason: reason || 'It was removed from the store.' });
      rmSync(join(store, 'parts', id), { recursive: true, force: true });
    }
    writeFileSync(file, JSON.stringify(bl, null, 2) + '\n');
  }

  // A rule-break: warning → strikes → channel removed (all its parts come down)
  async function penalize(channelId, rule, note, severe, ref) {
    const r = await admin({ action: 'violation', channel: channelId, rule, note, severe, ref });
    if (!r.ok) return r;
    if (r.result === 'removed') {
      const theirs = listedParts(channelId);
      if (theirs.length) { takeDownFiles(theirs, 'Its creator\'s channel was removed for breaking the store rules.'); await publish(`Remove parts of a removed channel (${theirs.join(', ')})`); }
    }
    return r;
  }

  async function items() {
    const all = await gh.list();
    const list = all.map((i) => (isReport(i) ? readReport(i) : readSubmission(i))).sort((a, b) => b.number - a.number);
    const st = await stats();
    // Who reported is not in the public issue; the service keeps it for reviewers
    for (const it of list) {
      if (it.kind !== 'report' || it.reporter) continue;
      const meta = (await admin({ action: 'report-meta', number: it.number })).meta;
      if (meta) { it.reporter = meta.reporter; it.reporterChannel = meta.channel; }
    }
    for (const it of list) {
      if (it.kind === 'submission') it.person = await personOf(it.channel && it.channel.id, list);
      else {
        it.reporterInfo = reporterOf(it.reporter, list);
        if (it.reporterChannel) it.reporterInfo.channel = await personOf(it.reporterChannel.id, list);
        const m = metaOf(it.id);
        it.maker = m && m.channel ? await personOf(m.channel, list) : null;
        if (it.maker && !it.maker.name) { it.maker.name = m.author; it.maker.handle = m.handle || ''; }
        it.makerName = m ? m.author : '';
        it.paused = ((st && st.paused) || []).includes(it.id);
        it.reporters = (await admin({ action: 'reports', id: it.id })).reporters || {};
        it.uses = ((st && st.uses) || {})[it.id] || 0;
      }
    }
    const appeals = (await admin({ action: 'appeals' })).appeals || [];
    const channels = (await admin({ action: 'channels' })).channels || [];
    return { ok: true, items: list, appeals, channels };
  }

  async function act(a) {
    if (a.action === 'answer-appeal') {
      const ap = ((await admin({ action: 'appeals' })).appeals || []).find((x) => x.id === a.id);
      if (!ap) return { ok: false, reason: 'not-found' };
      if (!String(a.note || '').trim()) return { ok: false, reason: 'Write a short answer. The creator will see it.' };
      if (a.decision === 'reverse') {
        const [kind, ref] = String(ap.ref).split(':');
        if (kind === 'warning' || kind === 'strike') await admin({ action: 'reverse', channel: ap.channel, entry: ref });
        if (kind === 'removed') await admin({ action: 'reverse', channel: ap.channel, entry: 'terminated' });
      }
      return admin({ action: 'answer-appeal', id: a.id, decision: a.decision, note: a.note });
    }
    const i = (await gh.list()).find((x) => x.number === Number(a.number));
    if (!i) return { ok: false, reason: 'not-found' };
    const note = String(a.note || '').trim();
    if (!isReport(i)) {
      const s = readSubmission(i);
      if (a.action === 'approve') {
        if (!s.ok) return { ok: false, reason: 'The automatic checks failed. Ask for changes instead.' };
        if (!s.channel) return { ok: false, reason: 'This was sent without a channel.' };
        const id = s.manifest.id;
        const dir = join(store, 'parts', id);
        const old = metaOf(id);
        // Only the channel that first shared a part can update it
        if (old && (old.channel || old.owner) && old.channel !== s.channel.id) return { ok: false, reason: `"${id}" belongs to another channel. Decline this one.` };
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.html'), s.html);
        writeFileSync(join(dir, 'meta.json'), JSON.stringify({ id, author: s.channel.name, channel: s.channel.id, handle: s.channel.handle,
          issue: i.number, added: (old && old.added) || today(), updated: today(), reviewed: today(), keywords: (old && old.keywords) || [] }, null, 2) + '\n');
        await publish(`${old ? 'Update' : 'Add'} part ${id} (#${i.number})`);
        await gh.labels(i, ['listed'], ['needs-changes', 'declined']);
        await record(i, 'approve', note);
        await gh.close(i, 'completed');
        return { ok: true };
      }
      if (a.action === 'changes' || a.action === 'decline' || a.action === 'violation') {
        if (!note) return { ok: false, reason: 'Write a short note so the creator knows why.' };
        let extra = '';
        if (a.action === 'violation') {
          if (!a.rule) return { ok: false, reason: 'Pick which rule it breaks.' };
          const r = await penalize(s.channel && s.channel.id, a.rule, note, !!a.severe, `decision:${i.number}`);
          if (!r.ok) return r;
          extra = `${a.rule} → ${RESULT[r.result] || r.result}`;
        }
        await gh.labels(i, [a.action === 'changes' ? 'needs-changes' : 'declined'], ['needs-changes', 'declined', 'listed']);
        await record(i, a.action, note, extra);
        if (a.action !== 'changes') await gh.close(i, 'not_planned');
        return { ok: true, result: extra };
      }
    } else {
      const r = readReport(i);
      if (a.action === 'pause' || a.action === 'unpause') { await admin({ action: a.action, id: r.id }); await record(i, a.action, ''); return { ok: true }; }
      if (a.action === 'takedown') {
        const m = metaOf(r.id);
        let extra = '';
        if (a.rule && m && m.channel) {
          const p = await penalize(m.channel, a.rule, note, !!a.severe, `report:${i.number}`);
          if (p.ok) extra = `${a.rule} → ${RESULT[p.result] || p.result}`;
        }
        if (existsSync(join(store, 'parts', r.id)) || !JSON.parse(readFileSync(join(store, 'blocklist.json'), 'utf8')).parts.some((p) => p.id === r.id)) {
          takeDownFiles([r.id], note);
          await publish(`Take down part ${r.id} (#${i.number})`);
        }
        await admin({ action: 'unpause', id: r.id });
        await record(i, 'takedown', note, extra);
        await gh.close(i, 'completed');
        return { ok: true, result: extra };
      }
      if (a.action === 'dismiss') {
        await admin({ action: 'unpause', id: r.id });
        await record(i, 'dismiss', note);
        await gh.close(i, 'not_planned');
        return { ok: true };
      }
    }
    return { ok: false, reason: 'unknown action' };
  }

  return { items, act };
}
