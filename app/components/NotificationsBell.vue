<script setup lang="ts">
const supabase = useSupabaseClient();
const router = useRouter();
const { can } = usePermissions();

interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Load recent notifications (RLS scopes to the signed-in staff member)
// ---------------------------------------------------------------------------
const { data: notifications, refresh } = await useAsyncData(
  "notifications-recent",
  async () => {
    const { data, error } = await supabase
      .from("notifications")
      .select("id, kind, title, body, link, read_at, created_at")
      .order("created_at", { ascending: false })
      .limit(15);
    if (error) throw error;
    return (data ?? []) as Notification[];
  },
);

/**
 * Kinds that exist only for holders of a permission. The database already
 * fans these out by permission (notify_prospect_submitted selects
 * recipients by role_permissions), so in the normal case this filter
 * removes nothing. It is here for the edge the trigger cannot see: a
 * person who held the permission when the row was written and has since
 * lost it. Same key as the /intake page and the nav item, so the three
 * gates cannot disagree about who a reviewer is. verify:forms asserts the
 * trigger's recipient set matches the permission holders.
 */
const KIND_PERMISSION: Record<string, string> = {
  "prospect.submitted": "forms.responses.view",
};

const visible = computed(() =>
  (notifications.value ?? []).filter((n) => {
    const needs = KIND_PERMISSION[n.kind];
    return !needs || can(needs);
  }),
);

const unreadCount = computed(
  () => visible.value.filter((n) => !n.read_at).length,
);

// ---------------------------------------------------------------------------
// Live updates: new rows for me appear without a refresh, and rows settled
// by someone ELSE (a colleague deciding a prospect marks my copy read via
// trigger) clear without one. DELETE is not subscribed: under RLS a delete
// payload carries only the primary key, so a staff_id filter cannot apply.
// ---------------------------------------------------------------------------
let channel: ReturnType<typeof supabase.channel> | null = null;

/** Tab woke up or came back: the socket may have died while it slept. */
function onVisible() {
  if (document.visibilityState === "visible") refresh();
}

onMounted(async () => {
  const { data: myStaffId } = await supabase.rpc("current_staff_id");
  if (!myStaffId) return;
  document.addEventListener("visibilitychange", onVisible);

  channel = supabase
    .channel("notifications-live")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "notifications",
        filter: `staff_id=eq.${myStaffId}`,
      },
      () => refresh(),
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "notifications",
        filter: `staff_id=eq.${myStaffId}`,
      },
      () => refresh(),
    )
    .subscribe((status) => {
      // A rejoin after a dropped socket has missed rows; reload on join so
      // the list is never older than the connection.
      if (status === "SUBSCRIBED") refresh();
    });
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", onVisible);
  if (channel) supabase.removeChannel(channel);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function open(notification: Notification) {
  if (!notification.read_at) {
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notification.id);
    await refresh();
  }
  if (notification.link) router.push(notification.link);
}

async function markAllRead() {
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .is("read_at", null);
  await refresh();
}

const KIND_ICONS: Record<string, string> = {
  "timeoff.approved": "lucide:check-circle-2",
  "timeoff.denied": "lucide:x-circle",
  "timeoff.requested": "lucide:inbox",
  "message.received": "lucide:message-circle",
  "prospect.submitted": "lucide:user-round-plus",
};

function timeAgo(iso: string) {
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
</script>

<template>
  <UiPopover>
    <UiPopoverTrigger as="div">
      <UiChip
        v-if="unreadCount"
        size="xl"
        color="bg-emerald-500 text-white dark:bg-emerald-400 dark:text-emerald-950"
        :text="unreadCount > 99 ? '99+' : unreadCount.toString()"
      >
        <UiButton
          size="icon-sm"
          variant="outline"
          class="relative"
          aria-label="Open notifications"
        >
          <Icon name="lucide:bell" class="size-4" aria-hidden="true" />
        </UiButton>
      </UiChip>
      <UiButton
        v-else
        size="icon-sm"
        variant="outline"
        class="relative"
        aria-label="Open notifications"
      >
        <Icon name="lucide:bell" class="size-4" aria-hidden="true" />
      </UiButton>
    </UiPopoverTrigger>

    <UiPopoverContent class="w-80 p-1" align="end" :side-offset="6">
      <div class="flex items-baseline justify-between gap-4 px-3 py-2">
        <div class="text-sm font-semibold">Notifications</div>
        <button
          v-if="unreadCount > 0"
          class="text-xs font-medium hover:underline"
          @click="markAllRead"
        >
          Mark all as read
        </button>
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        class="bg-border -mx-1 my-1 h-px"
      />

      <div class="max-h-96 overflow-y-auto">
        <div
          v-for="notification in visible"
          :key="notification.id"
          class="hover:bg-accent rounded-md px-3 py-2 text-sm transition-colors"
        >
          <div class="relative flex items-start gap-3 pe-3">
            <Icon
              :name="KIND_ICONS[notification.kind] ?? 'lucide:bell'"
              class="mt-0.5 size-4 shrink-0"
              :class="
                notification.kind.endsWith('denied')
                  ? 'text-destructive'
                  : 'text-primary'
              "
              aria-hidden="true"
            />
            <div class="min-w-0 flex-1 space-y-1">
              <button
                class="text-foreground/80 block w-full truncate text-left after:absolute after:inset-0"
                :class="
                  !notification.read_at && 'text-foreground font-semibold'
                "
                @click="open(notification)"
              >
                {{ notification.title }}
              </button>
              <div
                v-if="notification.body"
                class="text-muted-foreground truncate text-xs"
              >
                {{ notification.body }}
              </div>
              <div class="text-muted-foreground text-xs">
                {{ timeAgo(notification.created_at) }}
              </div>
            </div>
            <div
              v-if="!notification.read_at"
              class="absolute inset-e-0 self-center"
            >
              <span class="sr-only">Unread</span>
              <div
                v-if="!notification.read_at"
                class="absolute inset-e-0 self-center"
              >
                <span class="sr-only">Unread</span>
                <span
                  class="block size-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
                ></span>
              </div>
            </div>
          </div>
        </div>

        <p
          v-if="!visible.length"
          class="text-muted-foreground px-3 py-6 text-center text-sm"
        >
          Nothing yet.
        </p>
      </div>
    </UiPopoverContent>
  </UiPopover>
</template>
