/*
 * Local harness for cron/worker.js. Runs the real code path (timeline fetch →
 * dedupe → download → Telegram upload) against a stubbed FxTwitter response, so
 * it needs no Cloudflare account.
 *
 *   BOT_TOKEN=... node cron/test-local.mjs
 *
 * Runs: baseline → a new post is delivered → nothing new → a repost of an OLD
 * video (id far below the pointer) is still delivered → nothing twice.
 */
import worker from './worker.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '779298050';
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required');
  process.exit(1);
}

const SMALL = 'https://video.twimg.com/amplify_video/2110031260504768512/vid/avc1/320x568/r0eNMmi-nB-uns83.mp4?tag=29';
const THUMB = 'https://pbs.twimg.com/amplify_video_thumb/2110031260504768512/img/wsFeOT-B7EVKq0D6.jpg';

const video = (id) => ({
  id,
  type: 'video',
  url: SMALL,
  thumbnail_url: THUMB,
  duration: 4,
  width: 320,
  height: 568,
  formats: [{ url: SMALL, bitrate: 632000, container: 'mp4' }],
});

const newPost = {
  id: '2111776554862678426',
  text: 'worker test delivery — please ignore',
  url: 'https://x.com/topav/status/2111776554862678426',
  created_timestamp: Math.floor(Date.now() / 1000) - 60,
  author: { screen_name: 'TopAV' },
  media: { all: [video('11111')] },
};

// The point of the regression case: id 2085776272484143373 is far OLDER than
// the pointer, because it is the original tweet of a repost made today.
const repostOfOldVideo = {
  id: '2085776272484143373',
  text: 'repost regression — an old video reposted today',
  url: 'https://x.com/Sentohua/status/2085776272484143373',
  created_timestamp: 1786122789,
  author: { screen_name: 'Sentohua' },
  reposted_by: { screen_name: 'TopAV', name: 'TopAV' },
  media: { all: [video('22222')] },
};

const idlePost = { id: '2000000000000000000', text: 'older post', created_timestamp: 1700000000, media: { all: [] } };

let mode = 'baseline';

function timeline() {
  const results =
    mode === 'new' ? [newPost, idlePost] : mode === 'repost' ? [repostOfOldVideo, idlePost] : [idlePost];
  return { code: 200, results };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.fxtwitter.com')) {
    return new Response(JSON.stringify(timeline()), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

const kv = new Map();
const env = {
  BOT_TOKEN,
  OWNER_CHAT_ID,
  ADMIN_KEY: 'test-key',
  ACCOUNTS: 'topav',
  STATE: {
    get: async (key) => (kv.has(key) ? kv.get(key) : null),
    put: async (key, value) => {
      kv.set(key, value);
    },
  },
};

async function run(label) {
  const res = await worker.fetch(new Request('https://worker.test/run?key=test-key'), env);
  const body = await res.json();
  const r = body.results?.[0] || {};
  console.log(
    `${label}\n   → ${JSON.stringify({ newPosts: r.newPosts, sent: r.sent, links: r.links, baseline: !!r.baseline, error: r.error })}`
  );
  return r;
}

const checks = [];
const expect = (name, actual, wanted) => {
  const ok = actual === wanted;
  checks.push({ name, actual, wanted, ok });
  if (!ok) console.log(`   ✗ ${name}: expected ${wanted}, got ${actual}`);
};

let r = await run('run 1 — first sight, baseline only');
expect('run 1 sends nothing', r.sent + r.links, 0);
expect('run 1 records a baseline', !!r.baseline, true);

mode = 'new';
r = await run('run 2 — a new post with a video');
expect('run 2 delivers one video', r.sent + r.links, 1);

r = await run('run 3 — nothing changed');
expect('run 3 delivers nothing', r.sent + r.links, 0);

mode = 'repost';
r = await run('run 4 — repost of an OLD video (regression)');
expect('run 4 delivers the reposted video', r.sent + r.links, 1);

r = await run('run 5 — same timeline again');
expect('run 5 delivers nothing twice', r.sent + r.links, 0);

const state = JSON.parse(kv.get('state'));
const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${failed.length ? '✗ FAILED' : '✓ PASSED'} ${checks.length - failed.length}/${checks.length} — state: ${Object.keys(state.seen).length} seen videos, pointer ${state.accounts.topav}`
);
process.exit(failed.length ? 1 : 0);
