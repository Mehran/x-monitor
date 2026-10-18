import { api } from 'sdk';
import {
  AUTO_CHECK_MAX_ACCOUNTS,
  AUTO_CHECK_MAX_VIDEOS,
  CHECK_LOCK_SECONDS,
  CHECK_MAX_VIDEOS,
  MAX_BACKFILL_VIDEOS,
  MAX_CAPTION_CHARS,
  MAX_TIMELINE_PAGES,
  MIRROR_ENABLED,
  OWNER_CHAT_ID,
} from './config.js';
import * as store from './accounts.js';
import { fetchTimeline, videoCandidates } from './fx.js';
import { mirrorVideo } from './mirror.js';
import { fetchThumbnail, fetchVideo, sendLinkCard, sendVideo as uploadVideo } from './video.js';
import { getState, setState } from './state.js';
import { esc, fmtDate, fmtDuration, fmtSize, newestId, nowSecs, truncate } from './util.js';

function captionFor(account, status, note = '') {
  const repostedFrom =
    status.isRepost && status.authorName && status.authorName.toLowerCase() !== account.username.toLowerCase()
      ? `\n🔁 reposted from <b>@${esc(status.authorName)}</b>`
      : '';
  const header = `🎬 <b>@${esc(account.username)}</b> · ${fmtDate(status.createdAt)}${repostedFrom}`;
  const bodyLimit = Math.max(120, MAX_CAPTION_CHARS - 320);
  const body = truncate((status.text || '').trim(), bodyLimit);
  let caption = header;
  if (body) caption += `\n\n${esc(body)}`;
  if (note) caption += `\n\n${note}`;
  // Removed Open on X link per requirements
  return caption;
}

/**
 * Deliver one video: upload the best mp4 that fits Telegram's limit, or send a
 * preview + link when every variant is too large for a bot upload.
 */
async function deliverVideo(chatId, account, status, media) {
  const claim = await store.claimVideo({
    tweetId: status.id,
    mediaId: media.id || '0',
    accountId: account.id,
    username: account.username,
    status: 'sent',
  });
  if (!claim) return 'skip';

  let tooBigSize = 0;
  let uploadFailed = false;
  try {
    const candidates = videoCandidates(media).slice(0, 4);
    if (!candidates.length) throw new Error('No downloadable mp4 variant');

    for (const candidate of candidates) {
      const file = await fetchVideo(candidate.url);
      if (file.tooBig) {
        tooBigSize = Math.max(tooBigSize, file.size || 0);
        continue;
      }
      if (!file.bytes?.length) continue;

      const thumb = await fetchThumbnail(media.thumbnail);
      const filename = `${account.username}_${status.id}_${media.id || '1'}.mp4`;
      try {
        await uploadVideo(chatId, file.bytes, filename, captionFor(account, status), media, thumb);
        await store.setVideoStatus(claim.id, 'sent');
        return 'sent';
      } catch (error) {
        // Rather than blocking later videos on one stubborn file, fall back to
        // a link so the seen-pointer can keep moving.
        uploadFailed = true;
        console.error(`upload failed @${account.username} ${status.id}/${media.id}`, error);
      }
    }

    // Fall back to a poster + buttons. The play button points at the
    // full-quality mp4, which Telegram's in-app player streams directly, so
    // there is no length or size limit on what can be watched.
    const playUrl = candidates[0]?.url || media.url;
    const mirror = MIRROR_ENABLED && playUrl ? await mirrorVideo(playUrl) : null;

    const facts = [];
    if (tooBigSize) facts.push(fmtSize(tooBigSize));
    if (media.duration) facts.push(fmtDuration(media.duration));
    const factsLine = facts.length ? `📦 ${facts.join(' · ')}` : '';
    const note =
      (factsLine ? `${factsLine}\n` : '') +
      (uploadFailed
        ? '⚠️ Telegram refused the upload — tap ▶️ to play the full video instead.'
        : tooBigSize
          ? '⚠️ Larger than the 50 MB a bot can upload. Tap ▶️ to play the full video here — no size limit.'
          : '⚠️ The file could not be downloaded for upload — tap ▶️ to play it at its source.') +
      (mirror ? '\n🌐 A public mirror was also queued (it appears a few minutes after processing).' : '');

    const thumb = await fetchThumbnail(media.thumbnail);
    await sendLinkCard(chatId, thumb, captionFor(account, status, note), {
      playUrl,
      playLabel: `▶️ Play full video${tooBigSize ? ` · ${fmtSize(tooBigSize)}` : ''}`,
      mirrorUrl: mirror?.watchUrl || null,
    });
    await store.setVideoStatus(claim.id, 'link');
    return 'link';
  } catch (error) {
    await store.releaseClaim(claim.id);
    console.error(`deliver failed @${account.username} ${status.id}/${media.id}`, error);
    return 'error';
  }
}

async function deliverStatus(chatId, account, status, budget) {
  let sent = 0;
  let links = 0;
  let spent = 0;
  let complete = true;

  for (const media of status.videos) {
    if (spent >= budget) {
      // Post has more videos than this run can send: leave it unprocessed so
      // the remainder is delivered next time instead of being skipped forever.
      complete = false;
      break;
    }
    if (await store.wasSent(status.id, media.id || '0')) continue;
    const result = await deliverVideo(chatId, account, status, media);
    if (result === 'sent') {
      sent++;
      spent++;
    } else if (result === 'link') {
      links++;
      spent++;
    } else if (result === 'error') {
      return { sent, links, spent, complete: false, error: true };
    }
  }
  return { sent, links, spent, complete };
}

