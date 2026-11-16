// Finds parts already in the store (or built into Hashikko) that a new part looks like.
// The review desk shows them, so the reviewer can decide (store rules: "Parts that do the same job"):
//   copy           most of the code is the same as another creator's part → decline
//   same channel   this creator already has a part that does this → ask them to update that one
//   other creator  OK only if it clearly does something more; the reviewer writes that in one line
// It is only a hint. The words it compares are the name, description and keywords.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkPart } from './part-rules.mjs';

// Parts that come with Hashikko (not in the catalog: they are inside the app)
export const BUILTINS = [
  { id: 'memo', name: 'Notes', emoji: '📝', description: 'Quick notes, one edge away', keywords: ['memo', 'note', 'write'] },
  { id: 'music', name: 'Music', emoji: '🎵', description: 'Control Spotify, YouTube and more from anywhere', keywords: ['song', 'player', 'playlist'] },
  { id: 'tidy', name: 'Tidy', emoji: '✨', description: 'Clean up your screen with one click before sharing', keywords: ['hide', 'windows', 'screen share'] },
];

const STOP = new Set(('a an and the of to in on for with your you it its them this that from by or as at is are be one any all more then ' +
  'just quick quickly fast easy simple small tiny little new my me up down off out away keep make lets let use using edge hashikko part tool app').split(' '));
// Words that mean the same thing for this purpose
const SAME = { task: 'todo', tasks: 'todo', checklist: 'todo', todos: 'todo', memo: 'note', memos: 'note', notes: 'note', notepad: 'note',
  stopwatch: 'timer', countdown: 'timer', pomodoro: 'timer', calculate: 'calculator', calc: 'calculator', math: 'calculator',
  song: 'music', songs: 'music', player: 'music', characters: 'count', words: 'count', word: 'count', clock: 'time', zone: 'time' };

// Words that name a kind of tool
const KINDS = new Set(Object.values(SAME).concat(['clipboard', 'translate', 'dictionary', 'weather', 'converter', 'password', 'color', 'calendar']));

export function wordsOf(...texts) {
  const out = new Set();
  const s = texts.flat().map((t) => (t && typeof t === 'object' ? t.en || '' : String(t || ''))).join(' ').toLowerCase()
    .replace(/to-?dos?\b/g, 'todo');
  for (let w of s.split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    w = SAME[w] || w;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(SAME[w] || w);
  }
  return out;
}

// The code's shape: identifiers and words, ignoring spacing and the manifest (so a renamed copy still matches)
function codeOf(html) {
  const body = String(html || '').replace(/<script[^>]*id=["']hashikko-manifest["'][^>]*>[\s\S]*?<\/script>/i, '');
  const toks = body.match(/[A-Za-z_$][\w$]{2,}/g) || [];
  const grams = new Set();
  for (let i = 0; i + 3 <= toks.length; i++) grams.add(toks.slice(i, i + 3).join(' '));
  return grams;
}
const overlap = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

// manifest: the new part's manifest. html: its code. channel: its channel id. store: the store folder.
export function similarParts({ manifest, html, channel, store }) {
  const id = manifest.id;
  const mine = wordsOf(manifest.name, manifest.description, manifest.keywords || []);
  const code = codeOf(html);
  const catalog = existsSync(join(store, 'catalog.json')) ? JSON.parse(readFileSync(join(store, 'catalog.json'), 'utf8')).parts : [];
  const metaOf = (pid) => { const f = join(store, 'parts', pid, 'meta.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; };
  const others = [
    ...BUILTINS.map((b) => ({ ...b, author: 'Hashikko', official: true })),
    ...catalog.map((p) => ({ ...p, official: p.creator === 'hashikko', channel: metaOf(p.id).channel || '' })),
  ];
  // Parts in the folder that are not in the catalog yet (just approved) count too
  for (const pid of existsSync(join(store, 'parts')) ? readdirSync(join(store, 'parts')) : []) {
    if (others.some((o) => o.id === pid)) continue;
    const f = join(store, 'parts', pid, 'index.html');
    if (!existsSync(f)) continue;
    const r = checkPart(readFileSync(f, 'utf8'));
    if (!r.ok) continue;
    const m = metaOf(pid);
    others.push({ id: pid, name: r.manifest.name, description: r.manifest.description, keywords: m.keywords || [], author: m.author || '',
      official: !m.channel, channel: m.channel || '' });
  }
  const out = [];
  for (const o of others) {
    if (o.id === id) continue;   // an update to the same part
    const theirs = wordsOf(o.name, o.description, o.keywords || []);
    const shared = [...mine].filter((w) => theirs.has(w));
    const wordScore = shared.length / Math.max(1, Math.min(mine.size, theirs.size));
    let codeScore = 0;
    const f = join(store, 'parts', o.id, 'index.html');
    if (existsSync(f)) {
      const oc = codeOf(readFileSync(f, 'utf8'));
      codeScore = overlap(code, oc) / Math.max(1, Math.min(code.size, oc.size));
    }
    const copy = codeScore >= 0.8;
    // Or both names say the same kind of tool ("Daily tasks" and "To-do" are both to-do lists)
    const myName = wordsOf(manifest.name), theirName = wordsOf(o.name);
    const sameKind = [...myName].some((w) => KINDS.has(w) && theirName.has(w));
    if (!copy && !sameKind && !(shared.length >= 2 && wordScore >= 0.4)) continue;
    out.push({
      id: o.id, name: typeof o.name === 'object' ? o.name.en : o.name, emoji: o.emoji || '🧩',
      by: o.official ? 'Hashikko' : o.author, official: !!o.official,
      sameChannel: !!channel && o.channel === channel,
      copy, shared, wordScore: Math.round(wordScore * 100) / 100, codeScore: Math.round(codeScore * 100) / 100,
    });
  }
  return out.sort((a, b) => (b.copy - a.copy) || (b.codeScore + b.wordScore) - (a.codeScore + a.wordScore)).slice(0, 5);
}
