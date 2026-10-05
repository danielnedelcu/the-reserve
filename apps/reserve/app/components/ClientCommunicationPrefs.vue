<script setup lang="ts">
import type { TablesUpdate } from "~~/shared/types/database";

/**
 * Communication preferences on the client profile — phase 1 of the client
 * communications lifecycle (docs/design/client-communications-design.md).
 *
 * Two SETTINGS and one RECORD:
 *  - communication_channel (email | sms | both): HOW to reach the client.
 *    SMS delivery is deferred, so the option is offered honestly — the
 *    field is real, the delivery is not yet — and the note says so.
 *  - communication_opted_in: non-essential communications only (birthday,
 *    post-visit follow-up). Transactional messages fire regardless, and
 *    the label says which is which so nobody expects a reminder to stop.
 *  - late_cancellation_waiver_used: READ-ONLY here on purpose. It is a
 *    record the fee engine writes once; staff can see it, never reset it.
 *
 * Saves go straight through the clients table under the existing
 * clients_update RLS policy (clients.edit) — the same path the client edit
 * sheet uses. No new route: there is no pricing, no external call, and
 * the database is the one enforcing who may write.
 */
const props = defineProps<{
  clientId: string;
  channel: string;
  optedIn: boolean;
  waiverUsed: boolean;
}>();
const emit = defineEmits<{ saved: [] }>();

const supabase = useSupabaseClient();
const toast = useToast();
const { can } = usePermissions();

const CHANNELS = [
  { value: "email", label: "Email" },
  { value: "sms", label: "SMS" },
  { value: "both", label: "Both" },
] as const;
const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  sms: "SMS",
  both: "Email and SMS",
};

const editing = ref(false);
const saving = ref(false);
const draftChannel = ref(props.channel);
const draftOptedIn = ref(props.optedIn);

function startEdit() {
  draftChannel.value = props.channel;
  draftOptedIn.value = props.optedIn;
  editing.value = true;
}

async function save() {
  saving.value = true;
  const payload: Pick<
    TablesUpdate<"clients">,
    "communication_channel" | "communication_opted_in"
  > = {
    communication_channel: draftChannel.value,
    communication_opted_in: draftOptedIn.value,
  };
  const { error } = await supabase
    .from("clients")
    .update(payload)
    .eq("id", props.clientId);
  saving.value = false;
  if (error) {
    toast.error("Could not save preferences", error.message);
    return;
  }
  toast.success("Communication preferences saved");
  editing.value = false;
  emit("saved");
}
</script>

<template>
  <section class="rounded-md border bg-card p-5" data-communication-prefs>
    <div class="flex items-center justify-between gap-3">
      <h2 class="font-medium">Communication preferences</h2>
      <UiButton
        v-if="can('clients.edit') && !editing"
        size="sm"
        variant="outline"
        @click="startEdit"
      >
        <Icon name="lucide:pencil" class="size-4" />
        Edit
      </UiButton>
    </div>

    <!-- Read-only view -->
    <div v-if="!editing" class="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-3">
      <div>
        <p class="text-muted-foreground text-xs uppercase tracking-wide">
          Channel
        </p>
        <p class="mt-1 text-sm">{{ CHANNEL_LABELS[channel] ?? channel }}</p>
        <p
          v-if="channel !== 'email'"
          class="text-muted-foreground mt-1 text-xs"
        >
          SMS delivery coming soon — email is used until then.
        </p>
      </div>
      <div>
        <p class="text-muted-foreground text-xs uppercase tracking-wide">
          Non-essential messages
        </p>
        <p class="mt-1 text-sm">
          {{ optedIn ? "Opted in" : "Opted out" }}
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          Birthday wishes, post-visit follow-ups. Appointment confirmations and
          reminders are always sent.
        </p>
      </div>
      <div>
        <p class="text-muted-foreground text-xs uppercase tracking-wide">
          Late cancellation waiver
        </p>
        <p class="mt-1 flex items-center gap-1.5 text-sm">
          <Icon
            :name="waiverUsed ? 'lucide:circle-off' : 'lucide:circle-check'"
            class="text-muted-foreground size-4"
            aria-hidden="true"
          />
          {{ waiverUsed ? "Used" : "Available" }}
        </p>
        <p class="text-muted-foreground mt-1 text-xs">
          One per client, set when a first late cancellation is forgiven. A
          record, not a setting.
        </p>
      </div>
    </div>

    <!-- Edit view -->
    <form v-else class="mt-4 grid gap-5" @submit.prevent="save">
      <fieldset :disabled="saving">
        <legend class="text-sm font-medium">Channel</legend>
        <UiRadioGroup
          v-model="draftChannel"
          orientation="horizontal"
          class="mt-2 flex flex-wrap gap-4"
        >
          <label
            v-for="c in CHANNELS"
            :key="c.value"
            :for="`channel-${c.value}`"
            class="flex cursor-pointer items-center gap-2 text-sm"
          >
            <UiRadioGroupItem :id="`channel-${c.value}`" :value="c.value" />
            {{ c.label }}
          </label>
        </UiRadioGroup>
        <p class="text-muted-foreground mt-2 text-xs">
          SMS delivery coming soon — selecting it will default to email until
          SMS is enabled.
        </p>
      </fieldset>

      <div class="flex items-start gap-3">
        <UiCheckbox
          id="opted-in"
          v-model="draftOptedIn"
          class="mt-0.5"
          :disabled="saving"
        />
        <label for="opted-in" class="text-sm">
          Receive non-essential communications (birthday wishes, post-visit
          follow-ups).
          <span class="text-muted-foreground block text-xs">
            Appointment confirmations, reminders and cancellation notices are
            always sent.
          </span>
        </label>
      </div>

      <div class="flex gap-2">
        <UiButton type="submit" size="sm" :disabled="saving">
          {{ saving ? "Saving…" : "Save preferences" }}
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          variant="outline"
          :disabled="saving"
          @click="editing = false"
        >
          Cancel
        </UiButton>
      </div>
    </form>
  </section>
</template>
