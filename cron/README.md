# Cloudflare Worker cron — the 24/7 scheduler

Telegram Serverless has no timer, so nothing gets checked while your chat is
idle. This Worker is a Cron Trigger that runs every 10 minutes, looks for new
videos on the monitored accounts and posts them to your chat with the bot token.

It watches **posts and reposts alike**, and one added account covers both.

Reposts are ordered by *when they were reposted* but carry the **original**
tweet's id, so anything id-based can never see them: a page of reposts always
looks older than the newest id in it. (That was a real bug here — a repost-only
account like @Sentoyun would deliver nothing at all.) What decides "new" is
therefore the sent-video set, keyed by `tweetId:mediaId`, which also dedupes the
same video across accounts. The per-account pointer is only a bookmark, and the
first run for an account records what is already in the timeline (posts and
reposts) so adding an account never dumps its archive.

Delivery is the same as the bot's: an mp4 with a thumbnail while the file fits
the Bot API's 50 MB upload limit, otherwise a poster with a **▶️ Play** button
that streams the original file inside Telegram.

## Deploy

```bash
cd cron
npx wrangler@latest login                      # or export CLOUDFLARE_API_TOKEN
npx wrangler@latest kv namespace create STATE  # put the returned id in wrangler.toml
npx wrangler@latest secret put BOT_TOKEN       # the @MehranHornyBot token
npx wrangler@latest secret put ADMIN_KEY       # any long random string
npx wrangler@latest deploy                     # prints the URL, registers the cron
```

Logs: `npx wrangler tail`. The currently deployed worker is
`https://topav-monitor.reyhaneh-fc0.workers.dev`.

## Accounts follow the bot

Adding, renaming, pausing or deleting an account in the Telegram bot pushes the
enabled list here (`tgcloud/lib/cron.js` → `POST /accounts`). The bot needs the
admin key once: send `/cronkey <key>` in the chat (it is stored in the bot's
database, never in code). `/cronkey` on its own shows the cron's URL, the last
run and how many videos it has recorded.

## Control endpoints

All need `?key=<ADMIN_KEY>`:

| Request | Effect |
|---|---|
| `GET /` | Accounts, pointers, seen-video count, last run and its results |
| `GET /run` | Run one check right now (the same code the cron calls) |
| `GET /forget?account=topav` | Forget that the account's current timeline was sent, so the next run delivers it again (backfill) |
| `GET /probe?account=topav` | One timeline read, reporting entries/reposts — for checking whether the upstream is reachable |
| `GET /accounts` | List the monitored accounts |
| `POST /accounts` | Replace the list — `topav,only_javs` or `["topav"]` |
| `GET /recipients` | List the chats videos are posted to |
| `POST /recipients` | Replace the recipient list — `779298050,8766696683` or `[779298050,8766696683]` |
| `POST /welcome` | Send one chat the latest already-delivered videos — body `{"chatId":123,"count":5}`; `dry:true` returns the pick without sending |

Every new video is posted to **all** recipients (owner + authorized viewers),
not just the owner. The bot pushes this list on its own whenever accounts or
users change; `RECIPIENTS` in `wrangler.toml` is only a fallback for the first
run before any push.

## Why the worker is frugal with network calls

The Workers free plan allows **50 subrequests per invocation**, so each run:

- reads one timeline page per account (`MAX_TIMELINE_PAGES = 1`; a 10-minute
  cadence only ever misses posts on an account that tweets more than 20 times
  per run, and those are caught on the next run);
- probes at most two mp4 variants for size (`MAX_SIZE_PROBES = 2`);
- hands thumbnails to Telegram as URLs instead of downloading them;
- sends at most `MAX_VIDEOS_PER_RUN = 5` videos and then waits for the next run,
  leaving the pointer so the remainder is not skipped.

State lives in one KV key (`state`), written once per run — far inside the free
tier's 1,000 writes/day. A failed upload is not marked as sent, so the next run
retries it, and `GET /` or the bot's `/cronkey` shows the last run's `delivered`
list (tweet id + who it was reposted from) for spot checks.

## When FxTwitter throttles the edge

`api.fxtwitter.com` is behind Cloudflare, which rate limits or challenges the
shared egress IPs of Workers — `HTTP 429 ... error code: 1015`, or a `403 Just a
moment...` challenge. Roughly one request in seven got through when it started.

So each timeline read is tried in order: direct, direct again, then through the
`r.jina.ai` reader proxy (`PROXY_PREFIX` in `worker.js`), and account lookups are
spaced `ACCOUNT_SPACING_MS` apart so a run is not a burst. A run that is throttled
loses nothing: an account whose read failed simply retries on the next tick, and
the sent-video set means nothing is re-sent. `/probe?account=X` says whether a read
succeeds right now, and the last run's per-account errors are in `GET /`.

If FxTwitter becomes unusable from Workers for good, the same worker code can be
pointed at any FxTwitter-shaped endpoint (`FX` at the top of `worker.js`).

## Sender mode

Both systems sending would duplicate videos, so `tgcloud/lib/config.js` has
`MONITORING_MODE`:

- `'worker'` (current) — the cron checks and sends; the bot keeps the account
  UI, `/status` and history, and `/check` explains who sends.
- `'platform'` — the bot checks on activity again and the cron should be left
  running but idle (or remove its trigger).
