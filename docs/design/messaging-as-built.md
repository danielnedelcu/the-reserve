# Messaging (§9) — as built

SHIPPED 2026-08. The original design doc was not preserved; this records
the lasting decisions compactly. Table shapes live in docs/schema/
(conversations, conversation_participants, messages).

- **DMs are canonical**: find_or_create_dm() dedupes by participant pair —
  messaging the same person again reopens the one DM rather than creating
  a new conversation. Groups are ad-hoc via create_group_conversation()
  with an optional name.
- **Unread** is derived, not stored: last message's created_at vs the
  reader's conversation_participants.last_read_at, own messages excluded.
  mark_conversation_read() (security definer) bumps last_read_at AND
  clears the reader's bell notifications for that conversation. UI:
  emerald badge on the LIST avatar + bold text (color never the only
  channel); read-state refresh via refreshList() after the RPC — boring
  refetch chosen over optimistic local patches after Nuxt 4's shallow
  useAsyncData ate two clever attempts.
- **Leaving**: leave_conversation() (security definer) removes the
  participant, clears their bell entries, and GARBAGE-COLLECTS the
  conversation when the last participant leaves (cascades messages).
  Leaving a DM means a fresh conversation on re-message (stated in the
  confirm dialog).
- **Realtime**: postgres_changes INSERT subscriptions; channel names get
  a Date.now() suffix (page remounts collided on re-subscribe otherwise);
  definePageMeta({ key: "messages" }) keeps one component instance across
  /messages/<id> navigation.
- **Thread rendering**: consecutive same-sender runs group into one
  UiMessage (avatar once, UiBubbleGroup stacked, timestamp per run);
  incoming bubbles restyled bg-card via slot-targeted classes;
  UiBubbleGroup width-capped (w-3/4) to stop shrink-to-fit premature
  wrapping.
- **Landing**: bare /messages redirects to the newest conversation
  ({ replace: true } so Back doesn't loop); leaving lands on
  conversations[0] or the empty state.
- **Known open item** (docs/TODO.md): thread pagination. Current
  loadThread loads the OLDEST 200 (asc + limit) — latent bug at volume.
  Designed fix: keyset pagination (desc limit 50, reversed), scroll-top
  older-page fetch preserving scrollHeight delta, dedupe by id; the
  existing (conversation_id, created_at) index already serves it. Skip
  DOM virtualization at spa scale.
