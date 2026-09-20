// @vitest-environment node
import { describe, it, expect } from "vitest";
import { isConversationUnread } from "../../shared/messaging/unread";

// The predicate the list badge and the All/Unread filter both read. Every
// case is an edge where a rewrite could disagree with the original and
// every ordinary conversation would still look right.
const ME = "staff-me";
const THEM = "staff-them";
const T0 = "2026-09-20T10:00:00.000Z";
const T1 = "2026-09-20T10:05:00.000Z";

function conversation(opts: {
  last?: { at: string; from: string } | null;
  myReadAt?: string;
  includeMe?: boolean;
}) {
  const participants = [{ staff_id: THEM, last_read_at: T0 }];
  if (opts.includeMe !== false) {
    participants.push({ staff_id: ME, last_read_at: opts.myReadAt ?? T0 });
  }
  return {
    conversation_participants: participants,
    messages: opts.last
      ? [{ created_at: opts.last.at, sender_staff_id: opts.last.from }]
      : [],
  };
}

describe("isConversationUnread", () => {
  it("is false with no messages at all", () => {
    expect(isConversationUnread(conversation({ last: null }), ME)).toBe(false);
  });

  it("is false when the reader is not a participant (nothing to compare against)", () => {
    const c = conversation({ last: { at: T1, from: THEM }, includeMe: false });
    expect(isConversationUnread(c, ME)).toBe(false);
  });

  it("is false when the newest message is the reader's own, however new", () => {
    const c = conversation({ last: { at: T1, from: ME }, myReadAt: T0 });
    expect(isConversationUnread(c, ME)).toBe(false);
  });

  it("is true when someone else wrote after the reader last read", () => {
    const c = conversation({ last: { at: T1, from: THEM }, myReadAt: T0 });
    expect(isConversationUnread(c, ME)).toBe(true);
  });

  it("is false when the reader read after the newest message", () => {
    const c = conversation({ last: { at: T0, from: THEM }, myReadAt: T1 });
    expect(isConversationUnread(c, ME)).toBe(false);
  });

  it("is false on the exact tie — read at the message's own instant counts as read", () => {
    const c = conversation({ last: { at: T1, from: THEM }, myReadAt: T1 });
    expect(isConversationUnread(c, ME)).toBe(false);
  });

  it("is false for a null reader (signed-in but no staff row yet)", () => {
    const c = conversation({ last: { at: T1, from: THEM } });
    expect(isConversationUnread(c, null)).toBe(false);
  });

  it("reads messages[0] as the NEWEST — an ascending list gives the wrong answer, by contract", () => {
    // Documents the query contract the page relies on (desc, limit 1).
    const asc = {
      conversation_participants: [{ staff_id: ME, last_read_at: T0 }],
      messages: [
        { created_at: T0, sender_staff_id: THEM }, // older first
        { created_at: T1, sender_staff_id: THEM },
      ],
    };
    expect(isConversationUnread(asc, ME)).toBe(false);
  });
});
