/*
 * Cloudflare Worker — scheduled X/Twitter video monitor for @MehranHornyBot.
 *
 * Telegram Serverless has no timer, so this Worker is the scheduler: a Cron
 * Trigger wakes it every 10 minutes, it looks for new videos on the monitored
 * accounts and posts them to every recipient chat (owner + viewers) with the
 * bot token. The recipient list is pushed by the bot on every account/user
 * change (`POST /recipients`).
 *
 *   ≤ 40 MB  → uploaded as a real video (mp4 + thumbnail)
 *   larger   → poster + caption + a ▶️ button that streams the original mp4
 *              (Telegram's bot upload cap is 50 MB; its URL fetch cap is ~20 MB)
 *
 * State lives in one KV key ("state", written only when something changed) so
 * the free tier's 1,000 writes/day is never the bottleneck.
 */

const FX = 'https://api.fxtwitter.com';
const UA = 'Mozilla/5.0 (compatible; XVideoMonitor-cron/1.0)';

// api.fxtwitter.com is behind Cloudflare, which rate limits / challenges the
// shared egress IPs of Workers (HTTP 429 "error code: 1015", or a 403
// "Just a moment..." challenge). A reader proxy is used as a fallback transport
// so a throttled edge does not silently stop monitoring.
const PROXY_PREFIX = 'https://r.jina.ai/';
const API = 'https://api.telegram.org';

