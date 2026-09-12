<script setup lang="ts">
const { can, load } = usePermissions();
const { signOut } = useAuth();
const user = useSupabaseUser();
const route = useRoute();

await load();

// Prospects awaiting review — queue state, live, permission-gated inside
// the composable (it never queries for someone who cannot see /intake).
const queue = useProspectQueue();
onMounted(() => queue.start());
onUnmounted(() => queue.stop());

interface NavItem {
  title: string;
  to: string;
  icon: string;
  show: boolean;
  /**
   * Attention indicator: a count of things waiting behind this item.
   * Rendered as the app's emerald dot PLUS text (sr-only in the rail, in
   * the tooltip when collapsed) — never colour alone.
   */
  pending?: { count: number; noun: string };
}
interface NavSection {
  label: string;
  items: NavItem[];
}

const navSections = computed<NavSection[]>(() =>
  [
    {
      label: "", // top group: the daily-driver pages, no label needed
      items: [
        {
          title: "Dashboard",
          to: "/",
          icon: "lucide:layout-dashboard",
          show: true,
        },
        {
          title: "Schedule",
          to: "/schedule",
          icon: "lucide:calendar-days",
          show: can("appointments.view.own"),
        },
        {
          title: "Messages",
          to: "/messages",
          icon: "lucide:message-circle",
          show: true,
        },
      ],
    },
    {
      label: "Operations",
      items: [
        {
          title: "Clients",
          to: "/clients",
          icon: "lucide:contact",
          show: can("clients.view"),
        },
        {
          title: "New members",
          to: "/intake",
          icon: "lucide:user-round-plus",
          show: can("forms.responses.view"),
          pending: { count: queue.pendingCount.value, noun: "awaiting review" },
        },
        {
          title: "Forms",
          to: "/forms",
          icon: "lucide:clipboard-list",
          show: can("forms.manage"),
        },
        {
          title: "Staff",
          to: "/staff",
          icon: "lucide:users",
          show: can("staff.view"),
        },
        {
          title: "Time off",
          to: "/time-off",
          icon: "lucide:calendar-off",
          show: can("timeoff.approve"),
        },
        {
          title: "Services",
          to: "/services",
          icon: "lucide:sparkles",
          show: can("services.view"),
        },
        {
          title: "Rooms",
          to: "/rooms",
          icon: "lucide:door-open",
          show: can("services.view"),
        },
        {
          title: "Products",
          to: "/products",
          icon: "lucide:package",
          show: can("products.view"),
        },
      ],
    },
    {
      label: "Finance",
      items: [
        {
          title: "Transactions",
          to: "/transactions",
          icon: "lucide:receipt",
          show: can("transactions.view"),
        },
        {
          title: "Financials",
          to: "/financials",
          icon: "lucide:chart-bar",
          show: can("financials.view_summary"),
        },
        {
          title: "Business",
          to: "/business",
          icon: "lucide:building",
          show: can("org.settings.manage"),
        },
      ],
    },
  ]
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.show),
    }))
    .filter((section) => section.items.length > 0),
);

function isActive(to: string) {
  return to === "/" ? route.path === "/" : route.path.startsWith(to);
}

/** "3 awaiting review" — the words that travel with the dot. */
function pendingLabel(item: NavItem) {
  if (!item.pending?.count) return null;
  return `${item.pending.count} ${item.pending.noun}`;
}

const initials = computed(() =>
  (user.value?.email ?? "?").slice(0, 2).toUpperCase(),
);

// in the layout's <script setup>
const searchInput = ref<{ $el?: HTMLElement } | null>(null);

const keys = useMagicKeys({
  passive: false,
  onEventFired(e) {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "k" &&
      e.type === "keydown"
    ) {
      e.preventDefault(); // stop the browser's own ⌘K (URL bar focus in some browsers)
    }
  },
});

watch([keys["Meta+K"], keys["Ctrl+K"]], ([meta, ctrl]) => {
  if (meta || ctrl) {
    const el = searchInput.value?.$el as HTMLInputElement | undefined;
    (el?.tagName === "INPUT" ? el : el?.querySelector("input"))?.focus();
  }
});
</script>

