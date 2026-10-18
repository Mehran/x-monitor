import { fetch } from 'sdk';

const BASE = 'https://api.fxtwitter.com';
const UA = 'Mozilla/5.0 (compatible; XVideoMonitor/1.0)';

async function getJSON(url, tries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (data.code && data.code !== 200) {
        // 404 is also returned transiently by the profile endpoint; retry it.
        lastError = new Error(data.message || `API ${data.code}`);
        continue;
      }
      return data;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('Request failed');
}

/** Profile lookup used to validate a username before adding it. */
export async function fetchProfile(username) {
  const data = await getJSON(`${BASE}/${encodeURIComponent(username)}`);
  if (!data.user) throw new Error('Account not found');
  return data.user;
}

function normalizeStatus(raw) {
  const mediaList = raw.media?.all || [];
  const videos = mediaList
    .filter((m) => m && (m.type === 'video' || m.type === 'gif') && m.url)
    .map((m) => ({
      id: String(m.id || ''),
      url: m.url,
      thumbnail: m.thumbnail_url || '',
      // FxTwitter reports duration in seconds.
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
    url: raw.url || '',
    createdAt: Number(raw.created_timestamp) || 0,
    // Reposts are part of the same timeline, so they are monitored too; the
    // original author is kept for the caption and for dedupe (ids are the
    // original tweet's, so the same video never arrives twice).
    isRepost: Boolean(raw.reposted_by),
    repostedBy: raw.reposted_by?.screen_name || '',
    authorName: raw.author?.screen_name || '',
    videos,
  };
}

/**
 * Recent posts of an account, newest first.
 * Walks `pages` pages of 20 and stops once it reaches `stopBeforeId`.
 */
export async function fetchTimeline(username, { pages = 1, stopBeforeId = null } = {}) {
  const statuses = [];
  let cursor = null;

  for (let page = 0; page < Math.max(1, pages); page++) {
    let url = `${BASE}/2/profile/${encodeURIComponent(username)}/statuses`;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;

    const data = await getJSON(url);
    const results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) break;

    for (const raw of results) {
      const status = normalizeStatus(raw);
      if (status.id) statuses.push(status);
    }

    // Stop paginating once this page already reaches the stored id.
    const oldest = results[results.length - 1];
    if (stopBeforeId && oldest?.id && !isNewer(oldest.id, stopBeforeId)) break;

    cursor = data.cursor?.bottom || null;
    if (!cursor) break;
  }

  return statuses;
}

function isNewer(id, reference) {
  try {
    return BigInt(String(id)) > BigInt(String(reference));
  } catch {
    return String(id) > String(reference);
  }
}

/** Highest-bandwidth-first mp4 candidates for a video. */
export function videoCandidates(media) {
  const seen = new Set();
  const list = [];
  for (const format of media.formats) {
    if (!format.url || seen.has(format.url)) continue;
    seen.add(format.url);
    list.push({ url: format.url, bitrate: format.bitrate || 0 });
  }
  if (media.url && !seen.has(media.url)) {
    list.push({ url: media.url, bitrate: Number.MAX_SAFE_INTEGER / 4 });
  }
  return list.sort((a, b) => b.bitrate - a.bitrate);
}
