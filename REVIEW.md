# Reviewing parts

## The flow

```
Creator (in Hashikko)          Submission service             Reviewer                     Everyone
─────────────────────          ──────────────────             ────────                     ────────
Share to store ──────────────▶ automatic checks ──┐
                               (fails → creator    │
                                sees the errors)   └──▶ issue "Submit: …" (label: submission)
"In review"                                              │
                                                         ├─ Ask for changes + note ──▶ creator sees "Needs changes" + note
                                                         │                              → fixes with AI, shares again (new issue)
                                                         ├─ Decline + note ──────────▶ creator sees "Not accepted" + note
                                                         └─ Approve ─────────────────▶ part goes into parts/<id>/
"In the store"  ◀────────────────────────────────────────────────────────────────────── catalog.json + website rebuilt
                                                                                        → anyone can add it

Someone reports a part ──────▶ issue "Report: <id>" (label: report)
                                                         ├─ Take down ──▶ blocklist.json → turned off on every computer
                                                         └─ No action
```

## Review points (all four before approving)

1. It does what its name and description say, and nothing else.
2. It works: try it. The main button does its job, nothing is broken.
3. Nothing harmful or misleading: no hate, no sexual content, no fake login screens, no personal information.
4. It's the creator's own work: no one else's name, logo or copied tool.

Notes to the creator are short and kind, and say what to change. They are shown in the creator's Hashikko.

## Where each step happens

Both use the same desk (`tools/review-desk.html`) and the same decision logic (`tools/desk-core.mjs`).

| | Demo on this computer | Real store |
|---|---|---|
| Start | `node tools/review-demo.mjs` → http://127.0.0.1:4330/desk | `node tools/desk.mjs` → http://127.0.0.1:4360/desk (setup: SETUP.md) |
| Submissions and reports | Fake GitHub in memory | Issues labeled `submission` / `report` on GitHub |
| Approve / take down | Changes a copy of the store in `.demo/` | Changes `parts/` and `blocklist.json`, then commits and pushes; GitHub rebuilds the catalog and website |
| Warnings, strikes, appeals, channels | The service code, in memory | The service on Cloudflare (`/v1/admin`, with ADMIN_TOKEN) |
| Sign-in | A pretend Google page | Google |

Every decision is written on the issue as a comment starting with `Decision:`. A note to the creator is a comment starting with `Note:`, and the creator sees it in Hashikko.

## Knowing who sent it

- Sharing and reporting need Google sign-in and a channel. The desk shows the channel name and @handle, never the Google name or email (the service doesn't keep them).
- The desk shows each channel's history: parts sent, listed, declined, reports about its parts, reports it sent (and how many led to a takedown), warnings and strikes. Use it to spot people who abuse sharing or reporting.
- A removed channel's Google account can't make a new channel.

## Sample data

The demo adds a made-up creator (Maya Chen, `tools/demo-sample/`) so the demo store looks lived-in. It is never in the real store.
