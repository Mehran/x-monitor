import { db } from 'sdk';
import { and, asc, eq } from 'sdk/db';
import { accounts, videos } from '../schema.js';

export async function listAccounts() {
  return db.select().from(accounts).orderBy(asc(accounts.username)).all();
}

export async function listEnabledByStaleness() {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.enabled, true))
    .orderBy(asc(accounts.checkedAt))
    .all();
}

export async function getAccount(id) {
  return db.select().from(accounts).where(eq(accounts.id, Number(id))).get();
}

export async function getAccountByUsername(username) {
  return db.select().from(accounts).where(eq(accounts.username, String(username).toLowerCase())).get();
}

export async function createAccount(username, lastTweetId) {
  const [row] = await db
    .insert(accounts)
    .values({ username: String(username).toLowerCase(), lastTweetId })
    .returning()
    .run();
  return row;
}

export async function setBaseline(id, lastTweetId) {
  await db.update(accounts).set({ lastTweetId }).where(eq(accounts.id, id)).run();
}

export async function updateAccount(id, patch) {
  await db.update(accounts).set(patch).where(eq(accounts.id, id)).run();
}

export async function deleteAccount(id) {
  // No foreign keys on this platform: clean up the children ourselves.
  await db.delete(videos).where(eq(videos.accountId, Number(id))).run();
  await db.delete(accounts).where(eq(accounts.id, Number(id))).run();
}

export async function countAccounts() {
  return db.$count(accounts);
}

export async function countActiveAccounts() {
  return db.$count(accounts, eq(accounts.enabled, true));
}

export async function countSentVideos() {
  return db.$count(videos);
}

export async function wasSent(tweetId, mediaId) {
  const row = await db
    .select({ id: videos.id })
    .from(videos)
    .where(and(eq(videos.tweetId, tweetId), eq(videos.mediaId, mediaId)))
    .get();
  return Boolean(row);
}

/**
 * True only when the video was actually sent here. Rows marked 'baseline' exist
 * just to keep a newly added account's archive from being re-sent, so an
 * explicit backfill may still deliver them.
 */
export async function wasDelivered(tweetId, mediaId) {
  const row = await db
    .select({ status: videos.status })
    .from(videos)
    .where(and(eq(videos.tweetId, tweetId), eq(videos.mediaId, mediaId)))
    .get();
  return Boolean(row) && row.status !== 'baseline';
}

/** Drops a 'baseline' hold so an explicit backfill can send the video. */
export async function clearBaseline(tweetId, mediaId) {
  await db
    .delete(videos)
    .where(and(eq(videos.tweetId, tweetId), eq(videos.mediaId, mediaId), eq(videos.status, 'baseline')))
    .run();
}

/**
 * Mark everything currently in a timeline as "already known".
 *
 * Videos are tracked by (tweet, media) rather than by tweet id because reposts
 * carry the ORIGINAL tweet's id: an id pointer can never see a repost of
 * anything older than itself, which is most of them.
 */
export async function markKnownVideos(account, statuses) {
  let marked = 0;
  for (const status of statuses || []) {
    for (const media of status.videos || []) {
      const row = await claimVideo({
        tweetId: status.id,
        mediaId: media.id || '0',
        accountId: account.id,
        username: account.username,
        status: 'baseline',
      });
      if (row) marked++;
    }
  }
  return marked;
}

/**
 * Reserve a (tweet, media) pair before sending. The unique index means a
 * concurrent check loses this insert and skips instead of double-posting.
 */
export async function claimVideo({ tweetId, mediaId, accountId, username, status }) {
  try {
    const [row] = await db
      .insert(videos)
      .values({ tweetId, mediaId, accountId, username, status })
      .returning()
      .run();
    return row;
  } catch {
    return null;
  }
}

export async function setVideoStatus(id, status) {
  await db.update(videos).set({ status }).where(eq(videos.id, id)).run();
}

export async function releaseClaim(id) {
  await db.delete(videos).where(eq(videos.id, id)).run();
}
