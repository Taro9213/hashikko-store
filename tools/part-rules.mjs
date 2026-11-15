// The rules every store part must follow. Pure JavaScript with no Node or browser APIs,
// so the same file runs in the GitHub workflow, in the submission service, and by hand.

export const MAX_SIZE = 400000;                       // same limit as the app
export const ALLOWED_PERMISSIONS = ['storage', 'clipboard.write'];
export const RESERVED_IDS = ['shell', 'music', 'tidy', 'memo', 'settings', 'store', 'maker'];
const ID_RX = /^[a-z0-9_-]{1,40}$/;

// Things a store part must not contain. Parts run in a sandbox with no network,
// so these would either fail anyway or suggest the part is trying to do something it shouldn't.
const FORBIDDEN = [
  [/\bfetch\s*\(/, 'uses fetch() (parts cannot use the network)'],
  [/\bXMLHttpRequest\b/, 'uses XMLHttpRequest (parts cannot use the network)'],
  [/\bWebSocket\b/, 'uses WebSocket (parts cannot use the network)'],
  [/\bEventSource\b/, 'uses EventSource (parts cannot use the network)'],
  [/\bsendBeacon\b/, 'uses navigator.sendBeacon (parts cannot use the network)'],
  [/\bRTCPeerConnection\b/, 'uses WebRTC (parts cannot use the network)'],
  [/\bwindow\.open\s*\(|\bopen\s*\(\s*['"]https?:/, 'opens new windows'],
  [/\beval\s*\(/, 'uses eval()'],
  [/\bnew\s+Function\s*\(/, 'uses new Function()'],
  [/\bimportScripts\s*\(/, 'uses importScripts()'],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, 'uses browser storage (use hashikko storage instead)'],
  [/document\.cookie/, 'uses cookies'],
  [/<\s*(iframe|object|embed|frame|frameset)\b/i, 'embeds other pages (iframe/object/embed)'],
  [/<\s*form\b[^>]*\baction\s*=/i, 'submits a form to another address'],
  [/<\s*meta[^>]+http-equiv\s*=\s*["']?refresh/i, 'redirects with meta refresh'],
  [/<\s*base\b/i, 'uses a <base> tag'],
  [/\b(alert|confirm|prompt)\s*\(/, 'uses alert/confirm/prompt (they do not work in parts)'],
];

// Find http(s) addresses that are not Hashikko's own files
function externalUrls(html) {
  const found = new Set();
  for (const m of html.matchAll(/https?:\/\/[^\s"'<>)\\]+/gi)) {
    const u = m[0];
    if (/^https:\/\/app\.hashikko\//i.test(u)) continue;
    if (/^https?:\/\/www\.w3\.org\//i.test(u)) continue;   // SVG namespaces are fine
    found.add(u);
  }
  return [...found];
}

// Same extraction the app does: from <!doctype or <html to the last </html>
export function extractHtml(text) {
  const lower = text.toLowerCase();
  let a = lower.indexOf('<!doctype');
  if (a < 0) a = lower.indexOf('<html');
  const b = lower.lastIndexOf('</html>');
  if (a < 0 || b < a) return null;
  return text.slice(a, b + 7).replace(/<!--hashikko-csp-->[\s\S]*?<!--\/hashikko-csp-->/g, '');
}

export function checkPart(text) {
  const errors = [];
  const warnings = [];
  const html = extractHtml(text || '');
  if (!html) return { ok: false, errors: ['No HTML found. A part must be one complete HTML file.'], warnings };
  if (html.length > MAX_SIZE) errors.push(`Too large: ${html.length} characters (max ${MAX_SIZE}).`);

  const mm = html.match(/<script[^>]*id\s*=\s*["']hashikko-manifest["'][^>]*>([\s\S]*?)<\/script>/i);
  let manifest = null;
  if (!mm) errors.push('No manifest. Add <script type="application/json" id="hashikko-manifest">.');
  else {
    try { manifest = JSON.parse(mm[1]); } catch { errors.push('The manifest is not valid JSON.'); }
  }
  if (manifest) {
    const name = typeof manifest.name === 'object' ? (manifest.name.en || '') : manifest.name;
    if (!name || !String(name).trim()) errors.push('The manifest has no name.');
    if (String(name).length > 40) warnings.push('The name is long (over 40 characters).');
    if (!manifest.description) warnings.push('The manifest has no description.');
    const id = String(manifest.id || '').trim().toLowerCase();
    if (!ID_RX.test(id)) errors.push('The manifest id must be 1–40 lowercase letters, digits, "-" or "_".');
    if (RESERVED_IDS.includes(id)) errors.push(`The id "${id}" is reserved.`);
    const perms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    const bad = perms.filter((p) => !ALLOWED_PERMISSIONS.includes(p));
    if (bad.length) errors.push(`Permissions not allowed in the store: ${bad.join(', ')}. Allowed: ${ALLOWED_PERMISSIONS.join(', ')}.`);
    if (!manifest.emoji) warnings.push('The manifest has no emoji.');
  }

  if (!/https:\/\/app\.hashikko\/sdk\.js/.test(html)) errors.push('The part must load https://app.hashikko/sdk.js.');
  if (!/https:\/\/app\.hashikko\/base\.css/.test(html)) warnings.push('The part does not load https://app.hashikko/base.css, so it may not match light and dark mode.');
  for (const [rx, why] of FORBIDDEN) if (rx.test(html)) errors.push(`Not allowed: ${why}.`);
  const ext = externalUrls(html);
  if (ext.length) errors.push(`Links to other websites are not allowed: ${ext.slice(0, 5).join(', ')}${ext.length > 5 ? ' …' : ''}`);

  // Very long unreadable strings usually mean hidden code or embedded files
  const longest = Math.max(0, ...[...html.matchAll(/[A-Za-z0-9+/=]{1500,}/g)].map((m) => m[0].length));
  if (longest) warnings.push(`Contains a very long encoded string (${longest} characters). A reviewer will look at it closely.`);
  if (/\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){20,}/i.test(html) || /\\u[0-9a-f]{4}(\\u[0-9a-f]{4}){20,}/i.test(html)) warnings.push('Contains escaped text that may hide code. A reviewer will look at it closely.');
  // Things a computer can't judge, but a reviewer should look at closely
  const visible = html.replace(/<script[^>]*id\s*=\s*["']hashikko-manifest["'][^>]*>[\s\S]*?<\/script>/i, '');
  // The browser's random-number helpers (crypto.getRandomValues, crypto.randomUUID) are normal in dice and games, not about money
  const wordsToCheck = visible.replace(/\b(?:window\.|self\.|globalThis\.)?crypto\.(?:getRandomValues|randomUUID)\b/g, '');
  const domains = [...new Set([...visible.matchAll(/\b(?:www\.)?[a-z0-9-]{2,}\.(?:com|net|org|io|app|co|me|ly|xyz|info|biz|link|site|online|shop|top|ru|cn|jp)\b/gi)].map((m) => m[0].toLowerCase()))]
    .filter((d) => !/^app\.hashikko$/.test(d));
  if (domains.length) warnings.push(`Mentions website names (${domains.slice(0, 4).join(', ')}). Check it isn't sending people somewhere to be tricked.`);
  if (/password|passcode|log ?in|sign ?in|credit card|card number|bank account|social security|wallet|seed phrase|private key|bitcoin|crypto|gift card|verify your account/i.test(wordsToCheck))
    warnings.push('Mentions passwords, logins, payments or crypto. Check it isn\'t pretending to be a login or payment screen.');
  if (manifest && Array.isArray(manifest.permissions) && manifest.permissions.includes('clipboard.write'))
    warnings.push('Copies text. Check what it copies: it must be exactly what the person sees, never commands or links.');
  if (/\b(?:powershell|cmd\.exe|curl\s|wget\s|sudo\s|rm\s+-rf|Invoke-WebRequest|iex\b|bash\s+-c)/i.test(visible))
    warnings.push('Contains terminal commands. A part should never ask people to run commands.');
  if (!/hashikko\.onVisible\s*\(/.test(html)) warnings.push('The part never calls hashikko.onVisible(), so it may not know when the panel opens.');

  return { ok: errors.length === 0, errors, warnings, manifest, html };
}

