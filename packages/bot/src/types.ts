/** Lifecycle of a pairing on the bot side. Maps loosely to DelegationPhase on desktop. */
export type PairingStatus = 'pending' | 'active' | 'revoked';

export interface Pairing {
  /** UUID; primary key. Mirrors DelegationState.pairingId on desktop. */
  pairingId: string;
  /** Desktop install's Ed25519 public key (raw 32 bytes, hex). Used to verify desktop requests. */
  userPubkeyHex: string;
  /** Friend's Telegram chat ID, set when /pair completes. Stored as string to dodge JS num precision. */
  friendChatId: string | null;
  /** Friend's Telegram first_name, for desktop UI. */
  friendName: string | null;
  /** ISO timestamp of enrollment. */
  createdAt: string;
  /** Lifecycle. */
  status: PairingStatus;
  /** Monotonic counter; bot increments before pushing each outbound message. */
  botSeq: number;
  /**
   * Set true once /setpassword has been consumed by the desktop. Prevents the
   * friend from changing the password mid-lock (surprising power that would
   * blur the friend/user trust boundary).
   */
  passwordConsumed: boolean;
}

/** Kinds of bot→desktop messages in the alpha protocol. Phase-2 adds uninstall_decision and friend_revoked. */
export type MessageKind = 'pair_complete' | 'password_hash';

/** A signed message in the inbox queue. */
export interface InboxMessage {
  /** Per-pairing monotonic; equals Pairing.botSeq at push time. */
  seq: number;
  kind: MessageKind;
  /** JSON-serializable payload, kind-specific. */
  payload: unknown;
  /** Base64 Ed25519 signature over canonical("v2|" + pairingId + "|" + seq + "|" + kind + "|" + canonicalJson(payload)). */
  sig: string;
}

export interface PairCodeRecord {
  pairingId: string;
  /** Unix epoch ms. KV TTL backs this up but we double-check on read. */
  expiresAt: number;
}

/** Wire types for desktop endpoints. */
export interface EnrollRequest {
  /** Raw 32-byte Ed25519 pubkey, hex. */
  userPubkeyHex: string;
  /** Unix epoch ms; bot rejects if too far from server now (clock-skew defense). */
  ts: number;
  /** Base64 Ed25519 signature over "enroll|" + userPubkeyHex + "|" + ts. */
  sig: string;
}

export interface EnrollResponse {
  pairingId: string;
  /** 8-char alphanumeric, no ambiguous chars. */
  pairCode: string;
  /** Unix epoch ms when pair code stops being accepted. */
  expiresAt: number;
}

export interface PollRequest {
  pairingId: string;
  /** Highest seq the desktop has consumed. Bot returns messages with seq > this. */
  lastSeq: number;
  /** Unix epoch ms; clock-skew check. */
  ts: number;
  /** Base64 Ed25519 signature over "poll|" + pairingId + "|" + lastSeq + "|" + ts. */
  sig: string;
}

export interface PollResponse {
  messages: InboxMessage[];
  /** Latest botSeq for this pairing, regardless of what the desktop got. */
  botSeq: number;
  /** Friend display info, included on every poll so the desktop UI can show it. */
  friendName: string | null;
  /** Lifecycle hint to the desktop. */
  status: PairingStatus;
}
