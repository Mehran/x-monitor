export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function fmtSize(bytes) {
  if (!bytes) return '?';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n) {
  return String(n).padStart(2, '0');
}

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(Number(ts) * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function fmtAgo(ts) {
  if (!ts) return 'never';
  const d = ts instanceof Date ? ts : new Date(Number(ts) * 1000);
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${pad(m % 60)}:${pad(rest)}`;
  }
  return `${m}:${pad(rest)}`;
}

export function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

/** Accepts @name, name or an x.com/twitter.com profile link. */
export function normalizeUsername(raw) {
  let value = String(raw || '').trim();
  value = value.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '');
  value = value.replace(/^@/, '');
  value = value.split(/[/?#\s]/)[0];
  return /^[A-Za-z0-9_]{1,15}$/.test(value) ? value : null;
}

// Tweet ids are 19-digit numbers: compare as BigInt, never as Number.
export function newerThan(id, reference) {
  if (!reference) return true;
  try {
    return BigInt(String(id)) > BigInt(String(reference));
  } catch {
    return String(id) > String(reference);
  }
}

/**
 * Highest tweet id in a timeline page. The first entry is not necessarily the
 * newest: a pinned post sits at the top regardless of its date, so using it as
 * a baseline would make the whole recent timeline look new.
 */
export function newestId(statuses) {
  let best = null;
  for (const status of statuses || []) {
    if (!status?.id) continue;
    best = best ? maxId(best, status.id) : String(status.id);
  }
  return best;
}

export function maxId(a, b) {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(String(a)) >= BigInt(String(b)) ? a : b;
  } catch {
    return String(a) >= String(b) ? a : b;
  }
}