<template>
  <UiSidebarProvider v-slot="{ isMobile }">
    <UiSidebar collapsible="icon">
      <!-- Brand -->
      <UiSidebarHeader>
        <UiSidebarMenu>
          <UiSidebarMenuItem>
            <UiSidebarMenuButton size="lg" as-child>
              <NuxtLink to="/" class="flex items-center gap-3">
                <div
                  class="flex aspect-square size-8 items-center justify-center rounded-lg bg-[#3b2f1e] text-[#e9d9b0]"
                >
                  <BrandLaurel class="h-4 w-6" />
                </div>
                <div class="grid flex-1 text-left leading-tight">
                  <span class="truncate font-serif text-sm tracking-[0.14em]">
                    THE RESERVE
                  </span>
                  <span
                    class="truncate text-[10px] tracking-[0.25em] text-muted-foreground"
                  >
                    WELLNESS CLUB
                  </span>
                </div>
              </NuxtLink>
            </UiSidebarMenuButton>
          </UiSidebarMenuItem>
        </UiSidebarMenu>
      </UiSidebarHeader>

      <!-- Nav -->
      <UiSidebarContent>
        <UiSidebarGroup v-for="section in navSections" :key="section.label">
          <UiSidebarGroupLabel :label="section.label" />
          <UiSidebarGroupContent>
            <UiSidebarMenu>
              <UiSidebarMenuItem v-for="item in section.items" :key="item.to">
                <UiSidebarMenuButton
                  as-child
                  :is-active="isActive(item.to)"
                  :tooltip="
                    pendingLabel(item)
                      ? `${item.title} · ${pendingLabel(item)}`
                      : item.title
                  "
                >
                  <!-- `relative` anchors the collapsed-mode dot; `truncate`
                       on the title is explicit because the button's
                       [&>span:last-child]:truncate no longer lands on it
                       once the dot spans follow. -->
                  <NuxtLink :to="item.to" class="relative">
                    <Icon :name="item.icon" />
                    <span class="truncate">{{ item.title }}</span>
                    <!-- Attention dot: the same emerald dot as the bell and
                         messages. Sits at the row's end when expanded; in
                         icon-only mode the row clips its overflow, so the
                         copy on the icon's corner is the one that shows.
                         The words are always present for a screen reader. -->
                    <template v-if="pendingLabel(item)">
                      <span class="sr-only">, {{ pendingLabel(item) }}</span>
                      <span
                        aria-hidden="true"
                        class="ml-auto block size-1.5 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400"
                      />
                      <span
                        aria-hidden="true"
                        class="ring-sidebar absolute left-5 top-1.5 hidden size-1.5 rounded-full bg-emerald-500 ring-2 group-data-[collapsible=icon]:block dark:bg-emerald-400"
                      />
                    </template>
                  </NuxtLink>
                </UiSidebarMenuButton>
              </UiSidebarMenuItem>
            </UiSidebarMenu>
          </UiSidebarGroupContent>
        </UiSidebarGroup>
      </UiSidebarContent>

      <UiSidebarRail />

      <!-- User -->
      <UiSidebarFooter>
        <UiSidebarMenu>
          <UiSidebarMenuItem>
            <UiDropdownMenu>
              <UiDropdownMenuTrigger as-child>
                <UiSidebarMenuButton
                  size="lg"
                  class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <UiAvatar class="size-8 rounded-lg">
                    <UiAvatarFallback
                      class="rounded-lg bg-[#f0e9d8] text-xs text-[#4a3d2a]"
                    >
                      {{ initials }}
                    </UiAvatarFallback>
                  </UiAvatar>
                  <div class="grid flex-1 text-left text-sm leading-tight">
                    <span class="truncate text-xs">{{ user?.email }}</span>
                  </div>
                  <Icon name="lucide:chevrons-up-down" class="ml-auto size-4" />
                </UiSidebarMenuButton>
              </UiDropdownMenuTrigger>
              <UiDropdownMenuContent
                class="w-(--reka-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                :side="isMobile ? 'bottom' : 'right'"
                :side-offset="4"
                align="end"
              >
                <UiDropdownMenuLabel class="text-xs text-muted-foreground">
                  Signed in as {{ user?.email }}
                </UiDropdownMenuLabel>
                <UiDropdownMenuItem
                  icon="lucide:settings"
                  title="Settings"
                  @click="navigateTo('/settings')"
                />
                <UiDropdownMenuSeparator />
                <UiDropdownMenuItem
                  icon="lucide:log-out"
                  title="Log out"
                  @click="signOut"
                />
              </UiDropdownMenuContent>
            </UiDropdownMenu>
          </UiSidebarMenuItem>
        </UiSidebarMenu>
      </UiSidebarFooter>
    </UiSidebar>

    <UiSidebarInset>
      <!-- Top bar: collapse trigger -->
      <header
        class="flex h-12 items-center gap-2 px-4 justify-end sticky top-0 bg-background z-10"
      >
        <AppCommandPalette />
        <AskTrigger v-if="can('ask.query')" />
        <NotificationsBell />
      </header>
      <slot />

      <!-- Ask The Reserve. Gated on the same key /api/ask asserts
           server-side — UI gating here is convenience only.
           Two entry points, one results surface: the header trigger opens
           the dock directly, ⌘I opens the prompt modal. Both dispatch the
           same ask event, so answers always land in the one dock. -->
      <template v-if="can('ask.query')">
        <AskModal />
        <AskDock />
      </template>
    </UiSidebarInset>
  </UiSidebarProvider>
</template>
