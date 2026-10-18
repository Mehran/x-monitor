// handlers/callback_query.js — inline keyboard actions.
import { OWNER_CHAT_ID, PLATFORM_MONITORING } from '../lib/config.js';
import { autoCheck } from '../lib/autocheck.js';
import { syncCronFromStore } from '../lib/cron.js';
import { backfillAccount, checkAll } from '../lib/monitor.js';
import * as store from '../lib/accounts.js';
import { setPending } from '../lib/state.js';
import { answerCallback, edit } from '../lib/telegram.js';
import { accountView, helpView, listView, menuView } from '../lib/views.js';
import * as ui from '../lib/ui.js';
import { esc } from '../lib/util.js';

const CANCEL_KEYBOARD = {
  inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'menu' }]],
};

export default async function (query) {
  const chatId = query?.message?.chat?.id;
  const messageId = query?.message?.message_id;
  if (chatId !== OWNER_CHAT_ID || !messageId) {
    await answerCallback(query?.id);
    return;
  }

  try {
    await handleQuery(query, chatId, messageId);
  } catch (error) {
    console.error('callback failed', query.data, error);
    await answerCallback(query.id, 'Something went wrong');
    try {
      await edit(chatId, messageId, `⚠️ <b>Something went wrong</b>\n\n<code>${esc(error?.message || error)}</code>`, ui.mainMenuKeyboard());
    } catch {
      // ignore secondary failures
    }
  }

  // Tapping buttons keeps monitoring alive even when you never type a message.
  await autoCheck();
}

async function handleQuery(query, chatId, messageId) {
  const [action, value] = (query.data || '').split(':');

  switch (action) {
    case 'menu': {
      const view = await menuView();
      await answerCallback(query.id);
      return edit(chatId, messageId, view.text, view.keyboard);
    }

    case 'help': {
      const view = helpView();
      await answerCallback(query.id);
      return edit(chatId, messageId, view.text, view.keyboard);
    }

    case 'list': {
      const view = await listView();
      await answerCallback(query.id);
      return edit(chatId, messageId, view.text, view.keyboard);
    }

    case 'add': {
      await setPending({ action: 'add' });
      await answerCallback(query.id);
      return edit(
        chatId,
        messageId,
        '➕ <b>Add an account</b>\n\nSend the X username, for example <code>@topav</code>.',
        CANCEL_KEYBOARD
      );
    }

    case 'check': {
      if (!PLATFORM_MONITORING) {
        await answerCallback(query.id);
        return edit(chatId, messageId, ui.workerMonitoringText(), ui.mainMenuKeyboard());
      }
      await answerCallback(query.id, 'Checking…');
      await edit(chatId, messageId, '🔄 <b>Checking accounts…</b>');
      const result = await checkAll({ manual: true });
      const text = result.busy
        ? '⏳ <b>A check is already running.</b>\n\nTry again in a minute.'
        : ui.checkSummary(result.results);
      return edit(chatId, messageId, text, ui.mainMenuKeyboard());
    }

    case 'a': {
      const view = await accountView(value);
      await answerCallback(query.id);
      if (!view) return edit(chatId, messageId, 'That account no longer exists.', ui.mainMenuKeyboard());
      return edit(chatId, messageId, view.text, view.keyboard);
    }

    case 't': {
      const account = await store.getAccount(value);
      if (!account) {
        await answerCallback(query.id, 'Account not found');
        return;
      }
      await store.updateAccount(account.id, { enabled: !account.enabled });
      await syncCronFromStore();
      const view = await accountView(account.id);
      await answerCallback(query.id, account.enabled ? 'Paused' : 'Resumed');
      return edit(chatId, messageId, view.text, view.keyboard);
    }

    case 'r': {
      const account = await store.getAccount(value);
      if (!account) {
        await answerCallback(query.id, 'Account not found');
        return;
      }
      await setPending({ action: 'rename', accountId: account.id });
      await answerCallback(query.id);
      return edit(
        chatId,
        messageId,
        `✏️ <b>Rename @${esc(account.username)}</b>\n\nSend the new X username, for example <code>@topav</code>.`,
        CANCEL_KEYBOARD
      );
    }

    case 'b': {
      const account = await store.getAccount(value);
      if (!account) {
        await answerCallback(query.id, 'Account not found');
        return;
      }
      if (!PLATFORM_MONITORING) {
        await answerCallback(query.id);
        return edit(chatId, messageId, ui.workerMonitoringText(), ui.mainMenuKeyboard());
      }
      await answerCallback(query.id, 'Sending recent videos…');
      await edit(chatId, messageId, `⬇️ <b>Fetching recent videos from @${esc(account.username)}…</b>`);
      const result = await backfillAccount(account);
      const fresh = await store.getAccount(account.id);
      const summary = result.sent || result.links
        ? `✅ Sent <b>${result.sent}</b> video(s)${result.links ? ` and <b>${result.links}</b> link(s)` : ''} from <b>@${esc(account.username)}</b>.`
        : `ℹ️ No new videos available to backfill for <b>@${esc(account.username)}</b>.`;
      return edit(chatId, messageId, summary, ui.accountKeyboard(fresh));
    }

    case 'd': {
      const account = await store.getAccount(value);
      await answerCallback(query.id);
      if (!account) return edit(chatId, messageId, 'That account no longer exists.', ui.mainMenuKeyboard());
      return edit(chatId, messageId, ui.deleteText(account), ui.deleteKeyboard(account));
    }

    case 'dx': {
      const account = await store.getAccount(value);
      await answerCallback(query.id, 'Deleted');
      if (account) await store.deleteAccount(account.id);
      await syncCronFromStore();
      const view = await listView();
      const header = account ? `🗑 Removed <b>@${esc(account.username)}</b>.\n\n` : '';
      return edit(chatId, messageId, header + view.text, view.keyboard);
    }

    default:
      return answerCallback(query.id);
  }
}
