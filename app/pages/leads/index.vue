<script setup lang="ts">
import {
  LEAD_STATUSES,
  LEAD_INTEREST_LABELS,
  type LeadInterest,
} from "~~/shared/leads/constants";

/**
 * The leads work queue — people who raised a hand on a landing page (or
 * at the desk) and are waiting to hear back.
 *
 * Oldest first, deliberately, like /intake: a queue of people waiting,
 * not a feed of recent activity. The default view is everything still
 * open (new, contacted, qualified); the filter narrows to one status or
 * widens to all.
 */
definePageMeta({ middleware: "can", permission: "leads.view" });
useSeoMeta({ title: "Leads — The Reserve" });

interface LeadRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  interest: LeadInterest;
  source: string;
  status: string;
  consent: boolean;
  created_at: string;
}

const FILTERS: { value: string; label: string }[] = [
  { value: "open", label: "Open (new, contacted, qualified)" },
  ...LEAD_STATUSES.map((s) => ({ value: s, label: statusLabel(s).text })),
  { value: "all", label: "All" },
];

const filter = ref("open");
const { data, pending, refresh } = await useFetch<{ leads: LeadRow[] }>("/api/leads", {
  query: computed(() => ({ status: filter.value })),
});
const leads = computed(() => data.value?.leads ?? []);

// The nav dot already re-counts on every realtime event for `leads`; the
// list rides on the same signal so a lead that arrives while someone is
// looking at this page appears without a refresh, instead of the nav
// saying "1 new" above a list that says nobody is waiting.
const { pendingCount } = useLeadQueue();
watch(pendingCount, () => void refresh());

function capturedAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Status label + a shape, never colour alone. */
function statusLabel(status: string) {
  return (
    {
      new: { text: "New", icon: "lucide:sparkles" },
      contacted: { text: "Contacted", icon: "lucide:phone-outgoing" },
      qualified: { text: "Qualified", icon: "lucide:badge-check" },
      converted: { text: "Converted", icon: "lucide:arrow-right-circle" },
      lost: { text: "Lost", icon: "lucide:circle-x" },
    }[status] ?? { text: status, icon: "lucide:circle" }
  );
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-4 py-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Leads</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          People who asked about The Reserve and are waiting to hear back.
        </p>
      </div>
      <div class="w-full sm:w-72">
        <label class="sr-only" for="lead-filter">Show</label>
        <UiSelect v-model="filter">
          <UiSelectTrigger id="lead-filter" />
          <UiSelectContent>
            <UiSelectItem
              v-for="f in FILTERS"
              :key="f.value"
              :value="f.value"
              :text="f.label"
            />
          </UiSelectContent>
        </UiSelect>
      </div>
    </div>

    <!-- Skeleton on the FIRST load only. A background refetch (the list
         follows the live queue count) keeps the rows on screen instead of
         flashing them out and back in. -->
    <div v-if="pending && !data" class="mt-8 space-y-3">
      <UiSkeleton v-for="i in 3" :key="i" class="h-20 w-full rounded-xl" />
    </div>

    <div
      v-else-if="!leads.length"
      class="mt-8 rounded-xl border border-dashed p-10 text-center"
    >
      <Icon
        name="lucide:megaphone"
        class="text-muted-foreground mx-auto size-8"
        aria-hidden="true"
      />
      <p class="mt-3 font-medium">
        {{ filter === "open" ? "Nobody is waiting" : "No leads here" }}
      </p>
      <p class="text-muted-foreground mt-1 text-sm">
        Leads captured by the website, or entered at the desk, appear here.
      </p>
    </div>

    <ul v-else class="mt-8 space-y-3">
      <li v-for="lead in leads" :key="lead.id">
        <NuxtLink
          :to="`/leads/${lead.id}`"
          class="hover:border-primary/40 flex items-center justify-between gap-4 rounded-xl border p-4 transition"
        >
          <div class="min-w-0">
            <p class="truncate font-medium">
              {{ lead.first_name }} {{ lead.last_name }}
            </p>
            <p class="text-muted-foreground truncate text-sm">
              {{ lead.email }}<span v-if="lead.phone"> · {{ lead.phone }}</span>
            </p>
            <p class="text-muted-foreground mt-1 truncate text-xs">
              {{ LEAD_INTEREST_LABELS[lead.interest] ?? lead.interest }}
              · via {{ lead.source }}
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-4">
            <span class="text-muted-foreground hidden text-sm sm:inline">
              {{ capturedAgo(lead.created_at) }}
            </span>
            <span class="flex items-center gap-1.5 text-sm font-medium">
              <Icon
                :name="statusLabel(lead.status).icon"
                class="size-4"
                aria-hidden="true"
              />
              {{ statusLabel(lead.status).text }}
            </span>
            <Icon
              name="lucide:chevron-right"
              class="text-muted-foreground size-4"
              aria-hidden="true"
            />
          </div>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