/**
 * Check one account.
 *
 * Reposts carry the ORIGINAL tweet's id, so an id pointer can never see a repost
 * of anything older than itself — which is most reposts. What decides "new" is
 * therefore the delivered-video table, and `lastTweetId` is only a bookmark.
 * Videos delivered exactly once per (tweet, media), posts and reposts alike.
 */
export async function checkAccount(account, { chatId = OWNER_CHAT_ID, budget = CHECK_MAX_VIDEOS } = {}) {
  const result = { username: account.username, sent: 0, links: 0, newPosts: 0, baseline: false, deferred: false };

  const pages = account.lastTweetId ? MAX_TIMELINE_PAGES : 1;
  const statuses = await fetchTimeline(account.username, {
    pages,
    stopBeforeId: account.lastTweetId,
  });

  if (!statuses.length) {
    await store.updateAccount(account.id, { checkedAt: new Date(), lastError: null });
    return result;
  }

  // First run after adding the account: record what is already there (posts and
  // reposts) and send nothing, so adding an account doesn't dump its archive.
  if (!account.lastTweetId) {
    await store.markKnownVideos(account, statuses);
    await store.updateAccount(account.id, {
      lastTweetId: newestId(statuses) || statuses[0].id,
      checkedAt: new Date(),
      lastError: null,
    });
    result.baseline = true;
    return result;
  }

  // Oldest first: the timeline arrives newest-first, and reverse() therefore
  // delivers in the order things were posted or reposted.
  const ordered = [...statuses].reverse();
  let remaining = budget;
  let failed = false;

  for (const status of ordered) {
    if (remaining <= 0) {
      result.deferred = true;
      break;
    }
    const outcome = await deliverStatus(chatId, account, status, remaining);
    if (outcome.spent) result.newPosts++;
    result.sent += outcome.sent;
    result.links += outcome.links;
    remaining -= outcome.spent;
    if (outcome.error) {
      failed = true;
      break;
    }
    if (!outcome.complete) {
      result.deferred = true;
      break;
    }
  }

  await store.updateAccount(account.id, {
    lastTweetId: newestId(statuses) || account.lastTweetId,
    checkedAt: new Date(),
    lastError: failed ? 'Delivery failed — will retry' : null,
    sentCount: (Number(account.sentCount) || 0) + result.sent + result.links,
  });

  return result;
}

export async function checkAll({ manual = false } = {}) {
  const now = nowSecs();
  const lock = Number(await getState('check_lock', 0)) || 0;
  if (now - lock < CHECK_LOCK_SECONDS) return { busy: true, results: [] };

  await setState('check_lock', now);
  try {
    const enabled = await store.listEnabledByStaleness();
    const budget = manual ? CHECK_MAX_VIDEOS : AUTO_CHECK_MAX_VIDEOS;
    const list = manual ? enabled : enabled.slice(0, AUTO_CHECK_MAX_ACCOUNTS);

    // Every account in the run gets a share of the budget, so one very busy
    // account cannot eat the whole allowance and leave the rest unchecked.
    const share = Math.max(1, Math.floor(budget / Math.max(1, list.length)));

    const results = [];
    let remaining = budget;

    for (const account of list) {
      if (remaining <= 0) break;
      try {
        const result = await checkAccount(account, { budget: Math.min(share, remaining) });
        results.push(result);
        remaining -= result.sent + result.links;
      } catch (error) {
        console.error(`check failed @${account.username}`, error);
        await store.updateAccount(account.id, {
          checkedAt: new Date(),
          lastError: String(error?.message || error).slice(0, 300),
        });
        results.push({ username: account.username, sent: 0, links: 0, error: true, newPosts: 0 });
      }
    }

    await setState('last_check', now);
    if (!manual) await setState('last_auto_check', now);
    return { results, remaining };
  } finally {
    await setState('check_lock', 0);
  }
}

/** Re-send the most recent videos of one account, ignoring the seen pointer. */
export async function backfillAccount(account, limit = MAX_BACKFILL_VIDEOS) {
  const statuses = await fetchTimeline(account.username, { pages: 3 });
  const picked = statuses.filter((status) => status.videos.length).slice(0, limit).reverse();

  let sent = 0;
  let links = 0;
  for (const status of picked) {
    for (const media of status.videos) {
      // An explicit backfill may re-send what a baseline row only recorded.
      if (await store.wasDelivered(status.id, media.id || '0')) continue;
      await store.clearBaseline(status.id, media.id || '0');
      const result = await deliverVideo(OWNER_CHAT_ID, account, status, media);
      if (result === 'sent') sent++;
      else if (result === 'link') links++;
    }
  }
  if (sent + links) {
    await store.updateAccount(account.id, {
      sentCount: (Number(account.sentCount) || 0) + sent + links,
    });
  }
  return { sent, links };
}

export async function notify(text) {
  try {
    await api.sendMessage({ chat_id: OWNER_CHAT_ID, text, parse_mode: 'HTML' });
  } catch (error) {
    console.error('notify failed', error);
  }
}
