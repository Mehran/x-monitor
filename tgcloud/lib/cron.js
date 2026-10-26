import { fetch } from 'sdk';
import { CRON_URL } from './config.js';
import { listAccounts } from './accounts.js';
import { listRecipientChatIds } from './access.js';
import { getState } from './state.js';

/**
 * Keep the Cloudflare cron's account list in step with this bot's, so adding,
 * renaming, pausing or deleting an account here is all it takes — the cron
 * covers posts *and* reposts of whatever is enabled.
 *
 * The admin key is stored in the bot's database (see /cronkey), not in code.
 */
export async function syncCronAccounts(usernames) {
  if (!CRON_URL) return { ok: false, reason: 'CRON_URL is not configured' };

  const key = await getState('cron_admin_key', null);
  if (!key) return { ok: false, reason: 'no admin key saved yet — send /cronkey <key>' };

  try {
    const res = await fetch(`${CRON_URL}/accounts?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(usernames),
    });
    if (!res.ok) return { ok: false, reason: `cron returned ${res.status}` };
    return { ok: true };
  } catch (error) {
    console.error('cron account sync failed', error);
    return { ok: false, reason: String(error?.message || error) };
  }
}

/** Push the current enabled accounts and recipients. Fire-and-forget friendly. */
export async function syncCronFromStore() {
  try {
    const accounts = await listAccounts();
    const enabled = accounts.filter((a) => a.enabled).map((a) => a.username);
    const result = await syncCronAccounts(enabled);
    // Recipients decide which chats the cron posts videos to.
    await syncCronRecipients(await listRecipientChatIds());
    return result;
  } catch (error) {
    console.error('cron account sync failed', error);
    return { ok: false, reason: String(error?.message || error) };
  }
}

/** Push the list of chats that should receive videos. */
export async function syncCronRecipients(chatIds) {
  if (!CRON_URL) return { ok: false, reason: 'CRON_URL is not configured' };

  const key = await getState('cron_admin_key', null);
  if (!key) return { ok: false, reason: 'no admin key saved yet — send /cronkey <key>' };

  try {
    const res = await fetch(`${CRON_URL}/recipients?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chatIds),
    });
    if (!res.ok) return { ok: false, reason: `cron returned ${res.status}` };
    return { ok: true };
  } catch (error) {
    console.error('cron recipient sync failed', error);
    return { ok: false, reason: String(error?.message || error) };
  }
}

/**
 * Ask the cron to send a freshly authorized chat the newest videos the group
 * has already received, so a new user starts with content. The cron schedules
 * the sends in the background and answers at once. `dry` returns the pick
 * without sending (for testing).
 */
export async function welcomeChat(chatId, count, dry = false) {
  if (!CRON_URL) return { ok: false, reason: 'CRON_URL is not configured' };

  const key = await getState('cron_admin_key', null);
  if (!key) return { ok: false, reason: 'no admin key saved yet — send /cronkey <key>' };

  try {
    const res = await fetch(`${CRON_URL}/welcome?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: Number(chatId), count, dry }),
    });
    if (!res.ok) return { ok: false, reason: `cron returned ${res.status}` };
    return await res.json();
  } catch (error) {
    console.error('cron welcome failed', error);
    return { ok: false, reason: String(error?.message || error) };
  }
}

/** Read the cron's own status (pointers, last run) for the bot's /status. */
export async function fetchCronStatus() {
  if (!CRON_URL) return null;
  const key = await getState('cron_admin_key', null);
  if (!key) return null;
  try {
    const res = await fetch(`${CRON_URL}/?key=${encodeURIComponent(key)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    console.error('cron status failed', error);
    return null;
  }
}
