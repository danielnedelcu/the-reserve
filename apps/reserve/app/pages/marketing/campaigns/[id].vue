<script setup lang="ts">
import { dateTimeLabel } from "~~/shared/time/format";
import {
  RECIPIENT_STATUS_LABELS,
  campaignStats,
  recipientStatus,
  sortRecipients,
  type RecipientStatus,
} from "~~/shared/campaigns/analytics";

// The location's zone (business time, CLAUDE.md: when the campaign went out).
const { data: timezone } = await useLocationTimezone();
const tz = () => timezone.value;


/**
 * /marketing/campaigns/<id> — one campaign's results (marketing
 * campaigns, phase 2). Admin + super_admin, the same gate as the list.
 *
 * Everything shown is computed from campaign_recipients rows the Resend
 * webhook stamps (shared/campaigns/analytics.ts does the arithmetic).
 * Open rates are honest about their limits: many mail clients fetch the
 * tracking pixel whether or not a person read anything, so the rate is
 * directional, and the page says so under the number.
 *
 * Reads go straight through RLS: campaigns_manage and
 * campaign_recipients_read both require is_admin(), and the client name
 * join is under clients.view, which admins hold.
 */
definePageMeta({ middleware: "admin" });

const route = useRoute();
const supabase = useSupabaseClient();
const campaignId = route.params.id as string;

const { data: campaign } = await useAsyncData(`campaign-${campaignId}`, async () => {
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, subject, status, recipient_count, sent_at, created_at, audience_filter")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data;
});

const { data: recipients } = await useAsyncData(
  `campaign-recipients-${campaignId}`,
  async () => {
    const { data, error } = await supabase
      .from("campaign_recipients")
      .select(
        "id, sent_at, opened_at, clicked_at, unsubscribed_at, client:clients(first_name, last_name)",
      )
      .eq("campaign_id", campaignId);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: r.id,
      name: r.client ? `${r.client.first_name} ${r.client.last_name}` : "Unknown client",
      sent_at: r.sent_at,
      opened_at: r.opened_at,
      clicked_at: r.clicked_at,
      unsubscribed_at: r.unsubscribed_at,
    }));
  },
);

useSeoMeta({
  title: () => (campaign.value ? `${campaign.value.subject} — The Reserve` : "Campaign — The Reserve"),
});

const stats = computed(() =>
  campaignStats(recipients.value ?? [], campaign.value?.recipient_count ?? 0),
);
const sorted = computed(() => sortRecipients(recipients.value ?? []));

const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

function when(iso: string | null) {
  if (!iso) return "";
  return dateTimeLabel(iso, tz(), { year: true });
}

const audienceLabel = computed(() => {
  const f = campaign.value?.audience_filter as { last_visit_months?: number } | null;
  if (!f?.last_visit_months) return "All opted-in clients";
  const n = f.last_visit_months;
  return n === 1 ? "Clients who visited in the last month" : `Clients who visited in the last ${n} months`;
});

const STATUS_ICON: Record<RecipientStatus, string> = {
  unsubscribed: "lucide:user-round-x",
  clicked: "lucide:mouse-pointer-click",
  opened: "lucide:mail-open",
  sent: "lucide:mail",
};
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-4 py-8">
    <NuxtLink
      to="/marketing/campaigns"
      class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <Icon name="lucide:arrow-left" class="size-4" aria-hidden="true" />
      All campaigns
    </NuxtLink>

    <div v-if="!campaign" class="mt-8 rounded-xl border border-dashed p-10 text-center">
      <p class="font-medium">Campaign not found</p>
    </div>

    <template v-else>
      <div class="mt-4">
        <h1 class="text-2xl font-semibold">{{ campaign.subject }}</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          {{ when(campaign.sent_at ?? campaign.created_at) }}
          · {{ campaign.recipient_count ?? 0 }} recipient{{ campaign.recipient_count === 1 ? "" : "s" }}
          · {{ audienceLabel }}
        </p>
      </div>

      <!-- Summary -->
      <div class="mt-6 grid gap-4 sm:grid-cols-3">
        <div class="rounded-xl border p-4">
          <p class="text-muted-foreground text-xs uppercase tracking-wide">Open rate</p>
          <p class="mt-1 text-2xl font-semibold">{{ pct(stats.openRate) }}</p>
          <p class="text-muted-foreground mt-1 text-xs">
            {{ stats.opened }} of {{ stats.recipients }}. Approximate — some email
            clients load tracking pixels automatically.
          </p>
        </div>
        <div class="rounded-xl border p-4">
          <p class="text-muted-foreground text-xs uppercase tracking-wide">Click rate</p>
          <p class="mt-1 text-2xl font-semibold">{{ pct(stats.clickRate) }}</p>
          <p class="text-muted-foreground mt-1 text-xs">{{ stats.clicked }} of {{ stats.recipients }}</p>
        </div>
        <div class="rounded-xl border p-4">
          <p class="text-muted-foreground text-xs uppercase tracking-wide">Unsubscribed</p>
          <p class="mt-1 text-2xl font-semibold">{{ stats.unsubscribed }}</p>
          <p class="text-muted-foreground mt-1 text-xs">
            Opted out of promotional email from this send
          </p>
        </div>
      </div>

      <!-- Recipients -->
      <section class="mt-8">
        <h2 class="font-medium">Recipients</h2>

        <p v-if="!sorted.length" class="text-muted-foreground mt-2 text-sm">
          No recipient records for this campaign.
        </p>
        <template v-else>
          <p v-if="stats.noEngagement" class="text-muted-foreground mt-2 text-sm">
            No engagement data yet — events will appear here once clients open
            or click the email.
          </p>
          <ul class="mt-4 divide-y rounded-xl border">
            <li
              v-for="r in sorted"
              :key="r.id"
              class="flex items-center justify-between gap-4 px-4 py-3"
            >
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ r.name }}</p>
                <p class="text-muted-foreground text-xs">Sent {{ when(r.sent_at) }}</p>
              </div>
              <UiBadge variant="outline" class="shrink-0 gap-1">
                <Icon
                  :name="STATUS_ICON[recipientStatus(r)]"
                  class="size-3.5"
                  aria-hidden="true"
                />
                {{ RECIPIENT_STATUS_LABELS[recipientStatus(r)] }}
              </UiBadge>
            </li>
          </ul>
        </template>
      </section>
    </template>
  </div>
</template>
