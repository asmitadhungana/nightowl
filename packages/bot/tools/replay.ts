/**
 * Local replay tool — mints signed bot messages and pushes them into the bot
 * via direct KV access (or by writing to a local stub). Lets us drive the
 * desktop alpha without standing up a real Telegram bot.
 *
 * Usage:
 *   node --experimental-strip-types tools/replay.ts pair --code X4PQ7M2K --as-friend "TestFriend"
 *   node --experimental-strip-types tools/replay.ts setpassword --pairing <id> --password Hunter2
 *
 * Requires:
 *   - `wrangler dev` running locally (default http://localhost:8787)
 *   - BOT_ED25519_PRIVKEY exported in env (or read from ../secrets/bot-private-key.hex)
 *
 * For alpha we keep this simple: it talks to the local Worker via HTTP, so it
 * goes through the same code paths as a real Telegram update would.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BOT_URL = process.env.BOT_URL || 'http://localhost:8787';

function loadBotPrivkey(): string {
  if (process.env.BOT_ED25519_PRIVKEY) return process.env.BOT_ED25519_PRIVKEY.trim();
  const fallback = resolve(import.meta.dirname ?? '.', '..', 'secrets', 'bot-private-key.hex');
  return readFileSync(fallback, 'utf8').trim();
}

function usage(): never {
  console.error(`Usage:
  replay pair         --code <CODE> --as-friend <NAME> [--chat-id <ID>]
  replay setpassword  --pairing <ID> --password <PW> [--chat-id <ID>]

Both subcommands fake a Telegram update and POST it to ${BOT_URL}/tg/webhook/<SECRET>.

Set TG_WEBHOOK_SECRET in env to match your wrangler dev's TG_WEBHOOK_SECRET.
Set CHAT_ID env to set a default sender chat id (default: 99999).
`);
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

async function postUpdate(secret: string, update: unknown): Promise<void> {
  const r = await fetch(`${BOT_URL}/tg/webhook/${secret}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(update),
  });
  console.log('webhook →', r.status, await r.text());
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) usage();

  // Eagerly load the privkey path so a missing-file error happens up front.
  void loadBotPrivkey();

  const args = parseArgs(rest);
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (!secret) {
    console.error('TG_WEBHOOK_SECRET env var required (must match wrangler dev secret)');
    process.exit(2);
  }

  const chatId = Number(args['chat-id'] || process.env.CHAT_ID || '99999');
  const fromName = args['as-friend'] || 'TestFriend';
  const baseUpdate = {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e6),
      from: { id: chatId, first_name: fromName },
      chat: { id: chatId, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text: '',
    },
  };

  switch (cmd) {
    case 'pair': {
      if (!args.code) usage();
      baseUpdate.message.text = `/pair ${args.code}`;
      await postUpdate(secret, baseUpdate);
      break;
    }
    case 'setpassword': {
      if (!args.password) usage();
      baseUpdate.message.text = `/setpassword ${args.password}`;
      await postUpdate(secret, baseUpdate);
      break;
    }
    case 'status': {
      baseUpdate.message.text = '/status';
      await postUpdate(secret, baseUpdate);
      break;
    }
    default:
      usage();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
