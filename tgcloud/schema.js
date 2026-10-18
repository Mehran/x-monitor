import { table, integer, text, boolean, uniqueIndex, sql } from 'sdk/db';

// Monitored X/Twitter accounts.
export const accounts = table('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  // Newest tweet id already processed (stored as text: tweet ids exceed 2^53).
  lastTweetId: text('last_tweet_id'),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  checkedAt: integer('checked_at', { mode: 'timestamp' }),
  lastError: text('last_error'),
  sentCount: integer('sent_count').notNull().default(0),
});

// One row per delivered video. The unique index is what stops a video from
// being sent twice when checks overlap or a timeline is re-read.
export const videos = table(
  'videos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tweetId: text('tweet_id').notNull(),
    mediaId: text('media_id').notNull(),
    accountId: integer('account_id').notNull(),
    username: text('username').notNull(),
    // 'sent' = uploaded mp4, 'link' = oversized, play link delivered,
    // 'baseline' = already existed when the account was added (never sent).
    status: text('status').notNull().default('sent'),
    sentAt: integer('sent_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tweetMedia: uniqueIndex('uidx_videos_tweet_media').on(t.tweetId, t.mediaId),
  })
);

// Small key/value store: pending input, check lock, last auto-check time.
export const state = table('state', {
  key: text('key').primaryKey(),
  value: text('value'),
});

// Authorized Telegram chat IDs (admins). The bot only sends videos to these chats.
export const authorizedChats = table('authorized_chats', {
  chatId: integer('chat_id').primaryKey(),
  isAdmin: boolean('is_admin').notNull().default(false),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
});