// Bot API uploads cap at 50 MB; stay clear of the Worker's 128 MB memory limit.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
// The Workers free plan allows 50 subrequests per invocation, so every network
// call counts: one timeline page per account, at most two size probes per
// video, one download and one Telegram call. Thumbnails are handed to Telegram
// as URLs so they never cost us a subrequest.
const MAX_TIMELINE_PAGES = 1;
const MAX_VIDEOS_PER_RUN = 5;
const MAX_SIZE_PROBES = 2;
// A new authorized user is greeted with the most recent already-delivered
// videos, so they have something to watch without waiting for the next post.
const WELCOME_COUNT = 5;
// Each recipient costs one extra Telegram call per video. The free plan allows
// 50 subrequests per invocation, so cap how many chats one run posts to.
const MAX_RECIPIENTS = 5;
// FxTwitter sits behind Cloudflare, which rate limits the Worker's egress IPs
// (HTTP 429 / "error code: 1015") when they arrive in a tight burst. Spacing the
// account lookups out keeps 7 timeline reads from looking like a flood, and a
// throttled account is simply retried on the next run — the sent-video set means
// nothing is lost in between.
const ACCOUNT_SPACING_MS = 700;
const MAX_CAPTION_CHARS = 900;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).then((out) => console.log('run', JSON.stringify(out))));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || request.headers.get('x-admin-key');
    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
      return new Response('not found', { status: 404 });
    }

    if (url.pathname === '/accounts') {
      if (request.method === 'POST') {
        const body = (await request.text()).trim();
        const list = body.startsWith('[')
          ? JSON.parse(body)
          : body.split(',').map((s) => s.trim()).filter(Boolean);
        await env.STATE.put('accounts', JSON.stringify(list.map(normalizeUsername).filter(Boolean)));
      }
      const accounts = await loadAccounts(env);
      return json({ accounts });
    }

    if (url.pathname === '/recipients') {
      if (request.method === 'POST') {
        const body = (await request.text()).trim();
        const list = body.startsWith('[') ? JSON.parse(body) : body.split(',').map((s) => s.trim());
        const ids = list.map((n) => Number(n)).filter((n) => Number.isFinite(n));
        await env.STATE.put('recipients', JSON.stringify(ids));
      }
      return json({ recipients: await loadRecipients(env) });
    }

    if (url.pathname === '/run') {
      return json(await run(env));
    }

    // One timeline read, for checking whether the upstream is reachable/limited.
    if (url.pathname === '/probe') {
      const account = normalizeUsername(url.searchParams.get('account'));
      if (!account) return json({ error: 'account is required' }, 400);
      try {
        const statuses = await fetchTimeline(account, 1);
        return json({ account, ok: true, entries: statuses.length, reposts: statuses.filter((s) => s.isRepost).length });
      } catch (error) {
        return json({ account, ok: false, error: String(error?.message || error) });
      }
    }

    // Forget that the current timeline page was already sent, so the next run
    // delivers it again. Used for backfill and for testing.
    if (url.pathname === '/forget') {
      const account = normalizeUsername(url.searchParams.get('account'));
      if (!account) return json({ error: 'account is required' }, 400);
      const statuses = await fetchTimeline(account, 1);
      const state = await loadState(env);
      let cleared = 0;
      for (const status of statuses) {
        for (const media of status.videos) {
          const key = `${status.id}:${media.id || '0'}`;
          if (state.seen[key]) {
            delete state.seen[key];
            cleared++;
          }
        }
      }
      await env.STATE.put('state', JSON.stringify(state));
      return json({ account, cleared, pageEntries: statuses.length });
    }

    // Greet a newly authorized chat with the latest videos the group has
    // already received. Returns immediately; the sends run in the background.
    if (url.pathname === '/welcome') {
      let body = {};
      try {
        body = JSON.parse((await request.text()) || '{}');
      } catch {
        body = {};
      }
      const chatId = Number(body.chatId ?? url.searchParams.get('chatId'));
      if (!Number.isFinite(chatId)) return json({ error: 'chatId is required' }, 400);
      const rawCount = Number(body.count ?? url.searchParams.get('count')) || WELCOME_COUNT;
      const count = Math.max(1, Math.min(10, rawCount));
      const dry = Boolean(body.dry ?? url.searchParams.get('dry'));
      if (dry) return json(await sendWelcome(env, chatId, count, true));
      ctx.waitUntil(
        sendWelcome(env, chatId, count, false)
          .then((out) => console.log('welcome', JSON.stringify(out)))
          .catch((error) => console.error('welcome failed', error?.message || error))
      );
      return json({ ok: true, scheduled: true, chatId, count });
    }

    const state = await loadState(env);
    return json({
      accounts: await loadAccounts(env),
      recipients: await loadRecipients(env),
      pointers: state.accounts,
      seen: Object.keys(state.seen).length,
      lastRun: state.lastRun || null,
      lastResult: state.lastResult || null,
    });
  },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(data) {
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function normalizeUsername(raw) {
  let value = String(raw || '').trim();
  value = value.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '');
  value = value.split(/[/?#\s]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : null;
}

async function loadAccounts(env) {
  const stored = await env.STATE.get('accounts');
  if (stored) {
    try {
      const list = JSON.parse(stored);
      if (Array.isArray(list) && list.length) return list;
    } catch {
      // fall through to the env var
    }
  }
  return String(env.ACCOUNTS || '')
    .split(',')
    .map(normalizeUsername)
    .filter(Boolean);
}

async function loadRecipients(env) {
  const stored = await env.STATE.get('recipients');
  if (stored) {
    try {
      const list = JSON.parse(stored);
      const ids = (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n));
      if (ids.length) return ids;
    } catch {
      // fall through to env/owner
    }
  }
  const fromEnv = String(env.RECIPIENTS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  if (fromEnv.length) return fromEnv;
  return env.OWNER_CHAT_ID ? [Number(env.OWNER_CHAT_ID)] : [];
}

async function loadState(env) {
  const raw = await env.STATE.get('state');
  if (!raw) return { accounts: {}, seen: {}, lastRun: null, lastResult: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      accounts: parsed.accounts || {},
      seen: parsed.seen || {},
      lastRun: parsed.lastRun || null,
      lastResult: parsed.lastResult || null,
    };
  } catch {
    return { accounts: {}, seen: {}, lastRun: null, lastResult: null };
  }
}

async function run(env) {
  if (!env.BOT_TOKEN) return { error: 'BOT_TOKEN is not set' };
  if (!env.OWNER_CHAT_ID) return { error: 'OWNER_CHAT_ID is not set' };

  const accounts = await loadAccounts(env);
  const recipients = (await loadRecipients(env)).slice(0, MAX_RECIPIENTS);
  const state = await loadState(env);
  const results = [];
  let budget = MAX_VIDEOS_PER_RUN;
  let dirty = false;

  for (const username of accounts) {
    if (budget <= 0) {
      results.push({ username, skipped: 'video budget reached' });
      continue;
    }
    if (results.length) await sleep(ACCOUNT_SPACING_MS);
    try {
      const result = await checkAccount(env, state, username, budget, recipients);
      budget -= result.sent + result.links;
      if (result.changed) dirty = true;
      results.push(result);
    } catch (error) {
      results.push({ username, error: String(error?.message || error) });
    }
  }

  state.lastRun = new Date().toISOString();
  state.lastResult = results;
  // One write per run at most: KV's free tier allows 1,000 writes a day.
  await env.STATE.put('state', JSON.stringify(state));

  return { checked: results.length, results };
}

const seenKey = (statusId, mediaId) => `${statusId}:${mediaId || '0'}`;

function maxId(statuses) {
  return statuses.reduce((best, s) => (best && !newerThan(s.id, best) ? best : s.id), null);
}

/**
 * Reposts are ordered by when they were reposted, but they carry the ORIGINAL
 * tweet's id — an id-based pointer can therefore never see them (a page of
 * reposts would always look "older" than the pointer). So an entry is new when
 * its video is not in the sent set, and the pointer is only a bookmark.
 */
async function checkAccount(env, state, username, budget, recipients) {
  const statuses = await fetchTimeline(username, MAX_TIMELINE_PAGES);
  const result = { username, newPosts: 0, sent: 0, links: 0, changed: false, deferred: false, delivered: [] };
  if (!statuses.length) return result;

  const newest = maxId(statuses);

  if (!state.accounts[username]) {
    // First sight of this account: treat what is already in the timeline as
    // known (posts and reposts alike) so adding it does not dump the archive.
    for (const status of statuses) {
      for (const media of status.videos) state.seen[seenKey(status.id, media.id)] = Date.now();
    }
    state.accounts[username] = newest;
    return { ...result, baseline: true, changed: true };
  }

  // Oldest first: the timeline arrives newest-first and reverse() therefore
  // delivers in the order things were posted/reposted.
  const ordered = [...statuses].reverse();
  result.newPosts = ordered.filter((s) => s.videos.some((m) => !state.seen[seenKey(s.id, m.id)])).length;

  let remaining = budget;

  for (const status of ordered) {
    const pending = status.videos.filter((m) => !state.seen[seenKey(status.id, m.id)]);
    if (!pending.length) continue;
    if (remaining <= 0) {
      result.deferred = true;
      break;
    }

    let complete = true;
    for (const media of pending) {
      if (remaining <= 0) {
        complete = false;
        break;
      }
      const outcome = await deliver(env, state, username, status, media, recipients);
      if (outcome === 'error') {
        complete = false;
        break;
      }
      state.seen[seenKey(status.id, media.id)] = Date.now();
      result.changed = true;
      remaining--;
      if (outcome === 'sent') result.sent++;
      else result.links++;
      if (result.delivered.length < 10) {
        result.delivered.push({ tweet: status.id, repostedFrom: status.isRepost ? status.authorName : null });
      }
    }

    if (!complete) {
      result.deferred = true;
      break;
    }
  }

  if (newest && newest !== state.accounts[username]) {
    state.accounts[username] = newest;
    result.changed = true;
  }
  pruneSeen(state);
  return result;
}

function pruneSeen(state) {
  const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
  for (const [key, at] of Object.entries(state.seen)) {
    if (Number(at) < cutoff) delete state.seen[key];
  }
}

/**
 * Deliver the latest videos from the monitored accounts to one chat, newest
 * first. Already-delivered videos are preferred so the upcoming scheduled run
 * does not post the same ones again; if there are too few of those tracked, the
 * freshest timeline entries are used instead. State is never touched here.
 */
async function sendWelcome(env, chatId, count, dry) {
  if (!env.BOT_TOKEN) return { error: 'BOT_TOKEN is not set' };

  const accounts = await loadAccounts(env);
  const state = await loadState(env);
  const found = [];

  for (const username of accounts) {
    let statuses = [];
    try {
      statuses = await fetchTimeline(username, MAX_TIMELINE_PAGES);
    } catch (error) {
      console.error('welcome timeline failed', username, error?.message || error);
      continue;
    }
    for (const status of statuses) {
      for (const media of status.videos) {
        found.push({
          username,
          status,
          media,
          at: status.createdAt || 0,
          known: Boolean(state.seen[seenKey(status.id, media.id)]),
        });
      }
    }
    await sleep(ACCOUNT_SPACING_MS);
  }

  found.sort((a, b) => b.at - a.at);
  const known = found.filter((item) => item.known);
  const picked = (known.length >= count ? known : found).slice(0, count);

  if (dry) {
    return {
      chatId,
      count: picked.length,
      dry: true,
      videos: picked.map((item) => ({ username: item.username, tweet: item.status.id, at: item.at, known: item.known })),
    };
  }

  let sent = 0;
  let links = 0;
  for (const item of picked) {
    const outcome = await deliver(env, state, item.username, item.status, item.media, [chatId]);
    if (outcome === 'error') continue;
    if (outcome === 'sent') sent++;
    else links++;
  }
  return { chatId, picked: picked.length, sent, links };
}

/**
 * FxTwitter returns 404 transiently (rate limiting / edge misses), so a single
 * failure must not lose an account for a whole run.
 */
/** Pulls the JSON out of either a plain API response or a reader-proxy page. */
function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  const marker = text.indexOf('Markdown Content:');
  const body = marker >= 0 ? text.slice(marker + 'Markdown Content:'.length) : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(body.slice(start));
  } catch {
    return null;
  }
}

