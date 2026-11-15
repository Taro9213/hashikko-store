// Checks one Hashikko part (a single HTML file) before it can be listed in the store.
//   node tools/check-part.mjs path/to/part.html      → prints a JSON report, exit code 1 if it fails
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkPart } from './part-rules.mjs';
export * from './part-rules.mjs';

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const r = checkPart(readFileSync(process.argv[2], 'utf8'));
  const { html, ...report } = r;
  console.log(JSON.stringify(report, null, 2));
  process.exit(r.ok ? 0 : 1);
}
