/**
 * "Does this conversation have something the reader has not seen?" —
 * ONE definition, read by the conversation list's badge and bold text
 * and by the All/Unread filter and its counts. Unread is DERIVED, never
 * stored (docs/design/messaging-as-built.md): the newest message's
 * created_at against the reader's own last_read_at, with the reader's
 * own messages never counting. Lifted out of the messages page
 * unchanged so a second consumer reads this and cannot recompute it a
 * second way (docs/design/messaging-enhancements.md, reuse point 2).
 *
 * `messages[0]` is the NEWEST message: the page's query orders by
 * created_at desc and limits to 1. A caller that passes an ascending
 * list gets the wrong answer, and the test says so.
 */
export interface UnreadParticipant {
  staff_id: string;
  last_read_at: string;
}
export interface UnreadMessage {
  created_at: string;
  sender_staff_id: string;
}
export interface UnreadConversation {
  conversation_participants: UnreadParticipant[];
  messages: UnreadMessage[];
}

export function isConversationUnread(
  conversation: UnreadConversation,
  readerStaffId: string | null,
): boolean {
  const last = conversation.messages[0];
  const mine = conversation.conversation_participants.find(
    (p) => p.staff_id === readerStaffId,
  );
  if (!last || !mine) return false;
  if (last.sender_staff_id === readerStaffId) return false;
  return Date.parse(last.created_at) > Date.parse(mine.last_read_at);
}
