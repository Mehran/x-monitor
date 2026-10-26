// handlers/message.js — commands, access control, pending input and auto-check.
// The platform calls the default export with the Update's `message` payload.

import { CRON_URL, PLATFORM_MONITORING, WELCOME_VIDEO_COUNT } from '../lib/config.js';
import { autoCheck } from '../lib/autocheck.js';
import { fetchCronStatus, syncCronFromStore, welcomeChat } from '../lib/cron.js';
import { fetchProfile } from '../lib/fx.js';
import { checkAll } from '../lib/monitor.js';
import * as access from '../lib/access.js';
import * as store from '../lib/accounts.js';
import { getPending, getState, setPending, setState } from '../lib/state.js';
import { send } from '../lib/telegram.js';
import { helpView, listView, menuView, usersView } from '../lib/views.js';
import * as ui from '../lib/ui.js';
import { esc, normalizeUsername } from '../lib/util.js';

const UNAUTHORIZED_TEXT =
  '🚫 You are not Authorized\n\nSend your CHAT_ID to Mehran to gain access to the bot.';

const ADMIN_ONLY_TEXT = '🔒 This is for admins only.';

const CANCEL_KEYBOARD = {
  inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'menu' }]],
};

// Commands a viewer may run; everything else needs admin.
const VIEWER_COMMANDS = new Set(['start', 'menu', 'help', 'accounts', 'list', 'status']);

export default async function (message) {
  const chatId = message?.chat?.id;
  if (!chatId) return;

  if (!(await access.isAuthorized(chatId))) {
    try {
      await send(chatId, UNAUTHORIZED_TEXT);
    } catch {
      // Chat may not exist; ignore.
    }
    return;
  }

  const admin = await access.isAdmin(chatId);
  const keyboard = admin ? ui.mainMenuKeyboard() : ui.viewerKeyboard();

  try {
    await handleMessage(message, chatId, admin);
  } catch (error) {
    console.error('message handler failed', error);
    try {
      await send(
        chatId,
        `⚠️ <b>Something went wrong</b>\n\n<code>${esc(error?.message || error)}</code>`,
        keyboard
      );
    } catch {
      // Ignore secondary failures.
    }
  }

  // Every admin message keeps monitoring alive (throttled; no-op in worker mode).
  if (admin) await autoCheck();
}

async function handleMessage(message, chatId, admin) {
  const raw = String(message?.text || '').trim();
  const [first, ...rest] = raw.split(/\s+/);
  const command = first?.startsWith('/') ? first.slice(1).split('@')[0].toLowerCase() : '';

  if (command) {
    return runCommand(command, rest.join(' ').trim(), chatId, admin);
  }

  // A button started an add/rename/add-chat flow: the next message is the value.
  const pending = await getPending();
  if (admin && pending && raw) {
    if (pending.action === 'add') return handleAdd(raw, chatId);
    if (pending.action === 'rename') return handleRename(pending.accountId, raw, chatId);
    if (pending.action === 'addchat') return handleAddChat(raw, chatId);
  }

  // Anything else is just activity: it keeps monitoring alive without replying,
  // so the bot never echoes arbitrary messages.
  return;
}

async function runCommand(command, arg, chatId, admin) {
  if (!VIEWER_COMMANDS.has(command) && !admin) {
    return send(chatId, ADMIN_ONLY_TEXT, ui.viewerKeyboard());
  }

  switch (command) {
    case 'start':
    case 'menu': {
      const view = await menuView('', admin);
      return send(chatId, view.text, view.keyboard);
    }

    case 'help': {
      const view = helpView(admin);
      return send(chatId, view.text, view.keyboard);
    }

    case 'accounts':
    case 'list': {
      const view = await listView(admin);
      return send(chatId, view.text, view.keyboard);
    }

    case 'add': {
      if (!arg) {
        await setPending({ action: 'add' });
        return send(
          chatId,
          '➕ <b>Add an account</b>\n\nSend the X username, for example <code>@topav</code>.',
          CANCEL_KEYBOARD
        );
      }
      return handleAdd(arg, chatId);
    }

    case 'check':
      return handleCheck(chatId);

    case 'status':
      return handleStatus(chatId);

    case 'pause':
      return handleToggle(arg, false, chatId);

    case 'resume':
      return handleToggle(arg, true, chatId);

    case 'remove':
    case 'delete':
      return handleRemove(arg, chatId);

    case 'users':
      return handleUsers(chatId);

    case 'addchat':
      if (!arg) {
        await setPending({ action: 'addchat' });
        return send(
          chatId,
          '➕ <b>Add a chat</b>\n\nSend the numeric chat ID to authorize as a viewer.',
          CANCEL_KEYBOARD
        );
      }
      return handleAddChat(arg, chatId);

    case 'cronkey':
      return handleCronKey(arg, chatId);

    default:
      return send(
        chatId,
        `❓ Unknown command <code>/${esc(command)}</code>. Send /help for what I can do.`,
        admin ? ui.mainMenuKeyboard() : ui.viewerKeyboard()
      );
  }
}

