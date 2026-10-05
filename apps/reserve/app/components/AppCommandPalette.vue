<script setup lang="ts">
const supabase = useSupabaseClient();
const { can } = usePermissions();

const dialog = ref(false);
const query = ref("");
const giftLookupOpen = ref(false);

// Both triggers flip the same ref: the header button (click) and ⌘K/Ctrl+K.
useEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    dialog.value = !dialog.value;
  }
});

// ---------------------------------------------------------------------------
// Navigation destinations (mirrors the sidebar's permission gates)
// ---------------------------------------------------------------------------
const destinations = computed(() =>
  [
    { icon: "lucide:layout-dashboard", text: "Dashboard", to: "/", show: true },
    {
      icon: "lucide:calendar-days",
      text: "Schedule",
      to: "/schedule",
      show: can("appointments.view.own"),
    },
    {
      icon: "lucide:contact",
      text: "Clients",
      to: "/clients",
      show: can("clients.view"),
    },
    {
      icon: "lucide:users",
      text: "Staff",
      to: "/staff",
      show: can("staff.view"),
    },
    {
      icon: "lucide:calendar-off",
      text: "Time off",
      to: "/time-off",
      show: can("timeoff.approve"),
    },
    {
      icon: "lucide:sparkles",
      text: "Services",
      to: "/services",
      show: can("services.view"),
    },
    {
      icon: "lucide:door-open",
      text: "Rooms",
      to: "/rooms",
      show: can("services.view"),
    },
    {
      icon: "lucide:package",
      text: "Products",
      to: "/products",
      show: can("products.view"),
    },
    {
      icon: "lucide:credit-card",
      text: "New sale (checkout)",
      to: "/checkout",
      show: can("pos.checkout"),
    },
    {
      icon: "lucide:receipt",
      text: "Transactions",
      to: "/transactions",
      show: can("transactions.view"),
    },
    {
      icon: "lucide:chart-bar",
      text: "Financials",
      to: "/financials",
      show: can("financials.view_summary"),
    },
    {
      icon: "lucide:building",
      text: "Business settings",
      to: "/business",
      show: can("org.settings.manage"),
    },
  ].filter((d) => d.show),
);

// ---------------------------------------------------------------------------
// Clients (loaded once when the palette first opens; Command filters locally)
// ---------------------------------------------------------------------------
interface Hit {
  id: string;
  name: string;
}
const clients = ref<Hit[]>([]);
const staff = ref<Hit[]>([]);
const directoryLoaded = ref(false);

// People load lazily on first open; the GROUPS only render once the person
// starts typing (see `searching` below) so the palette opens showing pages,
// not a directory dump.
watch(dialog, async (open) => {
  if (!open) {
    query.value = "";
    return;
  }
  if (directoryLoaded.value) return;
  directoryLoaded.value = true;
  if (can("clients.view")) {
    const { data } = await supabase
      .from("clients")
      .select("id, first_name, last_name")
      .eq("active", true)
      .order("last_name")
      .limit(500);
    clients.value = (data ?? []).map((c) => ({
      id: c.id,
      name: `${c.first_name} ${c.last_name}`,
    }));
  }
  if (can("staff.view")) {
    const { data } = await supabase
      .from("staff")
      .select("id, display_name")
      .eq("active", true)
      .order("display_name");
    staff.value = (data ?? []).map((s) => ({ id: s.id, name: s.display_name }));
  }
});

// People groups appear only once there's a real query
const searching = computed(() => query.value.trim().length >= 2);

function go(to: string) {
  dialog.value = false;
  navigateTo(to);
}
</script>

<template>
  <div>
    <!-- Header trigger -->
    <UiButton
      variant="outline"
      size="sm"
      class="text-muted-foreground w-56 justify-start gap-2 font-normal"
      @click="dialog = true"
    >
      <Icon name="lucide:search" class="size-4 shrink-0" aria-hidden="true" />
      <span>Search…</span>
      <UiKbd class="ml-auto">⌘K</UiKbd>
    </UiButton>

    <UiCommandDialog v-model:open="dialog">
      <UiDialogTitle class="sr-only">Search</UiDialogTitle>
      <UiDialogDescription class="sr-only">
        Search clients and navigate. Arrow keys to move, Enter to select.
      </UiDialogDescription>
      <UiCommandInput
        v-model="query"
        placeholder="Search clients, staff, pages…"
      />
      <UiCommandList>
        <UiCommandEmpty>No results.</UiCommandEmpty>

        <!-- People: only once the person is typing (no directory dump) -->
        <template v-if="searching">
          <UiCommandGroup v-if="clients.length" heading="Clients" class="p-2">
            <UiCommandItem
              v-for="client in clients"
              :key="client.id"
              :value="`client ${client.name}`"
              @select="go(`/clients/${client.id}`)"
            >
              <Icon
                name="lucide:contact"
                class="size-4 opacity-60"
                aria-hidden="true"
              />
              <span>{{ client.name }}</span>
            </UiCommandItem>
          </UiCommandGroup>

          <UiCommandGroup v-if="staff.length" heading="Staff" class="p-2">
            <UiCommandItem
              v-for="member in staff"
              :key="member.id"
              :value="`staff ${member.name}`"
              @select="go(`/staff/${member.id}`)"
            >
              <Icon
                name="lucide:user"
                class="size-4 opacity-60"
                aria-hidden="true"
              />
              <span>{{ member.name }}</span>
            </UiCommandItem>
          </UiCommandGroup>

          <UiCommandSeparator />
        </template>

        <UiCommandGroup heading="Go to" class="p-2">
          <UiCommandItem
            v-for="dest in destinations"
            :key="dest.to"
            :value="`go ${dest.text}`"
            @select="go(dest.to)"
          >
            <Icon
              :name="dest.icon"
              class="size-4 opacity-60"
              aria-hidden="true"
            />
            <span>{{ dest.text }}</span>
          </UiCommandItem>
          <UiCommandItem
            value="gift card balance lookup"
            @select="((dialog = false), (giftLookupOpen = true))"
          >
            <Icon
              name="lucide:gift"
              class="size-4 opacity-60"
              aria-hidden="true"
            />
            <span>Gift card lookup</span>
          </UiCommandItem>
        </UiCommandGroup>

        <UiCommandSeparator />

        <UiCommandGroup heading="Personal" class="p-2">
          <UiCommandItem value="my settings account" @select="go('/settings')">
            <Icon
              name="lucide:settings"
              class="size-4 opacity-60"
              aria-hidden="true"
            />
            <span>My settings</span>
          </UiCommandItem>
        </UiCommandGroup>
      </UiCommandList>
    </UiCommandDialog>

    <GiftCardLookup v-model:open="giftLookupOpen" />
  </div>
</template>
