/**
 * NightOwl friend Circles — bot-managed accountability groups.
 *
 * A Circle is a small group of friends who keep each other on track: each member
 * runs their own NightOwl lock, and the circle (mediated by the Telegram bot) is
 * where they form the group and — in a later layer — see each other's curfew
 * streaks/compliance and nudge each other.
 *
 * Members are identified by their **Telegram chat id** (the same stable, immutable
 * identifier the 1:1 Friend Lock uses for the friend — handles change, chat_id
 * doesn't). This is the social/visibility layer; it is deliberately NOT the k-of-n
 * unlock-multisig (that's device-key-signed and lives in the enforcement path —
 * see CIRCLES-design.md). Keeping them separate means joining/leaving an
 * accountability circle never weakens anyone's lock.
 *
 * Pure types + predicates, no I/O. The bot persists Circles in KV; this module
 * owns the shape + roster rules so they can be unit-tested without a Worker.
 */

export type CircleRole = 'creator' | 'member';

export interface CircleMember {
  /** Telegram chat id (string to dodge JS number precision on large ids). */
  chatId: string;
  /** Telegram first name, for display. */
  name: string;
  role: CircleRole;
  /** ISO timestamp the member joined. */
  joinedAt: string;
}

export interface Circle {
  /** Bot-assigned UUID; primary key. */
  circleId: string;
  /** Human label, e.g. "Sleep Squad". */
  name: string;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** All members. Invariant: length >= 1; exactly one `creator` while non-empty. */
  members: CircleMember[];
}

/** Small accountability groups by design — bounded so the roster + nudges stay legible. */
export const MAX_CIRCLE_MEMBERS = 12;

/** Max length for a circle name (keeps Telegram messages tidy). */
export const MAX_CIRCLE_NAME_LEN = 40;

export type CircleMutation =
  | { ok: true; circle: Circle }
  | { ok: false; reason: string };

/** Create a circle with its founder as the sole `creator` member. */
export function makeCircle(
  circleId: string,
  name: string,
  creator: { chatId: string; name: string },
  nowIso: string = new Date().toISOString(),
): Circle {
  return {
    circleId,
    name: name.trim().slice(0, MAX_CIRCLE_NAME_LEN),
    createdAt: nowIso,
    members: [{ chatId: creator.chatId, name: creator.name, role: 'creator', joinedAt: nowIso }],
  };
}

export function findMember(circle: Circle, chatId: string): CircleMember | undefined {
  return circle.members.find((m) => m.chatId === chatId);
}

export function isMember(circle: Circle, chatId: string): boolean {
  return findMember(circle, chatId) !== undefined;
}

export function memberCount(circle: Circle): number {
  return circle.members.length;
}

/**
 * Add a member. Additive — never mutates the input. Idempotent: re-adding an
 * existing member is a success no-op. Rejects over-cap.
 */
export function addMember(
  circle: Circle,
  member: { chatId: string; name: string },
  nowIso: string = new Date().toISOString(),
): CircleMutation {
  if (!member.chatId) return { ok: false, reason: 'chatId required' };
  if (isMember(circle, member.chatId)) {
    return { ok: true, circle }; // already in — no-op
  }
  if (circle.members.length >= MAX_CIRCLE_MEMBERS) {
    return { ok: false, reason: `circle is full (${MAX_CIRCLE_MEMBERS} members max)` };
  }
  const next: Circle = {
    ...circle,
    members: [...circle.members, { chatId: member.chatId, name: member.name, role: 'member', joinedAt: nowIso }],
  };
  return { ok: true, circle: next };
}

/**
 * Remove a member. If the departing member is the `creator` and others remain,
 * the longest-standing remaining member is promoted to `creator` (so a circle is
 * never left leaderless). Removing the last member yields an empty circle — the
 * caller should delete it from storage. Rejects unknown members.
 */
export function removeMember(circle: Circle, chatId: string): CircleMutation {
  if (!isMember(circle, chatId)) {
    return { ok: false, reason: 'not a member of this circle' };
  }
  const remaining = circle.members.filter((m) => m.chatId !== chatId);
  const departingWasCreator = findMember(circle, chatId)?.role === 'creator';
  if (departingWasCreator && remaining.length > 0 && !remaining.some((m) => m.role === 'creator')) {
    // Promote the earliest joiner to creator. members[] preserves join order.
    remaining[0] = { ...remaining[0], role: 'creator' };
  }
  return { ok: true, circle: { ...circle, members: remaining } };
}

/** True once the circle has no members — caller should delete the record. */
export function isEmpty(circle: Circle): boolean {
  return circle.members.length === 0;
}
