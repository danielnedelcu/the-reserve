<script setup lang="ts">
// /messages and /messages/<conversationId> — one page, optional param.
definePageMeta({ key: "messages" });
useSeoMeta({ title: "Messages — The Reserve" });

const supabase = useSupabaseClient();
const route = useRoute();
const toast = useToast();
const picked = useToggleSet();

const { data: myStaffId } = await useAsyncData("msg-me", async () => {
  const { data } = await supabase.rpc("current_staff_id");
  return (data as string | null) ?? null;
});

// ---------------------------------------------------------------------------
// Conversation list (mine), with participants, last message, unread state
// ---------------------------------------------------------------------------
interface Participant {
  staff_id: string;
  last_read_at: string;
  staff: { display_name: string; avatar_url: string | null } | null;
}
interface Conversation {
  id: string;
  kind: "dm" | "group";
  name: string | null;
  updated_at: string;
  conversation_participants: Participant[];
  messages: { body: string; created_at: string; sender_staff_id: string }[];
}

const { data: conversations, refresh: refreshList } = await useAsyncData(
  "msg-conversations",
  async () => {
    const { data, error } = await supabase
      .from("conversations")
      .select(
        `id, kind, name, updated_at,
         conversation_participants(staff_id, last_read_at, staff(display_name, avatar_url)),
         messages(body, created_at, sender_staff_id)`,
      )
      .order("updated_at", { ascending: false })
      .order("created_at", { referencedTable: "messages", ascending: false })
      .limit(1, { referencedTable: "messages" });
    if (error) throw error;
    return (data ?? []) as unknown as Conversation[];
  },
);

function others(conversation: Conversation) {
  return conversation.conversation_participants.filter(
    (p) => p.staff_id !== myStaffId.value,
  );
}
function conversationName(conversation: Conversation) {
  if (conversation.kind === "group" && conversation.name)
    return conversation.name;
  const names = others(conversation).map(
    (p) => p.staff?.display_name ?? "Staff",
  );
  return names.join(", ") || "Conversation";
}
function myParticipant(conversation: Conversation) {
  return conversation.conversation_participants.find(
    (p) => p.staff_id === myStaffId.value,
  );
}
function isUnread(conversation: Conversation) {
  const last = conversation.messages[0];
  const mine = myParticipant(conversation);
  if (!last || !mine) return false;
  if (last.sender_staff_id === myStaffId.value) return false;
  return Date.parse(last.created_at) > Date.parse(mine.last_read_at);
}

const listSearch = ref("");
const visibleConversations = computed(() => {
  const q = listSearch.value.trim().toLowerCase();
  const list = conversations.value ?? [];
  if (!q) return list;
  return list.filter((c) => conversationName(c).toLowerCase().includes(q));
});

// ---------------------------------------------------------------------------
// Active thread
// ---------------------------------------------------------------------------
const activeId = computed(
  () => (route.params.id as string | undefined) ?? null,
);
const activeConversation = computed(
  () =>
    (conversations.value ?? []).find((c) => c.id === activeId.value) ?? null,
);

// Landing on bare /messages with conversations available → open the newest
watchEffect(() => {
  if (!activeId.value && (conversations.value ?? []).length) {
    navigateTo(`/messages/${conversations.value![0]!.id}`, { replace: true });
  }
});

interface Message {
  id: string;
  sender_staff_id: string;
  body: string;
  created_at: string;
}
const thread = ref<Message[]>([]);
const threadEl = ref<HTMLElement | null>(null);

async function loadThread() {
  if (!activeId.value) {
    thread.value = [];
    return;
  }
  const { data, error } = await supabase
    .from("messages")
    .select("id, sender_staff_id, body, created_at")
    .eq("conversation_id", activeId.value)
    .order("created_at")
    .limit(200);
  if (error) return toast.error("Could not load messages", error.message);
  thread.value = (data ?? []) as Message[];

  // Mark read server-side (bumps last_read_at + clears my bell entry),
  // then refetch the list so the unread dot clears from fresh data.
  const { error: readError } = await supabase.rpc("mark_conversation_read", {
    p_conversation_id: activeId.value,
  });
  if (readError) console.error("[mark read]", readError);
  await refreshList();

  await nextTick();
  threadEl.value?.scrollTo({ top: threadEl.value.scrollHeight });
}

