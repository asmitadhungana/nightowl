/** Worker bindings. `wrangler` types fill these in at runtime. */
export interface Env {
  /** KV namespace for pairings, pair-codes, inboxes. */
  NIGHTOWL_KV: KVNamespace;
  /** Telegram bot token from @BotFather. */
  TG_BOT_TOKEN: string;
  /** Random 32-byte hex string. Telegram webhook URL embeds this so unsolicited POSTs are rejected. */
  TG_WEBHOOK_SECRET: string;
  /** 32-byte raw Ed25519 seed in hex. Matches packages/shared/src/identity.ts BOT_PUBKEY_HEX. */
  BOT_ED25519_PRIVKEY: string;
}
