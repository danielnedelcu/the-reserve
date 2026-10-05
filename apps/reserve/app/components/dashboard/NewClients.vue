<script setup lang="ts">
/**
 * DashboardNewClients — this month's newest clients, newest first.
 * In the members-only future these ARE the newest members; the clients
 * table stays the source of truth either way.
 */
const supabase = useSupabaseClient();

interface NewClient {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  created_at: string;
}

const { data: newClients } = await useAsyncData(
  "dashboard-new-clients",
  async () => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1); // local
    const { data, error } = await supabase
      .from("clients")
      .select("id, first_name, last_name, email, created_at")
      .gte("created_at", monthStart.toISOString())
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(8);
    if (error) throw error;
    return (data ?? []) as NewClient[];
  },
);

function initials(client: NewClient) {
  return `${client.first_name.charAt(0)}${client.last_name.charAt(0)}`.toUpperCase();
}

function joinedLabel(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const monthName = new Date().toLocaleDateString("en-US", { month: "long" });
</script>

<template>
  <section>
    <DashboardScrollFrame class="max-h-[450px] p-4">
      <template #header>
        <h3 class="mb-3 text-base font-medium">
          New clients ({{ monthName }})
        </h3>
      </template>

      <UiList v-if="newClients?.length">
        <template v-for="client in newClients" :key="client.id">
          <UiListItem :to="`/clients/${client.id}`" class="rounded-lg px-0">
            <UiAvatar class="size-8">
              <UiAvatarFallback class="text-xs">{{
                initials(client)
              }}</UiAvatarFallback>
            </UiAvatar>
            <UiListContent>
              <UiListTitle
                :title="`${client.first_name} ${client.last_name}`"
              />
              <UiListSubtitle
                v-if="client.email"
                class="line-clamp-1"
                :subtitle="client.email"
              />
            </UiListContent>
            <span
              class="text-muted-foreground ml-auto shrink-0 self-center text-xs"
            >
              {{ joinedLabel(client.created_at) }}
            </span>
          </UiListItem>
          <UiSeparator class="my-1 ml-auto w-full last:hidden" />
        </template>
      </UiList>

      <p v-else class="text-muted-foreground text-sm">
        No new clients yet this month.
      </p>
    </DashboardScrollFrame>
  </section>
</template>