watch(activeId, loadThread, { immediate: true });

// Sender lookup (name + avatar) from the active conversation's participants
const senderById = computed(() => {
  const map: Record<string, { name: string; avatar: string | null }> = {};
  for (const p of activeConversation.value?.conversation_participants ?? []) {
    map[p.staff_id] = {
      name: p.staff?.display_name ?? "Staff",
      avatar: p.staff?.avatar_url ?? null,
    };
  }
  return map;
});

// Consecutive same-sender runs → one group (avatar once, bubbles stacked)
const groupedThread = computed(() => {
  const groups: { senderId: string; mine: boolean; messages: Message[] }[] = [];
  for (const message of thread.value) {
    const last = groups[groups.length - 1];
    if (last && last.senderId === message.sender_staff_id) {
      last.messages.push(message);
    } else {
      groups.push({
        senderId: message.sender_staff_id,
        mine: message.sender_staff_id === myStaffId.value,
        messages: [message],
      });
    }
  }
  return groups;
});

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
function messageTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Realtime: new messages in the open thread + list movement + new conversations
// ---------------------------------------------------------------------------
let messagesChannel: ReturnType<typeof supabase.channel> | null = null;
let participantChannel: ReturnType<typeof supabase.channel> | null = null;

onMounted(() => {
  messagesChannel = supabase
    .channel(`messages-live-${Date.now()}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      async (payload) => {
        const row = payload.new as Message & { conversation_id: string };
        if (row.conversation_id === activeId.value) {
          thread.value.push(row);
          await supabase.rpc("mark_conversation_read", {
            p_conversation_id: activeId.value,
          });
          await nextTick();
          threadEl.value?.scrollTo({
            top: threadEl.value.scrollHeight,
            behavior: "smooth",
          });
        }
        await refreshList();
      },
    )
    .subscribe();

  if (myStaffId.value) {
    participantChannel = supabase
      .channel(`participants-live-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "conversation_participants",
          filter: `staff_id=eq.${myStaffId.value}`,
        },
        () => refreshList(),
      )
      .subscribe();
  }
});

onUnmounted(() => {
  if (messagesChannel) supabase.removeChannel(messagesChannel);
  if (participantChannel) supabase.removeChannel(participantChannel);
});

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
const draft = ref("");
const sending = ref(false);

async function send() {
  const body = draft.value.trim();
  if (!body || !activeId.value || !myStaffId.value) return;
  sending.value = true;
  try {
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeId.value,
      sender_staff_id: myStaffId.value,
      body,
    });
    if (error) return toast.error("Could not send", error.message);
    draft.value = "";
  } finally {
    sending.value = false;
  }
}

function onComposerKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

// ---------------------------------------------------------------------------
// New conversation (DM or ad-hoc group)
// ---------------------------------------------------------------------------
const newOpen = ref(false);
const groupName = ref("");
const creating = ref(false);

const { data: staffList } = await useAsyncData("msg-staff", async () => {
  const { data } = await supabase
    .from("staff")
    .select("id, display_name, avatar_url")
    .eq("active", true)
    .order("display_name");
  return data ?? [];
});
const pickableStaff = computed(() =>
  (staffList.value ?? []).filter((s) => s.id !== myStaffId.value),
);

