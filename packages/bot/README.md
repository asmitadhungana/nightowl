# NightOwl Friend Lock bot

Cloudflare Worker that brokers Telegram ↔ desktop password delegation for NightOwl v2.

## What it does

- Takes a friend's `/setpassword <PW>` command on Telegram, hashes the password (bcrypt), signs the hash with the bot's Ed25519 key, queues it for the desktop.
- Auto-deletes the friend's plaintext message immediately. Plaintext lives only in the Worker invocation's memory; never persisted, never logged.
- Accepts `/desktop/poll` from the desktop and returns any pending signed messages.

## Threat model

- **You (the operator)** see Telegram chat IDs, friend display names, bcrypt hashes, and Ed25519 public keys. You do not see plaintext passwords (they exist only in transient request memory; KV writes contain only hashes).
- **A compromised bot** cannot push a malicious password hash that the desktop accepts — every bot→desktop message is signed with `BOT_ED25519_PRIVKEY`, and the desktop refuses messages whose signature does not verify with the `BOT_PUBKEY_HEX` baked into its build. To swap the public key the attacker would need to control the desktop build pipeline.
- **A compromised friend Telegram account** can set the password (this is the feature). They can't extend the lock duration or modify the schedule.

## Deploy

Prereqs:
- Cloudflare account (free plan is fine).
- `wrangler` installed (`npm install -g wrangler` then `wrangler login`).
- A Telegram bot token from @BotFather.

### 1. Create the KV namespace

```bash
cd packages/bot
wrangler kv:namespace create NIGHTOWL_KV
wrangler kv:namespace create NIGHTOWL_KV --preview
```

Copy both `id` values into `wrangler.toml` (`id` and `preview_id`).

### 2. Set secrets

> **Read this first:** `wrangler secret put` takes the secret value from STDIN.
> Do NOT pass the value on the command line — wrangler rejects it (`Unknown
> argument: ...`) AND logs the full argv on error to
> `~/Library/Preferences/.wrangler/logs/wrangler-*.log`. If you accidentally
> leak a token this way, revoke it (BotFather: `/revoke`), delete the log
> file, and clear shell history.

```bash
# Interactive — paste the value at the "? Enter a secret value:" prompt.
wrangler secret put TG_BOT_TOKEN          # @BotFather token
wrangler secret put TG_WEBHOOK_SECRET     # output of: openssl rand -hex 32
wrangler secret put BOT_ED25519_PRIVKEY   # contents of packages/bot/secrets/bot-private-key.hex (64 hex chars)

# Or, pipe from a file you immediately remove:
echo -n "<value>" > /tmp/s && wrangler secret put NAME < /tmp/s && rm /tmp/s
```

### 3. Deploy

```bash
npm run deploy:bot
# or: cd packages/bot && wrangler deploy
```

Note the workers.dev URL it returns (e.g. `https://nightowl-bot.your-subdomain.workers.dev`).

### 4. Wire up Telegram

```bash
# Replace <TOKEN>, <WORKER_URL>, <SECRET> below
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<WORKER_URL>/tg/webhook/<SECRET>"
```

You should get `{"ok":true,"result":true,"description":"Webhook was set"}`. If not, the URL is wrong or the Worker isn't reachable.

### 5. Build the desktop with the bot URL

```bash
NIGHTOWL_BOT_URL=https://nightowl-bot.your-subdomain.workers.dev npm run package:mac
```

Install the resulting DMG. From here the desktop knows where to find your bot.

## Local development

```bash
# In one terminal:
cd packages/bot

# Create a .dev.vars file (gitignored) with your secrets:
cat > .dev.vars <<EOF
TG_BOT_TOKEN=...
TG_WEBHOOK_SECRET=local-dev-secret-32-bytes-hex
BOT_ED25519_PRIVKEY=$(cat secrets/bot-private-key.hex)
EOF

npm run dev          # wrangler dev → http://localhost:8787
```

Then point your local desktop build at it:

```bash
NIGHTOWL_BOT_URL=http://localhost:8787 npm run dev:desktop
```

To simulate Telegram updates without a real bot:

```bash
TG_WEBHOOK_SECRET=local-dev-secret-32-bytes-hex \
  npm run replay -w packages/bot -- pair --code X4PQ7M2K --as-friend "Alex"
```

## Self-hosting

You don't need to use the project's hosted bot. Anyone can:

1. Deploy this Worker to their own Cloudflare account.
2. Generate their own bot Ed25519 keypair (`node -e "..."` snippet in `packages/shared/src/identity.ts` comments).
3. Build the desktop with `NIGHTOWL_BOT_URL` pointing at their Worker, embedding their pubkey in `packages/shared/src/identity.ts` (`BOT_PUBKEY_HEX`).

The protocol does not depend on the project's bot.
