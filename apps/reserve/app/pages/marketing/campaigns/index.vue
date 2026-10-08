<script setup lang="ts">
import { dateTimeLabel } from "~~/shared/time/format";

// The location's zone (business time, CLAUDE.md: when the campaign went out).
const { data: timezone } = await useLocationTimezone();
const tz = () => timezone.value;

/**
 * /marketing/campaigns — the campaign list and composer (marketing
 * campaigns, phase 1 — docs/design/marketing-campaigns-design.md).
 *
 * Admin + super_admin only: the `admin` middleware sends anyone else
 * home, is_admin() in RLS scopes the list, and the routes gate the
 * preview and the send. Two views on one page: the list of past sends,
 * and the composer. The composer's Preview and Send both run the same
 * audience builder on the server; the send re-runs it at send time so
 * the count in the confirmation is what the sender saw a moment ago,
 * not a promise.
 */
definePageMeta({ middleware: "admin" });
useSeoMeta({ title: "Campaigns — The Reserve" });

const supabase = useSupabaseClient();
const toast = useToast();

interface CampaignRow {
  id: string;
  subject: string;
  status: string;
  recipient_count: number | null;
  sent_at: string | null;
  created_at: string;
}

const { data: campaigns, refresh } = await useAsyncData(
  "campaigns",
  async () => {
    const { data, error } = await supabase
      .from("campaigns")
      .select("id, subject, status, recipient_count, sent_at, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as CampaignRow[];
  },
);

const STATUS: Record<string, { text: string; icon: string }> = {
  draft: { text: "Draft", icon: "lucide:pencil" },
  sending: { text: "Sending", icon: "lucide:loader" },
  sent: { text: "Sent", icon: "lucide:circle-check" },
  failed: { text: "Failed", icon: "lucide:circle-x" },
};

function when(iso: string | null) {
  if (!iso) return "";
  return dateTimeLabel(iso, tz(), { year: true });
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------
const composing = ref(false);
const subject = ref("");
const body = ref("");
/** "all" or one of the month options, as a string for UiSelect. */
const audience = ref("all");
const AUDIENCES = [
  { value: "all", label: "All opted-in clients" },
  { value: "1", label: "Clients who visited in the last month" },
  { value: "3", label: "Clients who visited in the last 3 months" },
  { value: "6", label: "Clients who visited in the last 6 months" },
  { value: "12", label: "Clients who visited in the last 12 months" },
];
const audienceFilter = computed(() =>
  audience.value === "all" ? null : { last_visit_months: Number(audience.value) },
);

const preview = ref<{ count: number; recipients: { id: string; name: string }[] } | null>(null);
const previewing = ref(false);
// A preview belongs to the audience it was run for; changing the
// selector invalidates it so the confirm never quotes a stale count.
watch(audience, () => {
  preview.value = null;
});

async function runPreview() {
  previewing.value = true;
  try {
    preview.value = await $fetch("/api/marketing/campaigns/preview", {
      query: audience.value === "all" ? {} : { last_visit_months: audience.value },
    });
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error("Could not preview", err.data?.statusMessage ?? "Something went wrong.");
  } finally {
    previewing.value = false;
  }
}

const canSend = computed(
  () => !!subject.value.trim() && !!body.value.trim() && !!preview.value && preview.value.count > 0,
);

const confirmOpen = ref(false);
const sending = ref(false);
async function send() {
  sending.value = true;
  try {
    const result = await $fetch<{ sent: number; failed: number; recipientCount: number }>(
      "/api/marketing/campaigns",
      {
        method: "POST",
        body: { subject: subject.value, body: body.value, audience_filter: audienceFilter.value },
      },
    );
    toast.success(
      "Campaign sent",
      result.failed
        ? `${result.sent} sent, ${result.failed} could not be delivered.`
        : `Sent to ${result.sent} client${result.sent === 1 ? "" : "s"}.`,
    );
    subject.value = "";
    body.value = "";
    audience.value = "all";
    preview.value = null;
    composing.value = false;
    await refresh();
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error("Could not send", err.data?.statusMessage ?? "Something went wrong.");
  } finally {
    sending.value = false;
    confirmOpen.value = false;
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-4xl px-4 py-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Campaigns</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Promotional email to clients who have opted in. Every message
          carries a one-click unsubscribe.
        </p>
      </div>
      <UiButton v-if="!composing" @click="composing = true">
        <Icon name="lucide:plus" class="size-4" aria-hidden="true" />
        New campaign
      </UiButton>
    </div>

    <!-- Composer -->
    <section v-if="composing" class="mt-8 rounded-xl border bg-card p-6">
      <h2 class="font-medium">New campaign</h2>
      <div class="mt-4 grid gap-5">
        <div>
          <label for="campaign-subject" class="text-sm font-medium">Subject</label>
          <UiInput
            id="campaign-subject"
            v-model="subject"
            class="mt-1.5"
            placeholder="Spring facial special: 20% off through April"
            :maxlength="200"
          />
        </div>
        <div>
          <label for="campaign-body" class="text-sm font-medium">Message</label>
          <UiTextarea
            id="campaign-body"
            v-model="body"
            class="mt-1.5 min-h-40"
            placeholder="Write the message as plain text. Blank lines start new paragraphs. The unsubscribe link is added for you."
          />
        </div>
        <div>
          <label for="campaign-audience" class="text-sm font-medium">Audience</label>
          <UiSelect v-model="audience">
            <UiSelectTrigger id="campaign-audience" class="mt-1.5" />
            <UiSelectContent>
              <UiSelectItem
                v-for="a in AUDIENCES"
                :key="a.value"
                :value="a.value"
                :text="a.label"
              />
            </UiSelectContent>
          </UiSelect>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <UiButton variant="outline" :disabled="previewing" @click="runPreview">
            <Icon name="lucide:users" class="size-4" aria-hidden="true" />
            {{ previewing ? "Checking…" : "Preview audience" }}
          </UiButton>
          <p v-if="!preview" class="text-muted-foreground text-sm">
            Preview the audience before you can send.
          </p>
        </div>

        <div v-if="preview" class="rounded-lg border p-4">
          <p class="text-sm font-medium">
            {{ preview.count }} client{{ preview.count === 1 ? "" : "s" }} will receive this
          </p>
          <p v-if="!preview.count" class="text-muted-foreground mt-1 text-sm">
            Nobody matches this audience. Widen it, or check clients' communication preferences.
          </p>
          <ul v-else class="text-muted-foreground mt-2 max-h-48 space-y-0.5 overflow-y-auto text-sm">
            <li v-for="r in preview.recipients" :key="r.id">{{ r.name }}</li>
          </ul>
        </div>

        <div class="flex gap-2">
          <UiAlertDialog v-model:open="confirmOpen">
            <UiAlertDialogTrigger as-child>
              <UiButton :disabled="!canSend || sending">
                <Icon name="lucide:send" class="size-4" aria-hidden="true" />
                Send now
              </UiButton>
            </UiAlertDialogTrigger>
            <UiAlertDialogContent>
              <UiAlertDialogHeader>
                <UiAlertDialogTitle
                  :title="`Send to ${preview?.count ?? 0} client${preview?.count === 1 ? '' : 's'}?`"
                />
                <UiAlertDialogDescription
                  description="This cannot be undone. Each client receives the message with their own unsubscribe link."
                />
              </UiAlertDialogHeader>
              <UiAlertDialogFooter>
                <UiAlertDialogCancel :disabled="sending" />
                <UiAlertDialogAction
                  :text="sending ? 'Sending…' : 'Send'"
                  :disabled="sending"
                  @click.prevent="send"
                />
              </UiAlertDialogFooter>
            </UiAlertDialogContent>
          </UiAlertDialog>
          <UiButton variant="outline" :disabled="sending" @click="composing = false">
            Cancel
          </UiButton>
        </div>
      </div>
    </section>

    <!-- List -->
    <div
      v-if="!campaigns?.length"
      class="mt-8 rounded-xl border border-dashed p-10 text-center"
    >
      <Icon name="lucide:mail" class="text-muted-foreground mx-auto size-8" aria-hidden="true" />
      <p class="mt-3 font-medium">No campaigns sent yet</p>
      <p class="text-muted-foreground mt-1 text-sm">
        Campaigns you send appear here, newest first.
      </p>
    </div>

    <ul v-else class="mt-8 space-y-3">
      <li v-for="c in campaigns" :key="c.id">
        <NuxtLink
          :to="`/marketing/campaigns/${c.id}`"
          class="hover:border-primary/40 flex items-center justify-between gap-4 rounded-xl border p-4 transition"
        >
        <div class="min-w-0">
          <p class="truncate font-medium">{{ c.subject }}</p>
          <p class="text-muted-foreground text-sm">
            {{ when(c.sent_at ?? c.created_at) }}
            · {{ c.recipient_count ?? 0 }} recipient{{ c.recipient_count === 1 ? "" : "s" }}
          </p>
        </div>
        <UiBadge variant="outline" class="shrink-0 gap-1">
          <Icon :name="STATUS[c.status]?.icon ?? 'lucide:circle'" class="size-3.5" aria-hidden="true" />
          {{ STATUS[c.status]?.text ?? c.status }}
        </UiBadge>
        </NuxtLink>
      </li>
    </ul>
  </div>
</template>
