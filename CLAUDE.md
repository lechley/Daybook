# Daybook

Daybook is a private daily journal that installs to the iPhone Home Screen as a web app (PWA). There is no app store build. It is owned by Scott (GitHub `lechley`); Harry also uses the same site with his own account.

- Live site: https://daybook-alpha-amber.vercel.app (Vercel project `daybook`, deploys automatically from `main`).
- Install: open the site in Safari, Share, Add to Home Screen. Only the device owner can do this.
- Current version: 1.6.0 (see `VERSION` in `app.js`).
- A planned custom address, journal.lechley.com, is not set up yet. Moving to it changes the site's origin, so on-device data does not follow; sync must be in place first.

## Code layout

Plain HTML, CSS and JavaScript. No framework, no bundler, no build step, no package.json, no tests. Serve the folder as static files over HTTPS.

| File | What it holds |
| --- | --- |
| `index.html` | All markup: Today, Journal and More tabs, sheets, welcome card, lock screen. |
| `app.js` | The app. Date helpers, the IndexedDB layer (`DB`), Markdown import/export and zip reader/writer, Today page rendering, receipts, Journal tab (On this day, weekly review), More tab, passcode lock (`Lock`). |
| `sync.js` | Backup and sync (`Sync`). Loaded after `app.js`; wraps `DB.putDay`/`deleteDay`/`putPhoto`/`deletePhoto` to track changes, then pushes and pulls through Supabase. Also sends receipts through the `send-receipt` edge function. |
| `styles.css` | iOS-style look: grey background, white cards, light and true-black dark mode. |
| `sw.js` | Service worker. Network first, cache fallback for offline. |
| `manifest.webmanifest`, `icons/` | Home Screen name and icon ("Bookmark D": white D, amber bookmark, on blue). |

## Data model

- On the device: IndexedDB database `daybook` with stores `days` (key `date`, `YYYY-MM-DD`) and `photos` (key `id`, indexed by `date`). Settings live in `localStorage` under `daybook.*` keys.
- A day is `{ date, log: [{ id, time, text, ... }], notes, conversations, media, endOfDay, updatedAt }` (see `blankDay` in `app.js`).
- Export (More, Export everything) produces a zip laid out as `journal/YYYY-MM-DD.md` plus `journal/media/YYYY-MM-DD/`. Each page has `## Log`, `## Notes`, `## Conversations`, `## Media`, `## End of day`. Import accepts those pages or a zip of them and merges without duplicates. The same layout is used by the Claude project journal, so files move between the two.

## Backup and sync (since 1.4.0)

- Supabase project `daybook` (West EU, London), separate from any business database. The project URL and public anon key are in `sync.js`; the anon key is meant to be public and is protected by row level security.
- Tables used by the app: `days`, `photos`, `profiles` (holds the user's Dext address), all scoped per user with RLS. Photos are files in the private Storage bucket `photos` at `<user_id>/<photo_id>`.
- Accounts are created inside the app (More, Backup and sync) with an invite code, through the `daybook_signup` RPC. Sign-in is email and password. Magic links are deliberately not used because they break inside a Home Screen app.
- There is no password reset email; resets are done by hand in Supabase on request.
- The SQL schema and the `send-receipt` edge function are not in this repo; they live in the Supabase project. Check there before changing sync.

## Receipts (since 1.5.0)

- Receipt button on Today: photo plus note, saved to the journal and sent to Dext for the accountant.
- The Dext email-in address is entered by the user under More, Receipts. It must never be written into the code or this repo.
- With sync, receipts can go automatically through the `send-receipt` edge function, which emails from receipts@lechley.com via Resend. Without it, the app falls back to the iPhone share sheet.

## Making a release

1. Bump `VERSION` in `app.js` and `CACHE` in `sw.js` to the same number, so installed apps pick up the update.
2. If an icon changes, bump the `?v=` query on the icon links in `index.html`.
3. Commit as `vX.Y.Z: <what changed>` and push to `main`; Vercel deploys it.
4. Keep the copy in the Claude project files (`journal-app/`) in step when working from the Journal project.

## Rules

- Never commit secrets or personal details: no invite codes, Dext address, API keys (including the Resend key, which belongs only in Supabase secrets), passwords or service role keys. The site serves this code to anyone who opens it.
- Keep it dependency free and buildless unless Scott asks otherwise.
- Changes to the IndexedDB layout need an upgrade path (`indexedDB.open('daybook', N)`), because existing journals live only on the phone until sync is on.

## Open items (as of 22 Nov 2026)

- Scott has not yet created his sync account, so his entries live only on his phone. Removing the Home Screen app before signing in to sync deletes them.
- Automatic receipts need Resend set up (account, verify lechley.com, API key stored as a Supabase secret). A real receipt arriving in Dext is still untested.
- journal.lechley.com: add the domain in Vercel and the DNS record, after sync is on.
