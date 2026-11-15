# Hashikko Store

This repository is the store for [Hashikko](https://github.com/Taro9213/hashikko-store): small tools ("parts") that slide out from the edge of your screen.

Every part here is one HTML file. The Hashikko app downloads `catalog.json`, shows the parts, and adds the ones you choose.

## Share a part you made

1. In Hashikko, open **＋ → Find a part → Made by you**, and click **Share** on your part.
2. The first time, sign in with Google and choose your **channel** name and @handle. People in the store only ever see your channel, never your Google name or email.
3. Check the boxes and click **Submit for review**. Automatic checks run first, then a person reviews it against the [Guidelines](GUIDELINES.md).
4. You see the result in Hashikko: In review, Needs changes (with a note), In the store, or Not accepted.
5. Once approved, it appears in everyone's store under your channel. People can follow your channel, and you can see how many people use your parts.

To update your part, share it again. Only the channel that first shared a part can update it.

## Report a part

In Hashikko's store, click **Report** on any part (sign-in needed, so every report has a person behind it). If three people report a part as harmful or a scam, it is hidden from the store until a reviewer decides. If a part is removed for safety reasons, Hashikko also turns it off on computers that already added it.

## Rules and what happens when they're broken

The first rule-break is a warning. After that, each one is a strike: strike 1 pauses sharing for a week, strike 2 for two weeks, and a third strike within 90 days removes the channel and its parts. Scams, fake logins, malware and sexual content involving minors remove the channel at once, and that Google account can't make a new one. Creators can appeal any decision from Hashikko.

## How safety works

- Parts run in a sandbox. They cannot connect to the internet, read your files, or see other parts.
- Store parts can only save their own data and copy text.
- Every part is checked automatically and reviewed by a person before it is listed. Updates are reviewed too.
- `blocklist.json` lists parts that were removed. The app checks it and turns those parts off.

## For maintainers

- Setting up: [SETUP.md](SETUP.md). Reviewing: [REVIEW.md](REVIEW.md).
- `parts/<id>/index.html` is the part, `parts/<id>/meta.json` its channel and dates. `catalog.json` is built from `parts/` (never edit it by hand). `blocklist.json` lists removed parts.
- Check a part by hand: `node tools/check-part.mjs path/to/part.html`
