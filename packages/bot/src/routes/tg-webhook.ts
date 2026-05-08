/**
 * POST /tg/webhook/<TG_WEBHOOK_SECRET>
 *
 * Telegram pushes Update objects here. We dispatch on the leading slash-command.
 *
 * Plaintext-password lifecycle (the security crux): /setpassword <pw> arrives,
 * we IMMEDIATELY delete the user's message via deleteMessage. The plaintext
 * exists only in this Worker invocation's memory. We bcrypt it, sign the hash
 * with the bot's key, push the signed hash to the inbox. The Worker itself
 * never persists or logs the plaintext (Workers logs are off via wrangler.toml).
 */

import type { Env } from '../env.js';
import type { TelegramUpdate } from '../telegram.js';
import { sendMessage, deleteMessage } from '../telegram.js';
import {
  getPairCode,
  deletePairCode,
  getPairing,
  putPairing,
  appendInbox,
} from '../kv.js';
import {
  bcryptHash,
  botMessagePreimage,
  botSign,
  canonicalJson,
} from '../crypto.js';
import type { InboxMessage, Pairing } from '../types.js';
import { emptyOk } from '../response.js';

export async function handleTelegramWebhook(req: Request, env: Env, secret: string): Promise<Response> {
  if (secret !== env.TG_WEBHOOK_SECRET) {
    // Pretend we don't exist — never confirm the URL exists.
    return new Response('not found', { status: 404 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const msg = update.message;
  if (!msg || !msg.text || !msg.from) return emptyOk();

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  try {
    if (text.startsWith('/start')) {
      // /start CODE  ← deep link form (t.me/<bot>?start=CODE puts CODE here)
      const arg = text.slice('/start'.length).trim();
      if (arg && /^[A-Z2-9]{8}$/.test(arg)) {
        await handlePair(env, msg.from.id, msg.from.first_name, msg.message_id, chatId, arg);
      } else {
        await sendMessage(env.TG_BOT_TOKEN, chatId, START_MESSAGE);
      }
    } else if (text.startsWith('/pair')) {
      const code = text.slice('/pair'.length).trim().toUpperCase().replace(/-/g, '');
      if (!/^[A-Z2-9]{8}$/.test(code)) {
        await sendMessage(env.TG_BOT_TOKEN, chatId, "I need an 8-character code, like X4PQ7M2K. Ask your friend to generate one in NightOwl → Friend Lock → Generate Pair Code.");
      } else {
        await handlePair(env, msg.from.id, msg.from.first_name, msg.message_id, chatId, code);
      }
    } else if (text.startsWith('/setpassword')) {
      // Delete the friend's plaintext message FIRST, before we even peek at it.
      // Then read the password out of `text` (which is just a copy in this isolate).
      await deleteMessage(env.TG_BOT_TOKEN, chatId, msg.message_id);
      const pw = text.slice('/setpassword'.length).trim();
      await handleSetPassword(env, chatId, pw);
    } else if (text === '/help') {
      await sendMessage(env.TG_BOT_TOKEN, chatId, HELP_MESSAGE);
    } else if (text === '/status') {
      await handleStatus(env, chatId);
    } else {
      await sendMessage(env.TG_BOT_TOKEN, chatId, "I don't recognize that. Type /help for what I can do.");
    }
  } catch (e) {
    // Never leak details of internal errors to chat — a stack trace might echo a password fragment.
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Something went wrong on my side. Try again in a moment.").catch(() => {});
  }

  return emptyOk();
}

const START_MESSAGE = `🦉 NightOwl Friend Lock

I help you set a curfew password for a friend who is using NightOwl. They can't bypass the lock — only you have the password.

To get started:
1. Ask your friend for an 8-character pair code (NightOwl → Friend Lock → Generate Pair Code).
2. Send me /pair <CODE>
3. Send me /setpassword <password> — pick something memorable. I'll delete your message immediately.

That's it. Your friend's lock activates the moment I forward the password.`;

const HELP_MESSAGE = `Commands:
/pair <CODE>         — claim a pair code your friend gave you
/setpassword <PW>    — set their lock password (sent over Telegram, deleted immediately)
/status              — show your active pairings
/help                — this message

Privacy: I never store your password. I hash it in memory (bcrypt) and forward only the hash to your friend's machine.`;

/** Handle /pair CODE. */
async function handlePair(
  env: Env,
  fromUserId: number,
  fromFirstName: string,
  _messageId: number,
  chatId: number,
  code: string
): Promise<void> {
  const rec = await getPairCode(env, code);
  if (!rec) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "That code is wrong or expired. Codes last 5 minutes — ask your friend to generate a new one.");
    return;
  }
  const pairing = await getPairing(env, rec.pairingId);
  if (!pairing) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Pairing record missing. Ask your friend to generate a fresh code.");
    await deletePairCode(env, code);
    return;
  }
  if (pairing.status !== 'pending') {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "This pairing is already active. Use /setpassword <PW> to set the lock password.");
    return;
  }

  pairing.friendChatId = String(fromUserId);
  pairing.friendName = fromFirstName;
  pairing.status = 'active';
  pairing.botSeq += 1;

  // Burn the pair code — single-use.
  await deletePairCode(env, code);

  // Push pair_complete message to desktop inbox, signed.
  const payload = { friendName: fromFirstName, friendChatId: String(fromUserId) };
  const preimage = botMessagePreimage(pairing.pairingId, pairing.botSeq, 'pair_complete', payload);
  const sig = await botSign(env.BOT_ED25519_PRIVKEY, preimage);
  const message: InboxMessage = {
    seq: pairing.botSeq,
    kind: 'pair_complete',
    payload,
    sig,
  };
  await appendInbox(env, pairing.pairingId, message);
  await putPairing(env, pairing);

  await sendMessage(
    env.TG_BOT_TOKEN,
    chatId,
    `✓ Paired with your friend's NightOwl.\n\nNow send me the lock password:\n/setpassword <password>\n\nPick something memorable — your friend won't see it. They'll be locked out of their machine until you (or the timer) release them.`,
    { parse_mode: 'Markdown' }
  );
}

