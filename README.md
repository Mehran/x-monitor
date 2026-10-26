# X Monitor

A private X/Twitter **video monitor for Telegram**. Add an account once and every
new video — post or repost — is delivered to your chats as a playable MP4 with a
thumbnail, or as a poster with a **▶️ Play** button when the file is too large to
upload.

Built as a Telegram Serverless bot (`tgcloud`) plus an optional Cloudflare Worker
cron for 24/7 checking.

- **No API keys.** Timelines come from the public `api.fxtwitter.com` endpoint.
- **No duplicates.** A unique `(tweet_id, media_id)` record decides what was
  already delivered, so overlapping checks and two accounts sharing a video can
  never double-post.
- **Reposts included.** Reposts carry the *original* tweet id, so "already sent"
  is never decided by tweet id — otherwise repost-only accounts deliver nothing.
- **Access control.** The owner is the full admin; other chats can be authorized
  as read-only viewers or admins from the 👥 Users screen.

Only chat **779298050** (the owner) is a full admin. Every account-mutating
command and button is admin-only.

## Deploy

```bash
npx tgcloud login     # paste the CLI access token from @BotFather → Serverless → CLI Access
npx tgcloud push      # deploy modules (also syncs the webhook)
npx tgcloud migrate   # apply schema changes (only needed after editing schema.js)
```

`npm run deploy` does the push for you. Useful while developing:

```bash
npx tgcloud status
npx tgcloud run handlers/message '{ chat: { id: 779298050 }, text: "/status" }'
npx tgcloud webhook
```

## Commands

| Command | What it does |
|---|---|
| `/start`, `/menu` | Main menu with buttons |
| `/add @user` | Start monitoring an account (starts at its newest post) |
| `/accounts`, `/list` | List accounts, tap one to manage it |
| `/check` | Look for new videos right now |
| `/status` | Accounts, delivery counts, last check, last errors |
| `/pause @user`, `/resume @user` | Toggle monitoring |
| `/remove @user` | Stop monitoring and delete its history |
| `/users`, `/addchat <id>` | Manage who may use the bot (admin) |
| `/cronkey [key]` | Show the cron's state, or store its admin key |
| `/help` | Help text |

Buttons on an account: **Pause/Resume**, **Rename**, **Last 10 videos**
(backfill), **Delete**. The main menu also has **👥 Users**, where the owner can
add chat IDs and promote them to admin or remove them.

## Roles

- **Owner** (`OWNER_CHAT_ID`, 779298050) — full admin.
- **Viewer** (`LIMITED_CHAT_IDS` in `tgcloud/lib/config.js`, e.g. 8766696683) —
  read-only: menus, account list and `/status`; cannot add, check or remove.
- **Admin / viewer via 👥 Users** — any other chat the owner adds to the
  `authorized_chats` table, each with an `isAdmin` flag. Non-admin authorized
  chats (and config viewers) are read-only. Enforced in `tgcloud/lib/access.js`.

## Monitoring model

Telegram Serverless has **no cron/timer**. Handlers only run when Telegram
delivers an update, so checks are activity-driven:

- every message you send the bot triggers a check at most once every **10
  minutes** (`AUTO_CHECK_INTERVAL` in `tgcloud/lib/config.js`);
- `/check` (or **Check now**) always runs one immediately;
- a check is locked for 240 s (`CHECK_LOCK_SECONDS`) so parallel updates can't
  double-send.

For 24/7 checking without opening the chat, `cron/` holds a Cloudflare Worker
with a Cron Trigger that does the whole job itself (poll → dedupe → post): see
[cron/README.md](cron/README.md). Both systems sending would duplicate videos,
so `MONITORING_MODE` in `tgcloud/lib/config.js` picks the sender — it is
currently `'worker'` (the cron sends; this bot keeps the account UI, `/status`
and the delivery history). Accounts stay in step automatically: adding, renaming,
pausing or deleting one here pushes the enabled list to the cron. `/cronkey`
shows the cron's last run, and `/cronkey <key>` stores its admin key.

