<script setup lang="ts">
/**
 * The one appointment card, wherever a card appears: the day view's
 * provider lanes, the week view's day columns, the month view's chips.
 * Image 4's look — a quiet white card, client name leading, service and
 * time beneath — over THIS app's styling semantics, which are the
 * contract (docs/design/scheduler-redesign.md, MUST SURVIVE):
 *
 *   PROVIDER COLOUR is the meaning. Every card carries its provider's
 *   colour as the LEFT EDGE and the provider's tint as the FILL, from the
 *   same providerColor / providerTint pair every view used before. That
 *   is how a front desk reads a multi-provider day at a glance — whose
 *   appointment is whose — and it is set here, once, so the three views
 *   cannot drift apart. The image-4 dot in the corner is the same colour:
 *   a second carrier of the same fact, never a different one.
 *
 *   STATUS is as thin as it was: `no_show` dims the card to half opacity;
 *   cancelled appointments never reach a card (the page does not fetch
 *   them); every other status looks the same. Richer status styling is a
 *   parked project, not this component's business.
 *
 * Geometry is NOT this component's business either. The day and week
 * views position cards absolutely by the browser clock (blockStyle, with
 * its scar comment); they pass position in via `style`, and this card
 * only ever paints inside the box it is given.
 */
export interface CardAppointment {
  id: string;
  staff_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  client: { first_name: string; last_name: string } | null;
  appointment_services: { name_snapshot: string; duration_min: number }[];
}

const props = withDefaults(
  defineProps<{
    appointment: CardAppointment;
    /**
     * day — full name, service, start time (the provider-lane card)
     * week — compact: short time, "First L.", service
     * chip — one line: short time + "First L." (month cells)
     */
    variant?: "day" | "week" | "chip";
    /**
     * How much fits. Only the week view sets this, from its collision
     * layout: a card sharing its lane with one neighbour is `compact`
     * (name + time, the service goes), with two or more it is `minimal`
     * (name only). The provider colour is never what gets dropped — in
     * the week view it is the only provider signal there is — and the
     * client name is the last thing to truncate. Whatever is dropped
     * stays in the native tooltip and in the detail dialog.
     */
    density?: "full" | "compact" | "minimal";
  }>(),
  { variant: "day", density: "full" },
);

defineEmits<{ select: [] }>();

const clientName = computed(() => {
  const c = props.appointment.client;
  if (!c) return "Client";
  return props.variant === "day"
    ? `${c.first_name} ${c.last_name}`
    : `${c.first_name} ${c.last_name.charAt(0)}.`;
});

/**
 * "Signature Facial (50 min)": the duration comes from the booked service
 * row, never from the name. Service names are the bare name — the
 * booking dialog and the services page add duration the same way.
 */
const service = computed(() => {
  const s = props.appointment.appointment_services[0];
  if (!s) return "";
  return s.duration_min ? `${s.name_snapshot} (${s.duration_min} min)` : s.name_snapshot;
});

/**
 * The load-bearing pair: fill is the tint, left edge is the colour.
 *
 * The tint is a 10%-alpha wash, and it is painted as a LAYER over the
 * opaque card base (`bg-card`), not as the background colour itself. A
 * translucent card let two appointments in the same slot bleed through
 * each other into unreadable overprint; an opaque base means the upper
 * card occludes the lower one, so at least one is always legible. Laying
 * overlapping cards side by side is the grid's job (parked: overlap
 * layout), not the card's.
 */
const colourStyle = computed(() => {
  const tint = providerTint(props.appointment.staff_id);
  return {
    backgroundImage: `linear-gradient(${tint}, ${tint})`,
    borderLeftColor: providerColor(props.appointment.staff_id),
  };
});

const dimmed = computed(() => props.appointment.status === "no_show");

/** Everything, for the hover tooltip — what a narrow card had to drop. */
const fullText = computed(() => {
  const c = props.appointment.client;
  const name = c ? `${c.first_name} ${c.last_name}` : "Client";
  return [name, service.value, timeLabel(props.appointment.starts_at)]
    .filter(Boolean)
    .join(" · ");
});
</script>

<template>
  <button
    type="button"
    class="group overflow-hidden border border-border/60 border-l-4 bg-card text-left shadow-xs transition hover:shadow-md focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none"
    :class="[
      variant === 'day' ? 'rounded-sm px-2.5 py-1.5 text-xs' : '',
      variant === 'week' ? 'rounded-sm px-2 py-1 text-[11px] leading-tight' : '',
      variant === 'chip' ? 'flex w-full items-center gap-1.5 rounded-xs px-2 py-0.5 text-[11px] leading-tight' : '',
      dimmed ? 'opacity-50' : '',
    ]"
    :style="colourStyle"
    :data-appointment-id="appointment.id"
    :data-staff-id="appointment.staff_id"
    :data-status="appointment.status"
    :data-density="density"
    :title="fullText"
    @click="$emit('select')"
  >
    <template v-if="variant === 'chip'">
      <span class="text-muted-foreground shrink-0 tabular-nums">{{ shortTime(appointment.starts_at) }}</span>
      <span class="truncate font-medium">{{ clientName }}</span>
    </template>

    <!-- Lines are <div>s, not <p>s: main.css gives every <p> text-base
         and a margin, which would override the 11px week size. -->
    <template v-else>
      <div class="flex items-start justify-between gap-2">
        <div class="truncate font-medium leading-snug" :class="variant === 'day' ? 'text-sm' : ''">
          {{ clientName }}
        </div>
        <!-- image 4's corner dot — the provider colour again, same meaning -->
        <span
          class="mt-1 size-1.5 shrink-0 rounded-full"
          :style="{ backgroundColor: providerColor(appointment.staff_id) }"
          aria-hidden="true"
        />
      </div>
      <div v-if="density === 'full'" class="text-muted-foreground truncate">
        {{ service }}
      </div>
      <div v-if="density !== 'minimal'" class="text-muted-foreground tabular-nums">
        {{ variant === "day" ? timeLabel(appointment.starts_at) : shortTime(appointment.starts_at) }}
      </div>
    </template>
  </button>
</template>
