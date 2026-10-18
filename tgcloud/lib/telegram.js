import { api } from 'sdk';

export async function send(chatId, text, keyboard) {
  const params = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) params.reply_markup = keyboard;
  return api.sendMessage(params);
}

export async function edit(chatId, messageId, text, keyboard) {
  const params = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (keyboard) params.reply_markup = keyboard;
  try {
    return await api.editMessageText(params);
  } catch (error) {
    // 400 = "message is not modified" or the message is gone; nothing to do.
    if (error?.code === 400) return null;
    throw error;
  }
}

export async function answerCallback(callbackQueryId, text) {
  try {
    await api.answerCallbackQuery(
      text ? { callback_query_id: callbackQueryId, text } : { callback_query_id: callbackQueryId }
    );
  } catch {
    // A stale callback is harmless.
  }
}