**Recipients.** The cron posts each new video to every authorized chat, not just
the owner: the bot pushes the owner + viewer/admin chat IDs to the worker
(`POST /recipients`) whenever the account or user list changes. Adding a chat in
👥 Users makes it receive videos from the next run on.

**New users.** When an admin adds a chat, the bot asks the cron to send that chat
the last few videos the group already received (`POST /welcome`, count in
`WELCOME_VIDEO_COUNT`) so it starts with something to watch — no need to wait for
the next post.

## How videos are fetched and sent

1. `api.fxtwitter.com/2/profile/<user>/statuses` returns the recent timeline with
   direct `video.twimg.com` MP4 variants and thumbnails (no API key needed). The
   timeline includes **reposts**, so one added account covers both its own posts
   and everything it retweets.

   Reposts are ordered by when they were reposted but carry the *original*
   tweet's id, so nothing id-based can see them — a page of reposts always looks
   older than the newest id in it. "Already sent" is therefore decided by the
   delivered-video record, keyed `(tweet_id, media_id)`, which is also what stops
   the same video arriving twice from two accounts. The first check after adding
   an account records its current timeline as known, so reposts of old videos do
   not arrive as a backlog.
2. New posts are filtered against `accounts.lastTweetId` (compared as BigInt).
3. The highest-bitrate MP4 under 45 MB is chosen. Downloads use HTTP **Range**
   requests because the platform caps a single response at 30 MB.
4. The file is uploaded with `sendVideo` plus a thumbnail. When every variant is
   larger than the Bot API's 50 MB upload limit (or Telegram refuses the file),
   the bot sends the **poster + a ▶️ Play button** instead: the button links
   straight to the highest-quality `video.twimg.com` MP4, which Telegram's
   in-app player streams with range requests. Length is unlimited this way, and
   nothing has to be re-uploaded.
5. `MIRROR_ENABLED` in `config.js` additionally queues a public copy on a host
   that downloads the video server-side (`lib/mirror.js`) and adds a **🌐 Mirror**
   button. It is off by default: the free host used here has no API contract and
   its encoder currently stalls at "processing".
6. `videos` has a unique `(tweet_id, media_id)` index, so a video can never be
   delivered twice, even if two checks overlap.

## Layout

```
cron/                        Cloudflare Worker cron (optional 24/7 scheduler)
tgcloud/
├─ schema.js                 accounts, videos, state
├─ handlers/message.js       commands, access control, auto-check
├─ handlers/callback_query.js inline buttons
└─ lib/
   ├─ config.js              owner id, throttles, size limits
   ├─ fx.js                  X timeline client
   ├─ video.js               ranged downloader + uploads + link cards
   ├─ mirror.js              optional public mirror of oversized videos
   ├─ monitor.js             new-post detection and delivery
   ├─ accounts.js            database access
   ├─ ui.js / views.js       texts and keyboards
   ├─ telegram.js            send/edit/answer helpers
   ├─ state.js               key/value state
   └─ util.js                formatting helpers
```

## Notes & limits

- Adding an account records its newest post as the starting point, so its archive
  is not dumped into the chat. Use **Last 10 videos** to pull recent ones.
- Very active accounts can post more than the per-run video budget (8 manual,
  3 automatic); the summary says when more are waiting and the rest are sent on
  the next check.
- X may occasionally rate-limit the public timeline API; each request is retried
  three times and failures are shown as `last error` on the account.
- Telegram bots cannot upload files over 50 MB. The bot itself is limited even
  harder by the platform: an outbound upload is capped at 50 MB per request
  (~60 MB per invocation), and a single `fetch` response at 30 MB (worked around
  with range requests). Uploading a long video from here is therefore impossible
  — oversized videos are streamed from their original URL instead, which has no
  size limit.
- Telegram also refuses to fetch a remote URL into a native video above ~20 MB
  (measured: 12 MB URL works, 36 MB fails), so a hosted copy could never become
  an in-chat video either; the play button is the way to watch anything long.
- `cron/wrangler.toml` holds deployment ids (KV namespace, worker name, fallback
  chat list). Replace them with your own before deploying the worker, and keep
  `BOT_TOKEN` / `ADMIN_KEY` as Wrangler secrets — never in the repo.
