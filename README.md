# unilag-watcher

[![watcher status](https://github.com/michaelkage/unilag-watcher/actions/workflows/watch.yml/badge.svg)](https://github.com/michaelkage/unilag-watcher/actions/workflows/watch.yml)

Delta-tracking watcher for University of Lagos public feeds. Notifies you on Telegram
when news appears or an existing post (e.g. an exam timetable) is **amended**.

Zero runtime dependencies. Runs on GitHub Actions every 30 minutes. State lives in
`state.json`, committed back to the repo.

## How it works

Each run fetches the RSS feeds in `sources.json`, then compares a SHA-256 fingerprint
of each matching post against `state.json`. Timetable, schedule, examination, lecture,
academic-calendar, and PDF-bearing posts are tagged for targeted deep-polling:

| Condition | Result |
| --- | --- |
| Post ID not in state | 🆕 NEW |
| Post ID present, fingerprint differs | ✏️ UPDATED |
| Post ID present, fingerprint matches | no alert |

Posts are keyed by WordPress post ID (`?p=80541`), not URL — URLs change when a slug
is edited, IDs do not. The fingerprint is taken over tag-stripped text, so cosmetic
whitespace edits don't trigger alerts but real text changes do.

The feeds carry **full post bodies**, not excerpts — none of UNILAG's items use the
`<!--more-->` truncation marker, so an amended timetable is detected wherever in the
post it was changed.

Any post containing a `.pdf` link has the direct PDF URL included in the alert.

### Priority deep-polling

High-priority posts are checked directly by immutable WordPress post ID for 60 days
after first discovery, including while they remain in the RSS window. The human-facing
permalink is stored separately because its slug can change. RSS and direct-page hashes are
stored independently so differences in feed/article rendering cannot create false alerts.
Linked PDFs hosted on UNILAG are also fingerprinted by their file bytes, so replacing a
timetable PDF at the same URL is detected even when the WordPress article itself is unchanged.
Older state entries without priority metadata are checked once (when they have a numeric
WordPress post ID) to classify and migrate the existing cache. Requests are limited to four
concurrent posts, time out after 15 seconds, and use `ETag` / `Last-Modified` validators
when the server provides them. Feed, article, and PDF redirects are followed manually, with a maximum of three hops, and every destination must remain on an exact HTTPS UNILAG host. UNILAG-hosted PDFs are limited to 25 MiB per file; external
PDFs are tracked by URL but not downloaded. A failed article fetch never changes saved fingerprints. A failed PDF check retains its last verified hash (or a pending marker for a newly discovered attachment), so it cannot suppress an independently detected article change and is retried on the next run. HTTP 304 article responses still revalidate linked PDFs before treating a post as unchanged. Non-priority legacy posts are marked so they
do not consume requests on later runs.

### Guarantees

- **State advances only after a successful Telegram send.** If delivery fails, state
  is not written and the next run retries the same alert.
- **A feed failure never loses data.** If one source errors, its state is left
  untouched and only that source is retried next run.
- **State is bounded.** Posts unseen for 180 days are pruned, so `state.json` cannot
  grow without limit. Feeds only ever expose a recent window, so anything older can no
  longer be compared against anything.

## Setup

### 1. Telegram bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. Open your bot, press Start (required, or it cannot message you).
3. Get your chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`.

### 2. GitHub secrets

Add both under **Settings → Secrets and variables → Actions**:

| Name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | token from BotFather |
| `TELEGRAM_CHAT_ID` | your numeric chat ID |

Until both are set, every scheduled run is a **no-op**: the workflow skips the check
and posts a warning annotation instead of failing, so the run history stays green. No
state is written while unconfigured, so nothing is missed once you add them.

### 3. Seed the baseline

The first run would otherwise alert on ~35 existing posts. Record a baseline without
sending anything:

```bash
npm run seed
git add state.json && git commit -m "chore: seed watcher state"
git push
```

The workflow then starts alerting only on genuine changes.

## Local development

```bash
npm run dry     # fetch + diff, print what would be sent, write nothing
npm run watch   # actually send (needs secrets in env)
npm run seed    # record baseline, send nothing
npm test        # unit tests for the delta logic
```

Pass secrets via a `.env` file (gitignored) using Node's built-in loader:

```bash
node --env-file=.env watch.mjs --dry-run
```

## Adding a source

Any WordPress search works as a feed. Append to `sources.json`:

```json
{
  "id": "gst",
  "label": "GST Notices",
  "url": "https://unilag.edu.ng/search/gst+notice/feed/rss2/",
  "keywords": []
}
```

`keywords` is optional and defaults to empty, meaning "trust the feed". Populate it
with lowercase terms (e.g. `["timetable", "time table"]`) to require that at least one
appears in the title or body. Left empty by default because a missed real timetable is
worse than a bit of noise.

## Known limits

- The `www.unilag.edu.ng` TLS certificate is broken (cert does not cover `www`), so
  all sources use the apex `unilag.edu.ng`.
- `portal.unilag.edu.ng` returns 403 to non-browser clients, so portal-gated content
  is not reachable by this watcher.
- RSS exposes only the most recent ~10 items per feed. Priority deep-polling closes this blindspot for posts identified as high-priority and first seen within the preceding 60 days. It cannot guarantee detection if UNILAG deletes a post, blocks requests, or serves an incomplete article page.
- The keyword sources are WordPress *search* results, so loosely-related posts can
  appear. Tighten with `keywords` if that becomes noisy.

## Files

| File | Purpose |
| --- | --- |
| `watch.mjs` | the entire watcher — fetch, parse, diff, notify, save |
| `sources.json` | feeds to monitor and per-source keyword filters |
| `state.json` | last-seen cache, committed by CI after each run |
| `test.mjs` | unit tests covering parsing, fingerprinting and message splitting |
| `.github/workflows/watch.yml` | 30-minute cron + state commit-back |
| `.github/workflows/test.yml` | Unit tests on pushes and pull requests |