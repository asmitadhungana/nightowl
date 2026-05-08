/**
 * Thin wrapper around the Telegram Bot API. We only use a handful of methods,
 * so a fetch wrapper is plenty — no `telegraf` / `grammy` dep.
 */

const TG_API = 'https://api.telegram.org';

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

async function tgCall(token: string, method: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '<unreadable>');
    throw new Error(`telegram ${method} failed (${r.status}): ${text}`);
  }
  return r.json();
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  opts?: { parse_mode?: 'Markdown' | 'HTML'; reply_to_message_id?: number }
): Promise<void> {
  await tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: opts?.parse_mode,
    reply_to_message_id: opts?.reply_to_message_id,
  });
}

export async function deleteMessage(token: string, chatId: number | string, messageId: number): Promise<void> {
  // Telegram returns 400 if the message is too old or already gone. Treat as best-effort.
  try {
    await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    /* swallow */
  }
}
