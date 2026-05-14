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

export interface SendMessageResult {
  ok: boolean;
  result?: { message_id: number };
}

/**
 * Inline keyboard button — Telegram supports several variants but we only need
 * `url` (open a URL in the user's browser / Telegram client). If we ever need
 * `switch_inline_query` (for the bot's own inline mode) or `callback_data`
 * (for in-chat button presses), extend this union.
 */
export interface InlineKeyboardButton {
  text: string;
  url: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  opts?: {
    parse_mode?: 'Markdown' | 'HTML';
    reply_to_message_id?: number;
    reply_markup?: InlineKeyboardMarkup;
    /** Hides the link preview Telegram auto-generates for URLs in `text`. */
    disable_web_page_preview?: boolean;
  }
): Promise<SendMessageResult | null> {
  try {
    return (await tgCall(token, 'sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: opts?.parse_mode,
      reply_to_message_id: opts?.reply_to_message_id,
      reply_markup: opts?.reply_markup,
      disable_web_page_preview: opts?.disable_web_page_preview,
    })) as SendMessageResult;
  } catch {
    // Caller never expected this to throw before; preserve that. Return null
    // so anyone wanting message_id can detect the failure without try/catch.
    return null;
  }
}

/**
 * Returns the bot's `@username` (without the `@`). Used to construct deep
 * links like `https://t.me/<username>?start=<token>`.
 *
 * Cached in module scope — the username never changes mid-deploy and Telegram's
 * `getMe` is rate-limited per bot. A cold call is ~80ms; subsequent calls
 * within the same Worker isolate are free.
 */
let cachedBotUsername: string | null = null;
export async function getBotUsername(token: string): Promise<string> {
  if (cachedBotUsername) return cachedBotUsername;
  const r = await tgCall(token, 'getMe', {}) as { ok: boolean; result?: { username?: string } };
  const u = r.result?.username;
  if (!u) throw new Error('getMe returned no username — is TG_BOT_TOKEN valid?');
  cachedBotUsername = u;
  return u;
}

export async function deleteMessage(token: string, chatId: number | string, messageId: number): Promise<void> {
  // Telegram returns 400 if the message is too old or already gone. Treat as best-effort.
  try {
    await tgCall(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    /* swallow */
  }
}
