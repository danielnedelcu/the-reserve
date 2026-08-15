<script setup lang="ts">
const { can, load } = usePermissions();
const { signOut } = useAuth();
const user = useSupabaseUser();
const route = useRoute();

await load();

interface NavItem {
  title: string;
  to: string;
  icon: string;
  show: boolean;
}
interface NavSection {
  label: string;
  items: NavItem[];
}

const navSections = computed<NavSection[]>(() =>
  [
    {
      label: "Operations",
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
      ],
    },
    {
      label: "Administrative",
      items: [
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
          title: "Clients",
          to: "/clients",
          icon: "lucide:contact",
          show: can("clients.view"),
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
        // Future entries follow the same pattern:
        // { title: "Financials", to: "/financials", icon: "lucide:chart-bar", show: can("financials.view_summary") },
      ],
    },
  ]
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.show),
    }))
    // A role that can't see any item in a section shouldn't see the label either
    .filter((section) => section.items.length > 0),
);

function isActive(to: string) {
  return to === "/" ? route.path === "/" : route.path.startsWith(to);
}

const initials = computed(() =>
  (user.value?.email ?? "?").slice(0, 2).toUpperCase(),
);
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
                  :tooltip="item.title"
                >
                  <NuxtLink :to="item.to">
                    <Icon :name="item.icon" />
                    <span>{{ item.title }}</span>
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
        <NotificationsBell />
      </header>
      <slot />
    </UiSidebarInset>
  </UiSidebarProvider>
</template>
