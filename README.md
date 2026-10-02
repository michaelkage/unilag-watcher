# unilag-watcher

Delta-tracking watcher for University of Lagos public feeds. Notifies you on Telegram
when news appears or an existing post (e.g. an exam timetable) is **amended**.

Zero runtime dependencies. Runs on GitHub Actions every 30 minutes. State lives in
`state.json`, committed back to the repo.

## How it works

Each run fetches the RSS feeds in `sources.json`, then for every post compares a
SHA-256 fingerprint of its content against `state.json`:

| Condition | Result |
| --- | --- |
| Post ID not in state | 🆕 NEW |
| Post ID present, fingerprint differs | ✏️ UPDATED |
| Post ID present, fingerprint matches | no alert |

Posts are keyed by WordPress post ID (`?p=80541`), not URL — URLs change when a slug
is edited, IDs do not. The fingerprint is taken over tag-stripped text, so cosmetic
whitespace edits don't trigger alerts but real text changes do.

Any post containing a `.pdf` link has the direct PDF URL included in the alert.

### Guarantees

- **State advances only after a successful Telegram send.** If delivery fails, state
  is not written and the next run retries the same alert.
- **A feed failure never loses data.** If one source errors, its state is left
  untouched and only that source is retried next run.

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
- RSS exposes only the most recent ~10 items per feed. A post edited *after* it falls
  off the feed will not be detected.
- The keyword sources are WordPress *search* results, so loosely-related posts can
  appear. Tighten with `keywords` if that becomes noisy.

## Files

| File | Purpose |
| --- | --- |
| `watch.mjs` | the entire watcher — fetch, parse, diff, notify, save |
| `sources.json` | feeds to monitor and per-source keyword filters |
| `state.json` | last-seen cache, committed by CI after each run |
| `.github/workflows/watch.yml` | 30-minute cron + state commit-back |