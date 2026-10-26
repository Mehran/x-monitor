import { PLATFORM_MONITORING } from './config.js';
import { getState } from './state.js';
import * as access from './access.js';
import * as store from './accounts.js';
import * as ui from './ui.js';

export async function menuView(header = '', admin = true) {
  const [total, active, sent, lastCheck] = await Promise.all([
    store.countAccounts(),
    store.countActiveAccounts(),
    store.countSentVideos(),
    getState('last_check', null),
  ]);

  const text =
    (header ? `${header}\n\n` : '') +
    ui.mainMenuText({
      total,
      active,
      sent,
      lastCheck: lastCheck ? new Date(Number(lastCheck) * 1000) : null,
    }) +
    (PLATFORM_MONITORING
      ? 'Auto-checks run whenever you message me or tap a button (max once every 10 minutes, a few accounts per run). Use /check to check everything right now.'
      : 'New videos are posted automatically by the Cloudflare cron (every 10 minutes) — this bot only manages accounts now.');

  return { text, keyboard: admin ? ui.mainMenuKeyboard() : ui.viewerKeyboard() };
}

export async function listView(admin = true) {
  const accounts = await store.listAccounts();
  return { text: ui.accountsText(accounts), keyboard: ui.accountsKeyboard(accounts, admin) };
}

export async function accountView(id, admin = true) {
  const account = await store.getAccount(id);
  if (!account) return null;
  return { text: ui.accountText(account), keyboard: ui.accountKeyboard(account, admin) };
}

export function helpView(admin = true) {
  return { text: ui.helpText(admin), keyboard: admin ? ui.mainMenuKeyboard() : ui.viewerKeyboard() };
}

export async function usersView() {
  const rows = await access.listAuthorized();
  return { text: ui.usersText(rows), keyboard: ui.usersKeyboard(rows) };
}