async function handleAdd(raw, chatId) {
  const username = normalizeUsername(raw);
  if (!username) {
    return send(
      chatId,
      '⚠️ That does not look like an X username. Send it like <code>@topav</code>.',
      CANCEL_KEYBOARD
    );
  }

  const existing = await store.getAccountByUsername(username);
  if (existing) {
    await setPending(null);
    return send(chatId, `ℹ️ <b>@${esc(existing.username)}</b> is already being monitored.`, ui.mainMenuKeyboard());
  }

  try {
    await fetchProfile(username);
  } catch (error) {
    await setPending(null);
    return send(
      chatId,
      `⚠️ Could not verify <b>@${esc(username)}</b> on X (<i>${esc(error?.message || error)}</i>).\n\n` +
        'Check the spelling and try again.',
      CANCEL_KEYBOARD
    );
  }

  const account = await store.createAccount(username, null);
  await setPending(null);
  const sync = await syncCronFromStore();
  const note = sync.ok ? '' : `\n\n<i>Note: the Cloudflare cron was not updated (${esc(sync.reason)}).</i>`;

  return send(
    chatId,
    `✅ Now monitoring <b>@${esc(account.username)}</b>.\n\n` +
      'Starting from its newest post, so old videos are not re-sent. ' +
      'Use <b>⬇️ Last 10 videos</b> for the recent backlog.' +
      note,
    ui.mainMenuKeyboard()
  );
}

async function handleRename(accountId, raw, chatId) {
  const account = await store.getAccount(accountId);
  if (!account) {
    await setPending(null);
    return send(chatId, 'That account no longer exists.', ui.mainMenuKeyboard());
  }

  const username = normalizeUsername(raw);
  if (!username) {
    return send(
      chatId,
      '⚠️ That does not look like an X username. Send it like <code>@topav</code>.',
      CANCEL_KEYBOARD
    );
  }

  const clash = await store.getAccountByUsername(username);
  if (clash && clash.id !== account.id) {
    await setPending(null);
    return send(chatId, `ℹ️ <b>@${esc(username)}</b> is already being monitored.`, ui.mainMenuKeyboard());
  }

  await store.updateAccount(account.id, { username: username.toLowerCase() });
  await setPending(null);
  const sync = await syncCronFromStore();
  const note = sync.ok ? '' : `\n\n<i>Note: the Cloudflare cron was not updated (${esc(sync.reason)}).</i>`;
  return send(chatId, `✅ Renamed to <b>@${esc(username)}</b>.${note}`, ui.mainMenuKeyboard());
}

async function handleToggle(raw, enabled, chatId) {
  const username = normalizeUsername(raw);
  if (!username) {
    const usage = enabled ? '/resume @username' : '/pause @username';
    return send(chatId, `Usage: <code>${usage}</code>`, ui.mainMenuKeyboard());
  }

  const account = await store.getAccountByUsername(username);
  if (!account) {
    return send(chatId, `No account <b>@${esc(username)}</b> is being monitored.`, ui.mainMenuKeyboard());
  }

  await store.updateAccount(account.id, { enabled });
  await syncCronFromStore();
  return send(
    chatId,
    `${enabled ? '▶️ Resumed' : '⏸ Paused'} <b>@${esc(account.username)}</b>.`,
    ui.mainMenuKeyboard()
  );
}