/** Handle /setpassword <pw>. The user message is already deleted by caller. */
async function handleSetPassword(env: Env, chatId: number, pw: string): Promise<void> {
  if (pw.length < 4) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Password must be at least 4 characters. Try again with /setpassword <password>.");
    return;
  }
  if (pw.length > 100) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "Password must be at most 100 characters.");
    return;
  }

  // Find this friend's active pairing. v2.0.0-alpha supports one active pairing per friend chat.
  // For multi-pair (one friend serving multiple users), we'd need a friend-side selector; out of scope.
  const pairing = await findActivePairingByFriend(env, String(chatId));
  if (!pairing) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "You haven't paired with anyone yet. Send /pair <CODE> first.");
    return;
  }
  if (pairing.passwordConsumed) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "The password for this lock has already been set. To change it, your friend must request emergency uninstall and re-pair.");
    return;
  }

  const hash = await bcryptHash(pw);
  pairing.botSeq += 1;
  pairing.passwordConsumed = true;

  const payload = { hash, passwordSetAt: new Date().toISOString() };
  const preimage = botMessagePreimage(pairing.pairingId, pairing.botSeq, 'password_hash', payload);
  const sig = await botSign(env.BOT_ED25519_PRIVKEY, preimage);
  const message: InboxMessage = {
    seq: pairing.botSeq,
    kind: 'password_hash',
    payload,
    sig,
  };
  await appendInbox(env, pairing.pairingId, message);
  await putPairing(env, pairing);

  await sendMessage(
    env.TG_BOT_TOKEN,
    chatId,
    "✓ Password sent. Your friend's lock will activate the moment their NightOwl polls me (within ~10 seconds).\n\n*Save the password somewhere safe* — only you have it now.",
    { parse_mode: 'Markdown' }
  );
}

async function handleStatus(env: Env, chatId: number): Promise<void> {
  const pairing = await findActivePairingByFriend(env, String(chatId));
  if (!pairing) {
    await sendMessage(env.TG_BOT_TOKEN, chatId, "No active pairings. Send /pair <CODE> to get started.");
    return;
  }
  const passwordSet = pairing.passwordConsumed ? "yes" : "no — send /setpassword <PW>";
  await sendMessage(
    env.TG_BOT_TOKEN,
    chatId,
    `Active pairing:\n• id: \`${pairing.pairingId.slice(0, 8)}…\`\n• status: ${pairing.status}\n• password set: ${passwordSet}\n• paired since: ${pairing.createdAt}`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Scan KV `pair:` namespace for the friend's active pairing.
 *
 * KV listing has a small per-page cost; for v2.0.0-alpha (one user, one friend)
 * the cost is negligible. If we ever need this to scale, add a reverse index
 * `friend:<chatId>` → pairingId on /pair completion. Marked TODO.
 */
async function findActivePairingByFriend(env: Env, friendChatId: string): Promise<Pairing | null> {
  const list = await env.NIGHTOWL_KV.list({ prefix: 'pair:' });
  for (const k of list.keys) {
    const raw = await env.NIGHTOWL_KV.get(k.name);
    if (!raw) continue;
    const p = JSON.parse(raw) as Pairing;
    if (p.friendChatId === friendChatId && p.status === 'active') {
      return p;
    }
  }
  // Suppress unused-import warning for canonicalJson via a noop ref — keeps the
  // dep graph honest; tree-shaker drops it.
  void canonicalJson;
  return null;
}
