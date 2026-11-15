# Setting up the store

Three pieces, all on free plans:

| Piece | Where | What it does |
|---|---|---|
| This repository | GitHub (public) | The parts, `catalog.json` and `blocklist.json` the app downloads. GitHub Actions also publishes the store website with GitHub Pages. |
| The service (`service/`) | Cloudflare Workers + KV | Google sign-in, channels, sharing, reports, follows, use counts, warnings and strikes. Files submissions and reports here as issues. |
| The review desk (`tools/desk.mjs`) | Your own computer | Where you approve, decline, take down, and handle rule-breaks and appeals. |

All addresses are written into the apps by `set-addresses.mjs` in the project folder, so they can change later.

## 1. GitHub

1. Create a **public** repository named `hashikko-store` and push this folder to it.
2. Settings → **Pages** → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → **Variables**: add `SITE_URL` and `STATS_URL` (`set-addresses.mjs` prints the values).
4. Issues → Labels: create `submission`, `report`, `needs-changes`, `declined`, `listed`.
5. Create a **fine-grained personal access token** limited to `hashikko-store`, with **Issues: Read and write** only. You use it twice: as the service's `GITHUB_TOKEN`, and in `desk.secrets.json`. (You can make two tokens instead, one for each.)

## 2. Google sign-in

1. Google Cloud console → create a project → **APIs & Services → OAuth consent screen**: app name "Hashikko", user type **External**, scopes: only `openid` and `profile`.
2. **Credentials → Create credentials → OAuth client ID** → type **Web application**. Authorized redirect URI: `https://hashikko-store.<your-subdomain>.workers.dev/v1/auth/callback`.
3. Keep the client ID (goes into `addresses.json`) and the client secret (goes into Cloudflare as a secret).
4. While the consent screen is in **Testing**, only the Google accounts you list as test users can sign in. Add your friends there, or switch it to **In production** when you are ready for anyone to sign in.

## 3. Cloudflare

From `service/` (Node.js needed; `npx` downloads Wrangler the first time):

```
npx wrangler login
npx wrangler kv namespace create DB          (copy the id into addresses.json → kvNamespaceId)
node ../../set-addresses.mjs                 (fills wrangler.toml)
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put ADMIN_TOKEN          (a long random password, also used by the desk)
npx wrangler secret put RATE_SALT            (any long random text)
```

Check: opening `https://hashikko-store.<your-subdomain>.workers.dev/` shows "Hashikko store service".

## 4. The review desk

On your computer, in your clone of this repository:

1. Create `desk.secrets.json` (it is in `.gitignore`):
   ```json
   { "githubToken": "github_pat_…", "storeRepo": "<you>/hashikko-store",
     "serviceUrl": "https://hashikko-store.<your-subdomain>.workers.dev/", "adminToken": "<the ADMIN_TOKEN>" }
   ```
2. `node tools/desk.mjs` → open http://127.0.0.1:4360/desk

Approving or taking down a part commits and pushes from your clone, so `git push` must work there.

## Try everything on your computer first

`node tools/review-demo.mjs` runs the whole flow with a fake GitHub and a pretend Google sign-in (see REVIEW.md).
