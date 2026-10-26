import { AUTO_CHECK_INTERVAL, AUTO_CHECK_MAX_ACCOUNTS, OWNER_CHAT_ID, PLATFORM_MONITORING } from './config.js';
import { esc, fmtAgo, truncate } from './util.js';

export function mainMenuText({ total, active, sent, lastCheck }) {
  return (
    `🎥 <b>X Video Monitor</b>\n\n` +
    `📺 Accounts: <b>${total}</b> (${active} active)\n` +
    `🎞 Videos delivered: <b>${sent}</b>\n` +
    `🕒 Last check: <b>${fmtAgo(lastCheck)}</b>\n\n`
  );
}

export function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Add account', callback_data: 'add' }, { text: '🔄 Check now', callback_data: 'check' }],
      [{ text: '📋 Accounts', callback_data: 'list' }, { text: '👥 Users', callback_data: 'users' }],
      [{ text: 'ℹ️ Help', callback_data: 'help' }],
    ],
  };
}

/** The reduced menu a non-admin viewer gets: look, don't touch. */
export function viewerKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📋 Accounts', callback_data: 'list' }],
      [{ text: 'ℹ️ Help', callback_data: 'help' }],
    ],
  };
}

export function usersText(rows) {
  if (!rows.length) return '👥 <b>Authorized chats</b>\n\nNo authorized chats yet.';
  const lines = rows.map((row) => {
    const badge = row.chatId === OWNER_CHAT_ID ? '👑' : row.isAdmin ? '🛡' : '👤';
    const role = row.chatId === OWNER_CHAT_ID ? 'owner' : row.isAdmin ? 'admin' : 'viewer';
    return `${badge} <code>${row.chatId}</code> — ${role}`;
  });
  return (
    `👥 <b>Authorized chats</b> (${rows.length})\n\n${lines.join('\n')}\n\n` +
    '👑 owner and 🛡 admins can manage accounts. 👤 viewers can only look around.'
  );
}

export function usersKeyboard(rows) {
  const keyboard = rows
    .filter((row) => row.chatId !== OWNER_CHAT_ID)
    .map((row) => {
      const buttons = [
        {
          text: row.isAdmin ? '⬇️ Make viewer' : '⬆️ Make admin',
          callback_data: `ua:${row.chatId}`,
        },
      ];
      if (!row.fixed) {
        buttons.push({ text: '🗑 Remove', callback_data: `ud:${row.chatId}` });
      }
      return buttons;
    });
  keyboard.push([
    { text: '➕ Add chat ID', callback_data: 'addchat' },
    { text: '⬅️ Menu', callback_data: 'menu' },
  ]);
  return { inline_keyboard: keyboard };
}

export function accountsText(accounts) {
  if (!accounts.length) {
    return '📋 <b>Accounts</b>\n\nNo accounts yet. Tap ➕ Add account to start monitoring one.';
  }
  const lines = accounts.map(
    (account) => `${account.enabled ? '✅' : '⏸'} <b>@${esc(account.username)}</b>`
  );
  return `📋 <b>Accounts</b> (${accounts.length})\n\n${lines.join('\n')}\n\nTap one to manage it.`;
}

export function accountsKeyboard(accounts, admin = true) {
  const rows = accounts.map((account) => [
    {
      text: `${account.enabled ? '✅' : '⏸'} @${account.username}`,
      callback_data: `a:${account.id}`,
    },
  ]);
  rows.push(
    admin
      ? [{ text: '➕ Add account', callback_data: 'add' }, { text: '⬅️ Menu', callback_data: 'menu' }]
      : [{ text: '⬅️ Menu', callback_data: 'menu' }]
  );
  return { inline_keyboard: rows };
}

export function accountText(account) {
  const lines = [
    `📺 <b>@${esc(account.username)}</b>`,
    '',
    `Status: ${account.enabled ? '✅ Active' : '⏸ Paused'}`,
    `Last checked: ${fmtAgo(account.checkedAt)}`,
    `Videos delivered: ${Number(account.sentCount) || 0}`,
    `Last seen post: <code>${esc(account.lastTweetId || 'not checked yet')}</code>`,
  ];
  if (account.lastError) {
    lines.push(`Last error: <i>${esc(truncate(account.lastError, 160))}</i>`);
  }
  return lines.join('\n');
}

export function accountKeyboard(account, admin = true) {
  if (!admin) {
    return {
      inline_keyboard: [[{ text: '⬅️ Accounts', callback_data: 'list' }]],
    };
  }
  return {
    inline_keyboard: [
      [
        {
          text: account.enabled ? '⏸ Pause' : '▶️ Resume',
          callback_data: `t:${account.id}`,
        },
        { text: '✏️ Rename', callback_data: `r:${account.id}` },
      ],
      [{ text: '⬇️ Last 10 videos', callback_data: `b:${account.id}` }],
      [{ text: '🗑 Delete', callback_data: `d:${account.id}` }],
      [{ text: '⬅️ Accounts', callback_data: 'list' }],
    ],
  };
}