async function startConversation() {
  const ids = [...picked.set.value];
  const [firstId] = ids;
  if (!firstId) return;
  creating.value = true;
  const { data: conversationId, error } =
    ids.length === 1
      ? await supabase.rpc("find_or_create_dm", { p_other_staff_id: firstId })
      : await supabase.rpc("create_group_conversation", {
          p_name: groupName.value,
          p_staff_ids: ids,
        });
  creating.value = false;
  if (error) return toast.error("Could not start conversation", error.message);
  newOpen.value = false;
  picked.clear();
  groupName.value = "";
  await refreshList();
  navigateTo(`/messages/${conversationId}`);
}

const leaveOpen = ref(false);

async function leaveConversation() {
  if (!activeId.value) return;
  leaveOpen.value = false;
  const { error } = await supabase.rpc("leave_conversation", {
    p_conversation_id: activeId.value,
  });
  if (error) return toast.error("Could not leave", error.message);
  await refreshList();
  const next = (conversations.value ?? [])[0];
  navigateTo(next ? `/messages/${next.id}` : "/messages");
}

function listTime(conversation: Conversation) {
  const iso = conversation.messages[0]?.created_at ?? conversation.updated_at;
  const then = new Date(iso);
  const now = new Date();
  const days = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0)
    return then.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  if (days === 1) return "Yesterday";
  if (days < 7) return then.toLocaleDateString("en-US", { weekday: "short" });
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
</script>