async function fx(url) {
  const attempts = [url, url, `${PROXY_PREFIX}${url}`];
  let lastError = null;

  for (let attempt = 0; attempt < attempts.length; attempt++) {
    if (attempt) await sleep(attempt === 1 ? 1200 : 1500);
    try {
      const res = await fetch(attempts[attempt], {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      const text = await res.text();
      const data = extractJson(text);

      if (!data) {
        // Cloudflare rate-limit / challenge pages are not JSON.
        lastError = new Error(`HTTP ${res.status}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
        continue;
      }
      if (data.code && data.code !== 200) {
        lastError = new Error(data.message || `API ${data.code}`);
        continue;
      }
      return data;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('request failed');
}

async function fetchTimeline(username, pages) {
  const statuses = [];
  let cursor = null;

  for (let page = 0; page < Math.max(1, pages); page++) {
    let url = `${FX}/2/profile/${encodeURIComponent(username)}/statuses`;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;

    let data = null;
    try {
      data = await fx(url);
    } catch (error) {
      // Keep the pages already read; only the first page failing is fatal.
      if (page === 0) throw error;
      break;
    }

    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) break;
    for (const raw of results) {
      const status = normalizeStatus(raw);
      if (status.id) statuses.push(status);
    }
    cursor = data.cursor?.bottom || null;
    if (!cursor) break;
  }
  return statuses;
}

function normalizeStatus(raw) {
  const mediaList = raw.media?.all || [];
  const videos = mediaList
    .filter((m) => m && (m.type === 'video' || m.type === 'gif') && m.url)
    .map((m) => ({
      id: String(m.id || ''),
      url: m.url,
      thumbnail: m.thumbnail_url || '',
      duration: Number(m.duration) || 0,
      width: Number(m.width) || 0,
      height: Number(m.height) || 0,
      formats: (m.formats || [])
        .filter((f) => f && f.url && (f.container === 'mp4' || /\.mp4(\?|$)/.test(f.url)))
        .map((f) => ({ url: f.url, bitrate: Number(f.bitrate) || 0 })),
    }));

  return {
    id: String(raw.id || ''),
    text: raw.text || raw.raw_text?.text || '',
    url: raw.url || `https://x.com/i/status/${raw.id}`,
    createdAt: Number(raw.created_timestamp) || 0,
    // Reposts come back in the same timeline and carry the original tweet's id,
    // so they are monitored alongside posts and deduped against them.
    isRepost: Boolean(raw.reposted_by),
    authorName: raw.author?.screen_name || '',
    videos,
  };
}

function newerThan(id, reference) {
  try {
    return BigInt(String(id)) > BigInt(String(reference));
  } catch {
    return String(id) > String(reference);
  }
}

function candidatesFor(media) {
  const seen = new Set();
  const list = [];
  for (const format of [...media.formats].sort((a, b) => b.bitrate - a.bitrate)) {
    if (!format.url || seen.has(format.url)) continue;
    seen.add(format.url);
    list.push(format.url);
  }
  if (media.url && !seen.has(media.url)) list.push(media.url);
  return list;
}

async function deliver(env, state, username, status, media, recipients) {
  const urls = candidatesFor(media);
  if (!urls.length) return 'error';

  let biggest = 0;
  for (const url of urls.slice(0, MAX_SIZE_PROBES)) {
    let size = 0;
    try {
      size = await headSize(url);
    } catch {
      continue;
    }
    if (size > 0 && size <= MAX_UPLOAD_BYTES) {
      const ok = await sendVideoFile(env, username, status, media, url, size, recipients);
      if (ok) return 'sent';
      continue;
    }
    biggest = Math.max(biggest, size);
  }

  await sendPlayCard(env, username, status, media, urls[0], biggest, recipients);
  return 'link';
}

async function headSize(url) {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new Error(`HEAD ${res.status}`);
  return Number(res.headers.get('content-length') || 0);
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtSize(bytes) {
  if (!bytes) return '?';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(seconds) {
  if (!seconds) return '';
  const d = new Date(seconds * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function captionFor(username, status, extra = '') {
  const repostedFrom =
    status.isRepost && status.authorName && status.authorName.toLowerCase() !== username.toLowerCase()
      ? `\n🔁 reposted from <b>@${esc(status.authorName)}</b>`
      : '';
  const header = `🎬 <b>@${esc(username)}</b>${status.createdAt ? ` · ${fmtDate(status.createdAt)}` : ''}${repostedFrom}`;
  const body = String(status.text || '').trim();
  const room = Math.max(120, MAX_CAPTION_CHARS - 320);
  const trimmed = body.length > room ? `${body.slice(0, room - 1).trimEnd()}…` : body;
  let caption = header;
  if (trimmed) caption += `\n\n${esc(trimmed)}`;
  if (extra) caption += `\n\n${extra}`;
  return caption;
}

/** Telegram fetches the poster itself, which keeps our subrequest count down. */
function thumbUrl(media) {
  if (!media.thumbnail) return null;
  return `${media.thumbnail}${media.thumbnail.includes('?') ? '&' : '?'}name=thumb`;
}

async function telegram(env, method, fields, files) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(name, typeof value === 'string' ? value : JSON.stringify(value));
  }
  for (const [name, file] of Object.entries(files || {})) {
    if (file) form.append(name, new Blob([file.bytes], { type: file.type }), file.name);
  }

  const res = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

async function sendVideoFile(env, username, status, media, url, size, recipients) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) return false;

    const thumb = thumbUrl(media);
    const caption = captionFor(
      username,
      status,
      `📦 ${fmtSize(bytes.byteLength)}${media.duration ? ` · ⏱ ${fmtDuration(media.duration)}` : ''}`
    );

    let delivered = 0;
    for (const chatId of recipients) {
      const fields = {
        chat_id: chatId,
        caption,
        parse_mode: 'HTML',
        supports_streaming: true,
      };
      if (media.width) fields.width = media.width;
      if (media.height) fields.height = media.height;
      if (media.duration) fields.duration = Math.round(media.duration);
      if (thumb) fields.thumbnail = thumb;

      try {
        await telegram(env, 'sendVideo', fields, {
          video: { bytes, name: `${username}_${status.id}.mp4`, type: 'video/mp4' },
        });
        delivered++;
      } catch (error) {
        console.error('sendVideo failed', chatId, url, error?.message || error);
      }
    }
    return delivered > 0;
  } catch (error) {
    console.error('sendVideo failed', url, error?.message || error);
    return false;
  }
}

async function sendPlayCard(env, username, status, media, playUrl, size, recipients) {
  const facts = [size ? fmtSize(size) : '', media.duration ? `⏱ ${fmtDuration(media.duration)}` : '']
    .filter(Boolean)
    .join(' · ');
  const note =
    (facts ? `📦 ${facts}\n` : '') +
    '⚠️ Larger than the 50 MB a bot can upload. Tap ▶️ to play the full video here — no size limit.';

  const keyboard = { inline_keyboard: [[{ text: `▶️ Play full video${size ? ` · ${fmtSize(size)}` : ''}`, url: playUrl }]] };
  const photo = thumbUrl(media) || playUrl;
  const caption = captionFor(username, status, note);

  for (const chatId of recipients) {
    try {
      await telegram(env, 'sendPhoto', {
        chat_id: chatId,
        photo,
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (error) {
      console.error('sendPlayCard failed', chatId, error?.message || error);
    }
  }
}