export function deleteText(account) {
  return (
    `🗑 <b>Delete @${esc(account.username)}?</b>\n\n` +
    `It will stop being monitored and its delivery history will be removed.`
  );
}

export function deleteKeyboard(account) {
  return {
    inline_keyboard: [
      [{ text: '✅ Yes, delete', callback_data: `dx:${account.id}` }],
      [{ text: '⬅️ Cancel', callback_data: `a:${account.id}` }],
    ],
  };
}

export function checkSummary(results) {
  if (!results.length) return 'No active accounts to check.';
  const lines = results.map((result) => {
    if (result.error) return `⚠️ <b>@${esc(result.username)}</b> — check failed`;
    if (result.baseline) return `➕ <b>@${esc(result.username)}</b> — starting point saved`;
    const parts = [];
    if (result.sent) parts.push(`${result.sent} video${result.sent > 1 ? 's' : ''} uploaded`);
    if (result.links) parts.push(`${result.links} too large → play link${result.links > 1 ? 's' : ''}`);
    if (!parts.length) parts.push('no new videos');
    const waiting = result.deferred ? '\n   <i>more new videos waiting</i>' : '';
    return `• <b>@${esc(result.username)}</b> — ${parts.join(', ')}${waiting}`;
  });
  return `✅ <b>Check complete</b>\n\n${lines.join('\n')}`;
}

export function statusText({ total, active, sent, lastCheck, accounts, cron, cronUrl }) {
  const lines = [
    '📊 <b>Status</b>',
    '',
    `📺 Accounts: <b>${total}</b> (${active} active)`,
    `🎞 Videos delivered: <b>${sent}</b>`,
    `🕒 Last check: <b>${fmtAgo(lastCheck)}</b>`,
  ];

  if (cronUrl) {
    if (cron?.lastRun) {
      const when = fmtAgo(new Date(cron.lastRun));
      lines.push(`☁️ Cron last run: <b>${when}</b> · ${cron.seen ?? 0} video(s) remembered`);
    } else {
      lines.push('☁️ Cron: <i>no admin key saved yet — send /cronkey &lt;key&gt;</i>');
    }
  }

  if (accounts.length) {
    lines.push('', '<b>Accounts</b>');
    for (const account of accounts) {
      const error = account.lastError
        ? `\n   <i>${esc(truncate(account.lastError, 100))}</i>`
        : '';
      lines.push(
        `${account.enabled ? '✅' : '⏸'} <b>@${esc(account.username)}</b> — ` +
          `${Number(account.sentCount) || 0} sent · checked ${fmtAgo(account.checkedAt)}${error}`
      );
    }
  }

  return lines.join('\n');
}

export function workerMonitoringText() {
  return (
    `⏱ <b>Monitoring runs on the Cloudflare cron</b>\n\n` +
    `New videos are posted automatically every 10 minutes by the scheduled worker, so this bot no longer checks or sends on its own — that would duplicate them.\n\n` +
    `Account management, /status and the delivery history still work here.\n\n` +
    `To let this bot send again, set <code>MONITORING_MODE = 'platform'</code> in <code>tgcloud/lib/config.js</code> and push.`
  );
}

export function helpText(admin = true) {
  const minutes = Math.round(AUTO_CHECK_INTERVAL / 60);
  const commands = admin
    ? `<b>Commands</b>\n` +
      `/start, /menu — main menu\n` +
      `/add @username — start monitoring an account\n` +
      `/accounts — view and manage accounts\n` +
      `/check — look for new videos right now\n` +
      `/status — accounts and delivery stats\n` +
      `/users — manage who may use the bot\n` +
      `/help — this message\n\n`
    : `<b>Commands</b>\n` +
      `/start, /menu — main menu\n` +
      `/accounts — view monitored accounts\n` +
      `/status — delivery stats\n` +
      `/help — this message\n\n` +
      `You have <b>view-only</b> access — ask an admin to add or change accounts.\n\n`;

  return (
    `ℹ️ <b>How this bot works</b>\n\n` +
    `It watches X/Twitter accounts and sends every new video to the owner's chat as an mp4 with a thumbnail.\n\n` +
    commands +
    `<b>Notes</b>\n` +
    `• Adding an account starts from its latest post, so old videos are not re-sent.\n` +
    `• Use ⬇️ Last 10 videos for the recent backlog.\n` +
    (PLATFORM_MONITORING
      ? `• This platform has no background timer, so checks are triggered by activity: any message or button tap starts one, at most every ${minutes} minutes, covering ${AUTO_CHECK_MAX_ACCOUNTS} accounts each time (the least recently checked ones).\n` +
        `• Tap 🔄 Check now (or send /check) to check every account immediately.\n`
      : `• New videos are posted automatically by the Cloudflare cron every ${minutes} minutes (see cron/README.md).\n`) +
    `• Telegram bots can upload files up to 50 MB. Larger videos arrive as a poster with a ▶️ button that streams the full-quality video in Telegram, at any length.`
  );
}
