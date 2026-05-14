/** Lifecycle of a pairing on the bot side. Maps loosely to DelegationPhase on desktop. */
export type PairingStatus = 'pending' | 'active' | 'revoked';

/** State of an in-flight uninstall request. */
export type UninstallReqStatus = 'pending' | 'approved' | 'denied';

/**
 * Discriminator for what kind of approval the friend is being asked for.
 * Both share the same /approve <REQID> /deny <REQID> Telegram interface.
 */
export type ApprovalKind = 'uninstall' | 'focus_release';

/** A request from the desktop asking the friend to approve an action. */
export interface UninstallRequest {
  reqId: string;
  pairingId: string;
  /** What the friend is being asked to approve. */
  kind: ApprovalKind;
  /** ISO timestamp the desktop posted the request. */
  createdAt: string;
  status: UninstallReqStatus;
  /** ISO timestamp the friend acted on it. Null while pending. */
  decidedAt: string | null;
  /** Telegram message id of the prompt the bot sent the friend, for context. */
  promptMessageId: number | null;
}

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

/**
 * Kinds of bot→desktop messages.
 *
 * - pair_complete  — friend successfully /pair'd; payload carries friendName/Id.
 * - password_hash  — friend /setpassword done; payload carries the bcrypt hash.
 * - friend_revoked — friend ran /revoke. Lock continues, but the desktop knows
 *                    not to expect any uninstall approval; surface the safety
 *                    net (72h emergency cooldown) more prominently.
 * - uninstall_decision    — friend ran /approve <reqId> or /deny <reqId> for an
 *                    uninstall request; payload carries reqId + verdict.
 * - focus_release_decision — same shape as uninstall_decision but for early
 *                    termination of a Friend Focus session. Separate kind so a
 *                    single approval doesn't accidentally green-light both
 *                    actions on the desktop side.
 */
export type MessageKind = 'pair_complete' | 'password_hash' | 'friend_revoked' | 'uninstall_decision' | 'focus_release_decision';

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

/**
 * `/invite` deep-link record. Persisted under `invite:<token>` for 24h. Read on
 * `/start <token>` arrival to personalize the install message and DM the inviter
 * that the friend tapped through.
 *
 * Multi-use within TTL — Asmita generates one link, can share with multiple
 * testers if she wants. Each arrival fires an independent inviter notification.
 */
export interface InviteRecord {
  token: string;
  /** Telegram chat ID of the inviter (the person who typed `/invite`). String to avoid JS Number precision issues with large IDs. */
  inviterChatId: string;
  /** Inviter's Telegram `first_name` — surfaced in the friend's welcome ("Asmita invited you"). */
  inviterFirstName: string;
  /** Pre-selected OS — when set, the friend sees the OS-specific install message directly instead of the picker. */
  os: 'android' | 'windows' | 'macos' | null;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp; defense-in-depth on top of KV's TTL. */
  expiresAt: string;
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

/**
 * Desktop posts to /desktop/request-uninstall to ask the friend for permission
 * to uninstall during an active delegated lock.
 */
export interface RequestUninstallBody {
  pairingId: string;
  /** Desktop-generated UUID; opaque to bot, returned on the decision message. */
  reqId: string;
  /** ISO timestamp; the bot prefixes the friend's prompt with "X minutes ago". */
  createdAt: string;
  ts: number;
  /** Base64 Ed25519 signature over "request_uninstall|"+pairingId+"|"+reqId+"|"+ts. */
  sig: string;
}

export interface RequestUninstallResponse {
  /** Echoed back so the desktop can correlate. */
  reqId: string;
  /** "queued" if the friend was prompted, "no_friend" if the pairing has no friend yet. */
  result: 'queued' | 'no_friend' | 'duplicate';
}

/**
 * Desktop posts to /desktop/request-focus-release to ask the friend for
 * permission to end an active friend-gated focus session early.
 */
export interface RequestFocusReleaseBody {
  pairingId: string;
  reqId: string;
  /** Total duration of the focus session in minutes — surfaced to the friend for context. */
  focusMinutes: number;
  /** ISO timestamp the focus session started. */
  focusStartedAt: string;
  createdAt: string;
  ts: number;
  /** Base64 Ed25519 signature over "request_focus_release|"+pairingId+"|"+reqId+"|"+ts. */
  sig: string;
}

export interface RequestFocusReleaseResponse {
  reqId: string;
  result: 'queued' | 'no_friend' | 'duplicate';
}
