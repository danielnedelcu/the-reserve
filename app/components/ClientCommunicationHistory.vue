<script setup lang="ts">
import {
  appointmentReference,
  communicationChannelLabel,
  communicationKindLabel,
  isResendable,
} from "~~/shared/communications/kinds";

/**
 * Communication history on the client profile — phase 5 of the client
 * communications lifecycle (docs/design/client-communications-design.md).
 *
 * READ-ONLY view of communications_sent for this client, newest first,
 * straight from the table under the clients.view read policy: RLS scopes
 * it to the staff member's org, and the profile page is already gated on
 * the same permission. The appointment reference comes from each row's
 * metadata SNAPSHOT, never a join — the history says what the client was
 * told, even if the appointment has since been cancelled or moved.
 *
 * The one action is "Resend", on booking confirmations only (the shared
 * isResendable decides, for this button and for the route). It calls
 * POST /api/clients/:id/communications/resend, which sends the email
 * again and appends a NEW row; nothing here ever updates or deletes.
 */
const props = defineProps<{ clientId: string; timezone?: string }>();

const supabase = useSupabaseClient();
const toast = useToast();
const { can } = usePermissions();

const { data: rows, refresh } = await useAsyncData(
  `client-communications-${props.clientId}`,
  async () => {
    const { data, error } = await supabase
      .from("communications_sent")
      .select("id, kind, channel, sent_at, appointment_id, metadata")
      .eq("client_id", props.clientId)
      .order("sent_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  },
);

function sentLabel(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const resending = ref<string | null>(null);
async function resend(sentId: string) {
  resending.value = sentId;
  try {
    await $fetch(`/api/clients/${props.clientId}/communications/resend`, {
      method: "POST",
      body: { sentId },
    });
    toast.success("Confirmation resent");
    await refresh();
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not resend",
      err.data?.statusMessage ?? "Something went wrong.",
    );
  } finally {
    resending.value = null;
  }
}
</script>

<template>
  <section class="rounded-md border bg-card p-5" data-communication-history>
    <h2 class="font-medium">Communication history</h2>

    <!-- The pre-phase-2 state: clients whose bookings predate the
         confirmation email. Plain, not alarming. -->
    <p v-if="!rows?.length" class="text-muted-foreground mt-2 text-sm">
      No communications sent yet.
    </p>

    <ol v-else class="mt-4 divide-y">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span class="font-medium">
              {{ communicationKindLabel(row.kind) }}
            </span>
            <span class="text-muted-foreground">
              {{ communicationChannelLabel(row.channel) }}
            </span>
            <span
              v-if="(row.metadata as { resent_from?: string } | null)?.resent_from"
              class="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs"
            >
              Resent
            </span>
          </div>
          <div class="text-muted-foreground mt-0.5 text-xs">
            {{ sentLabel(row.sent_at) }}
            <template v-if="appointmentReference(row.metadata, timezone)">
              · {{ appointmentReference(row.metadata, timezone) }}
            </template>
          </div>
        </div>
        <UiButton
          v-if="isResendable(row.kind) && can('clients.edit')"
          size="sm"
          variant="outline"
          :disabled="resending !== null"
          @click="resend(row.id)"
        >
          <Icon name="lucide:send" class="size-4" aria-hidden="true" />
          {{ resending === row.id ? "Sending…" : "Resend" }}
        </UiButton>
      </li>
    </ol>
  </section>
</template>
