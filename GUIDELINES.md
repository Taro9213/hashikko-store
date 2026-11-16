# Hashikko Store Guidelines

Hashikko parts are small tools that help people finish a quick task without leaving what they are doing. These rules keep the store useful and safe for everyone.

## What makes a good part

- **No searching, no switching, done in place.** The task is finished inside the panel. A part that only opens another app or website is not accepted.
- **Useful the moment it opens.** No sign-up, no long instructions.
- **Honest.** The name, description and emoji say what the part really does.
- **In English.** Other languages are welcome inside the part if English is also available.

## Not allowed

- Hateful, harassing, violent, or sexual content. Anything that sexualizes minors is removed and reported to the authorities.
- Anything that tries to trick people: fake login screens, fake system warnings, scams, or asking for passwords, card numbers or other personal details.
- Copying someone else's work, brand name or logo without permission.
- Personal information about real people.
- Hidden or deliberately unreadable code.
- Network access, other websites, pop-up windows, `alert()`, browser storage, and other things the automatic checks reject. Parts run in a sandbox, so these would not work anyway.
- Permissions other than `storage` and `clipboard.write`.

## Parts that do the same job

Different people may make parts for the same task, like two to-do lists. That's welcome, as long as each one adds something.

- **A copy of another creator's part** (the same code with a new name) is not accepted.
- **If you already have a part that does this, update it** instead of sharing a second one.
- **If someone else's part already does this**, yours is accepted when it clearly does something more. The reviewer writes that in one line (for example "＋ Adds a progress bar"), and it is shown on your part's page, next to the part it looks like, so people can compare.
- A look-alike part that hasn't been updated for six months and few people use moves to the bottom of the lists.

## Technical rules

- One HTML file, up to 400,000 characters, with all CSS and JavaScript inside.
- Must load `https://app.hashikko/sdk.js` and should load `https://app.hashikko/base.css`.
- Must include a manifest: `<script type="application/json" id="hashikko-manifest">` with `id`, `name`, `description`, `emoji`, `version` and `permissions`.
- The `id` uses only lowercase letters, digits, `-` and `_`, and is not one of: shell, music, tidy, memo, settings, store, maker.

## Review and removal

- Every new part and every update is checked automatically and reviewed by a person before it is listed.
- Anyone can report a part. Parts that break these Guidelines are removed. Parts removed for safety reasons are also turned off on computers that already added them.
- Repeated or serious violations mean we stop accepting parts from that account.
- Copyright owners can ask for removal by opening a **Report a part** issue.

These Guidelines may change as the store grows.
