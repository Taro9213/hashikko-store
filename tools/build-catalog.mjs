// Builds catalog.json from parts/<id>/index.html + parts/<id>/meta.json.
// The app downloads catalog.json, and checks each part's sha256 before adding it.
//   node tools/build-catalog.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPart } from './check-part.mjs';

// HASHIKKO_STORE_ROOT: build a copy of the store somewhere else (the review demo uses this)
const root = process.env.HASHIKKO_STORE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const partsDir = join(root, 'parts');
const text = (v) => (v && typeof v === 'object' ? v.en || '' : v || '');
// A public id for the person who made a part, used for their page in the store (creators/<id>.html).
// Parts sent from the app: the first 12 characters of the owner hash (the hash can't be turned back into the key).
export function creatorOf(meta) {
  if (/^[0-9a-f]{12}$/.test(String(meta.channel || ''))) return meta.channel;   // a channel (signed in with Google)
  const o =String(meta.owner || (meta.github ? `gh:${meta.github}` : 'hashikko'));
  if (o === 'hashikko') return 'hashikko';
  if (o.startsWith('key:')) return o.slice(4, 16);
  if (o.startsWith('gh:')) return 'gh-' + o.slice(3).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return 'unknown';
}
const parts = [];
let failed = 0;

for (const id of readdirSync(partsDir).sort()) {
  const file = join(partsDir, id, 'index.html');
  if (!existsSync(file)) continue;
  const html = readFileSync(file, 'utf8');
  const r = checkPart(html);
  if (!r.ok || r.manifest.id !== id) {
    failed++;
    console.error(`✗ ${id}: ${r.ok ? `folder name must match manifest id "${r.manifest.id}"` : r.errors.join(' ')}`);
    continue;
  }
  const meta = existsSync(join(partsDir, id, 'meta.json')) ? JSON.parse(readFileSync(join(partsDir, id, 'meta.json'), 'utf8')) : {};
  const m = r.manifest;
  parts.push({
    id,
    name: text(m.name),
    description: text(m.description),
    emoji: m.emoji || '🧩',
    version: m.version || '1.0.0',
    author: meta.author || 'Unknown',
    creator: creatorOf(meta),
    ...(meta.handle ? { handle: meta.handle } : {}),
    added: meta.added || '',   // when it first went into the store ("New" for 14 days)
    keywords: meta.keywords || m.keywords || [],
    permissions: m.permissions || [],
    keyboard: !!m.keyboard,
    sha256: createHash('sha256').update(html, 'utf8').digest('hex'),
    size: Buffer.byteLength(html, 'utf8'),
    updated: meta.updated || '',
    ...(meta.issue ? { issue: meta.issue } : {}),
    ...(meta.reviewed ? { reviewed: meta.reviewed } : {}),
    // Looks like other parts (ids), and what this one does more, in one line written by the reviewer
    ...(meta.differs ? { like: meta.like || [], differs: meta.differs } : {}),
    ...(meta.sample ? { sample: true } : {}),   // made-up example for testing. Remove before the store goes public
  });
  console.log(`✓ ${id}`);
}

const catalog = { version: 1, parts };
writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`catalog.json: ${parts.length} part(s)` + (failed ? `, ${failed} skipped` : ''));
process.exit(failed ? 1 : 0);