async function handleRemove(raw, chatId) {
  const username = normalizeUsername(raw);
  if (!username) {
    return send(chatId, 'Usage: <code>/remove @username</code>', ui.mainMenuKeyboard());
  }

  const account = await store.getAccountByUsername(username);
  if (!account) {
    return send(chatId, `No account <b>@${esc(username)}</b> is being monitored.`, ui.mainMenuKeyboard());
  }

  await store.deleteAccount(account.id);
  await syncCronFromStore();
  return send(
    chatId,
    `🗑 Removed <b>@${esc(account.username)}</b> and its delivery history.`,
    ui.mainMenuKeyboard()
  );
}

async function handleCheck(chatId) {
  if (!PLATFORM_MONITORING) {
    return send(chatId, ui.workerMonitoringText(), ui.mainMenuKeyboard());
  }

  const result = await checkAll({ manual: true });
  const text = result.busy
    ? '⏳ <b>A check is already running.</b>\n\nTry again in a minute.'
    : ui.checkSummary(result.results);
  return send(chatId, text, ui.mainMenuKeyboard());
}

async function handleStatus(chatId) {
  const [total, active, sent, lastCheck, accounts, cron] = await Promise.all([
    store.countAccounts(),
    store.countActiveAccounts(),
    store.countSentVideos(),
    getState('last_check', null),
    store.listAccounts(),
    fetchCronStatus(),
  ]);

  const text = ui.statusText({
    total,
    active,
    sent,
    lastCheck: lastCheck ? new Date(Number(lastCheck) * 1000) : null,
    accounts,
    cron,
    cronUrl: CRON_URL,
  });
  return send(chatId, text, ui.mainMenuKeyboard());
}

async function handleUsers(chatId) {
  const view = await usersView();
  return send(chatId, view.text, view.keyboard);
}

async function handleAddChat(raw, chatId) {
  const id = String(raw).trim();
  if (!/^-?\d+$/.test(id)) {
    return send(chatId, '⚠️ Send a numeric chat ID, for example <code>123456789</code>.', CANCEL_KEYBOARD);
  }

  const existing = await access.getAuthorized(Number(id));
  await access.addAuthorized(id, false);
  await setPending(null);
  await syncCronFromStore();

  // A brand-new chat gets the latest videos so it has something to watch.
  let welcome = '';
  if (!existing) {
    const res = await welcomeChat(Number(id), WELCOME_VIDEO_COUNT);
    welcome = res.ok
      ? `\n\n📼 Sending the last <b>${WELCOME_VIDEO_COUNT}</b> videos to <code>${esc(id)}</code>…`
      : `\n\n<i>Welcome videos not queued: ${esc(res.reason || 'unknown error')}.</i>`;
  }

  const view = await usersView();
  return send(chatId, `✅ Added <code>${esc(id)}</code> as a viewer.${welcome}\n\n${view.text}`, view.keyboard);
}

async function handleCronKey(arg, chatId) {
  if (!CRON_URL) {
    return send(chatId, '☁️ No cron is configured for this bot.', ui.mainMenuKeyboard());
  }

  if (!arg) {
    const [saved, cron] = await Promise.all([getState('cron_admin_key', null), fetchCronStatus()]);
    const keyLine = saved
      ? 'An admin key is saved.'
      : 'No admin key saved yet — send <code>/cronkey &lt;key&gt;</code> to set one.';
    const statusLine = cron
      ? `\nLast run: <b>${cron.lastRun ? esc(new Date(cron.lastRun).toISOString()) : 'never'}</b>\n` +
        `Accounts: <b>${Array.isArray(cron.accounts) ? cron.accounts.length : 0}</b> · ` +
        `Videos remembered: <b>${cron.seen ?? 0}</b>`
      : '\n<i>Cron is not reachable (or the saved key is wrong).</i>';
    return send(chatId, `☁️ <b>Cloudflare cron</b>\n\n${esc(CRON_URL)}\n\n${keyLine}${statusLine}`, ui.mainMenuKeyboard());
  }

  await setState('cron_admin_key', arg.trim());
  const sync = await syncCronFromStore();
  const text = sync.ok
    ? '✅ Admin key saved and the account list was pushed to the cron.'
    : `⚠️ Key saved, but syncing failed: <i>${esc(sync.reason)}</i>`;
  return send(chatId, text, ui.mainMenuKeyboard());
}