<template>
  <div class="grid h-[calc(100svh-3rem)] grid-cols-1 md:grid-cols-[300px_1fr]">
    <!-- LEFT: conversation list -->
    <aside
      class="px-3"
      :class="activeId ? 'hidden md:flex md:flex-col' : 'flex flex-col'"
    >
      <div class="flex items-center gap-2 px-0 py-3">
        <UiInput
          v-model="listSearch"
          placeholder="Search people…"
          class="h-8"
        />
        <UiTooltip>
          <UiTooltipTrigger as-child>
            <UiButton
              size="icon-sm"
              aria-label="New message"
              variant="outline"
              @click="newOpen = true"
            >
              <Icon name="lucide:square-pen" class="size-4" />
            </UiButton>
          </UiTooltipTrigger>
          <UiTooltipContent>New message</UiTooltipContent>
        </UiTooltip>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <NuxtLink
          v-for="conversation in visibleConversations"
          :key="conversation.id"
          :to="`/messages/${conversation.id}`"
          class="hover:bg-secondary/50 flex items-center gap-3 rounded-md px-3 py-3 transition"
          :class="conversation.id === activeId && 'bg-secondary/70'"
        >
          <UiAvatar class="size-9">
            <UiAvatarImage
              v-if="
                conversation.kind === 'dm' &&
                others(conversation)[0]?.staff?.avatar_url
              "
              :src="others(conversation)[0]!.staff!.avatar_url!"
              :alt="conversationName(conversation)"
            />
            <UiAvatarFallback>
              <Icon
                v-if="conversation.kind === 'group'"
                name="lucide:users"
                class="size-4"
              />
              <template v-else>{{
                initials(conversationName(conversation))
              }}</template>
            </UiAvatarFallback>
            <UiAvatarBadge
              v-if="isUnread(conversation)"
              class="bg-emerald-500 dark:bg-emerald-400"
              aria-label="Unread"
            />
          </UiAvatar>
          <div class="min-w-0 flex-1">
            <div class="flex items-baseline justify-between gap-2">
              <p
                class="truncate text-sm"
                :class="
                  isUnread(conversation) ? 'font-semibold' : 'font-medium'
                "
              >
                {{ conversationName(conversation) }}
              </p>
              <p class="text-muted-foreground shrink-0 text-[11px]">
                {{ listTime(conversation) }}
              </p>
            </div>
            <p
              class="truncate text-xs"
              :class="
                isUnread(conversation)
                  ? 'text-foreground'
                  : 'text-muted-foreground'
              "
            >
              {{ conversation.messages[0]?.body ?? "No messages yet" }}
            </p>
          </div>
        </NuxtLink>
        <p
          v-if="!visibleConversations.length"
          class="text-muted-foreground p-4 text-sm"
        >
          {{ listSearch ? "No matches." : "No conversations yet — start one." }}
        </p>
      </div>
    </aside>

    <!-- RIGHT: thread -->
    <section
      class="flex min-h-0 flex-col"
      :class="!activeId && 'hidden md:flex'"
    >
      <template v-if="activeConversation">
        <div class="flex items-center gap-2 px-4 py-2.5">
          <NuxtLink to="/messages" class="md:hidden">
            <Icon name="lucide:chevron-left" class="size-5" />
          </NuxtLink>
          <p class="text-sm font-medium">
            {{ conversationName(activeConversation) }}
          </p>
          <p
            v-if="activeConversation.kind === 'group'"
            class="text-muted-foreground text-xs"
          >
            · {{ activeConversation.conversation_participants.length }} people
          </p>
          <UiTooltip>
            <UiTooltipTrigger as-child>
              <UiDropdownMenu>
                <UiDropdownMenuTrigger as-child>
                  <UiButton
                    variant="ghost"
                    size="icon-sm"
                    class="ml-auto"
                    aria-label="Conversation options"
                  >
                    <Icon
                      name="lucide:ellipsis-vertical"
                      class="text-muted-foreground size-4"
                    />
                  </UiButton>
                </UiDropdownMenuTrigger>
                <UiDropdownMenuContent align="end" class="w-48">
                  <UiDropdownMenuItem
                    icon="lucide:log-out"
                    title="Leave conversation"
                    class="text-primary"
                    @select="leaveOpen = true"
                  />
                </UiDropdownMenuContent>
              </UiDropdownMenu>
            </UiTooltipTrigger>
            <UiTooltipContent>Leave conversation</UiTooltipContent>
          </UiTooltip>
        </div>

        <div
          ref="threadEl"
          class="bg-secondary/70 min-h-0 flex-1 overflow-y-auto rounded-md p-4"
        >
          <div class="flex flex-col gap-5">
            <UiMessage
              v-for="(group, gi) in groupedThread"
              :key="gi"
              :align="group.mine ? 'end' : 'start'"
            >
              <UiMessageAvatar>
                <UiAvatar class="size-7">
                  <UiAvatarImage
                    v-if="senderById[group.senderId]?.avatar"
                    :src="senderById[group.senderId]!.avatar!"
                    :alt="senderById[group.senderId]?.name"
                  />
                  <UiAvatarFallback class="text-xs">
                    {{ initials(senderById[group.senderId]?.name ?? "?") }}
                  </UiAvatarFallback>
                </UiAvatar>
              </UiMessageAvatar>
              <UiMessageContent>
                <UiMessageHeader
                  v-if="!group.mine && activeConversation.kind === 'group'"
                >
                  {{ senderById[group.senderId]?.name }}
                </UiMessageHeader>
                <UiBubbleGroup class="w-3/4">
                  <UiBubble
                    v-for="message in group.messages"
                    :key="message.id"
                    :variant="group.mine ? undefined : 'muted'"
                    :class="
                      !group.mine &&
                      '*:data-[slot=bubble-content]:bg-card *:data-[slot=bubble-content]:text-card-foreground'
                    "
                  >
                    <UiBubbleContent>{{ message.body }}</UiBubbleContent>
                  </UiBubble>
                </UiBubbleGroup>
                <UiMessageFooter>
                  {{
                    messageTime(
                      group.messages[group.messages.length - 1]!.created_at,
                    )
                  }}
                </UiMessageFooter>
              </UiMessageContent>
            </UiMessage>
            <p
              v-if="!thread.length"
              class="text-muted-foreground text-center text-sm"
            >
              Say hello — this is the beginning of the conversation.
            </p>
          </div>
        </div>

        <div class="p-3">
          <UiInputGroup>
            <UiInputGroupTextarea
              :value="draft"
              :placeholder="`Message ${conversationName(activeConversation)}`"
              :disabled="sending"
              @input="draft = ($event.target as HTMLTextAreaElement).value"
              @keydown="onComposerKeydown"
            />
            <UiInputGroupAddon align="block-end">
              <UiInputGroupText
                v-if="draft.length > 3500"
                class="ml-auto"
                :class="draft.length > 4000 && 'text-destructive'"
              >
                {{ draft.length }}/4000
              </UiInputGroupText>
              <UiSeparator
                v-if="draft.length > 3500"
                orientation="vertical"
                class="h-4!"
              />
              <UiInputGroupButton
                variant="default"
                type="button"
                class="rounded-full"
                :class="draft.length <= 3500 && 'ml-auto'"
                size="icon-xs"
                :disabled="sending || !draft.trim() || draft.length > 4000"
                :title="sending ? 'Sending…' : 'Send (Enter)'"
                @click="send"
              >
                <Icon
                  v-if="sending"
                  name="lucide:loader-circle"
                  class="size-4 animate-spin"
                />
                <Icon v-else name="lucide:arrow-up" class="size-4" />
                <span class="sr-only">Send</span>
              </UiInputGroupButton>
            </UiInputGroupAddon>
          </UiInputGroup>
        </div>
      </template>

      <div
        v-else
        class="text-muted-foreground hidden flex-1 items-center justify-center text-sm md:flex"
      >
        Pick a conversation, or start a new one.
      </div>
    </section>

    <!-- New conversation dialog -->
    <UiDialog v-model:open="newOpen">
      <UiDialogContent class="sm:max-w-sm">
        <UiDialogHeader>
          <UiDialogTitle>New message</UiDialogTitle>
          <UiDialogDescription>
            Pick one person for a direct message, or several for a group.
          </UiDialogDescription>
        </UiDialogHeader>
        <div class="max-h-72 space-y-1 overflow-y-auto">
          <label
            v-for="member in pickableStaff"
            :key="member.id"
            class="hover:bg-secondary/60 flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5"
          >
            <input
              type="checkbox"
              class="size-4 accent-primary"
              :checked="picked.has(member.id)"
              @change="picked.toggle(member.id)"
            />
            <UiAvatar class="size-7">
              <UiAvatarImage
                v-if="member.avatar_url"
                :src="member.avatar_url"
                :alt="member.display_name"
              />
              <UiAvatarFallback class="text-xs">{{
                initials(member.display_name)
              }}</UiAvatarFallback>
            </UiAvatar>
            <span class="text-sm">{{ member.display_name }}</span>
          </label>
        </div>
        <UiInput
          v-if="picked.set.value.size > 1"
          v-model="groupName"
          placeholder="Group name (optional)"
        />
        <UiDialogFooter>
          <UiButton variant="outline" @click="newOpen = false">Cancel</UiButton>
          <UiButton
            :disabled="creating || !picked.set.value.size"
            :text="
              creating
                ? 'Starting…'
                : picked.set.value.size > 1
                  ? 'Start group'
                  : 'Start conversation'
            "
            @click="startConversation"
          />
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialog>

    <UiAlertDialog v-model:open="leaveOpen">
      <UiAlertDialogContent>
        <UiAlertDialogHeader>
          <UiAlertDialogTitle>Leave this conversation?</UiAlertDialogTitle>
          <UiAlertDialogDescription>
            {{
              activeConversation?.kind === "dm"
                ? "It will disappear from your list. Messaging this person again starts a fresh conversation."
                : "You'll stop receiving this group's messages."
            }}
          </UiAlertDialogDescription>
        </UiAlertDialogHeader>
        <UiAlertDialogFooter>
          <UiAlertDialogCancel>Cancel</UiAlertDialogCancel>
          <UiAlertDialogAction
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            @click="leaveConversation"
          >
            Leave
          </UiAlertDialogAction>
        </UiAlertDialogFooter>
      </UiAlertDialogContent>
    </UiAlertDialog>
  </div>
</template>
