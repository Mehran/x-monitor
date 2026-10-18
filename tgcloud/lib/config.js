// Everything tunable lives here.

// Only this chat may talk to the bot. Everything else is ignored silently.
export const OWNER_CHAT_ID = 779298050;

// Cloudflare cron worker (cron/) — the 24/7 scheduler. Adding, renaming,
// pausing or deleting an account here pushes the enabled list to it.
export const CRON_URL = 'https://topav-monitor.reyhaneh-fc0.workers.dev';

// Who sends videos:
//   'platform' — this bot checks on activity (message/button) and sends.
//   'worker'   — the Cloudflare cron in cron/ checks and sends; this bot keeps
//                the account UI and history but never sends (avoids duplicates).
export const MONITORING_MODE = 'worker';
export const PLATFORM_MONITORING = MONITORING_MODE === 'platform';

// Auto-check (runs on any message or button tap, at most once per interval).
// Each auto-run covers this many of the least recently checked accounts, so
// with more accounts than this they still all come round within a few runs.
export const AUTO_CHECK_INTERVAL = 10 * 60; // seconds
export const AUTO_CHECK_MAX_ACCOUNTS = 4;
export const AUTO_CHECK_MAX_VIDEOS = 4;

// Manual /check.
export const CHECK_MAX_VIDEOS = 8;

// Bot API uploads are capped at 50 MB; stay safely below. The platform also
// caps a single HTTP response at 30 MB, so downloads use ranged requests.
export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

// Videos above the Bot API limit are delivered as a poster + a play button.
// The button streams the original mp4, so any length plays.
//
// MIRROR_ENABLED also queues a copy on a public host that downloads the video
// itself (this bot cannot push more than ~50 MB per request). That host is
// best-effort: it is a free service and its encoder is unreliable, so the
// mirror button may lead to a page that never finishes processing.
export const MIRROR_ENABLED = false;

// How many timeline pages (20 tweets each) a single check may walk.
export const MAX_TIMELINE_PAGES = 5;
export const MAX_BACKFILL_VIDEOS = 10;

// Ignore a check that started less than this many seconds ago (other invocation).
export const CHECK_LOCK_SECONDS = 240;

export const MAX_CAPTION_CHARS = 900;
