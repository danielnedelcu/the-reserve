<script setup lang="ts">
/**
 * The review queue — people who have submitted an intake form and are
 * waiting to be seen.
 *
 * Oldest first, deliberately: this is a queue of people waiting, not a
 * feed of recent activity, so the person who has waited longest is the one
 * at the top.
 */
definePageMeta({ middleware: "can", permission: "forms.responses.view" });
useSeoMeta({ title: "New members — The Reserve" });

interface ProspectRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  status: string;
  submitted_at: string;
  reviewed_at: string | null;
}

const showAll = ref(false);
const { data, pending } = await useFetch<{ prospects: ProspectRow[] }>(
  "/api/prospects",
  { query: computed(() => ({ status: showAll.value ? "all" : "pending" })) },
);

const prospects = computed(() => data.value?.prospects ?? []);

function waitingSince(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Status label + a shape, never colour alone. */
function statusLabel(status: string) {
  return (
    {
      submitted: { text: "Waiting", icon: "lucide:clock" },
      under_review: { text: "Being reviewed", icon: "lucide:eye" },
      approved: { text: "Approved", icon: "lucide:circle-check" },
      rejected: { text: "Not approved", icon: "lucide:circle-x" },
    }[status] ?? { text: status, icon: "lucide:circle" }
  );
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-4 py-8">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">New members</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          People who have sent in their intake form and are waiting to join.
        </p>
      </div>
      <UiButton variant="outline" size="sm" @click="showAll = !showAll">
        {{ showAll ? "Show waiting only" : "Show all" }}
      </UiButton>
    </div>

    <div v-if="pending" class="mt-8 space-y-3">
      <UiSkeleton v-for="i in 3" :key="i" class="h-20 w-full rounded-xl" />
    </div>

    <div
      v-else-if="!prospects.length"
      class="mt-8 rounded-xl border border-dashed p-10 text-center"
    >
      <Icon
        name="lucide:inbox"
        class="text-muted-foreground mx-auto size-8"
        aria-hidden="true"
      />
      <p class="mt-3 font-medium">Nobody is waiting</p>
      <p class="text-muted-foreground mt-1 text-sm">
        Forms people send in will appear here.
      </p>
    </div>

    <ul v-else class="mt-8 space-y-3">
      <li v-for="p in prospects" :key="p.id">
        <NuxtLink
          :to="`/intake/${p.id}`"
          class="hover:border-primary/40 flex items-center justify-between gap-4 rounded-xl border p-4 transition"
        >
          <div class="min-w-0">
            <p class="truncate font-medium">
              {{ p.first_name }} {{ p.last_name }}
            </p>
            <p class="text-muted-foreground truncate text-sm">{{ p.email }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-4">
            <span class="text-muted-foreground text-sm">
              {{ waitingSince(p.submitted_at) }}
            </span>
            <span class="flex items-center gap-1.5 text-sm font-medium">
              <Icon
                :name="statusLabel(p.status).icon"
                class="size-4"
                aria-hidden="true"
              />
              {{ statusLabel(p.status).text }}
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

    <p class="text-muted-foreground mt-8 text-xs">
      Health answers are not shown on this screen or the next one. They stay
      with the treatment record, where health notes live.
    </p>
  </div>
</template>
