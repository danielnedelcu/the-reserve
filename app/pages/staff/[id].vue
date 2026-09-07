<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "staff.view" });

const route = useRoute();
const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();
const staffId = route.params.id as string;
// script: state for the sheet
const editOpen = ref(false);

// ---------------------------------------------------------------------------
// Staff member + "is this me?"
// ---------------------------------------------------------------------------
const { data: member, refresh: refreshStaff } = await useAsyncData(
  `staff-${staffId}`,
  async () => {
    const { data, error } = await supabase
      .from("staff")
      .select(
        "id, display_name, email, title, bookable, active, staff_roles(roles(name))",
      )
      .eq("id", staffId)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
);

const { data: myStaffId } = await useAsyncData("my-staff-id", async () => {
  const { data } = await supabase.rpc("current_staff_id");
  return data as string | null;
});

const isMe = computed(() => myStaffId.value === staffId);
const canEditAvailability = computed(
  () =>
    can("availability.edit.any") ||
    (isMe.value && can("availability.edit.own")),
);
const canApprove = computed(() => can("timeoff.approve"));

useSeoMeta({
  title: () =>
    member.value
      ? `${member.value.display_name} — The Reserve`
      : "Staff — The Reserve",
});

// ---------------------------------------------------------------------------
// Location (single-location org for now)
// ---------------------------------------------------------------------------
const { data: location } = await useAsyncData("primary-location", async () => {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
});

// ---------------------------------------------------------------------------
// Weekly availability rules
// ---------------------------------------------------------------------------
interface Rule {
  id: string;
  day_of_week: number;
  start_time: string; // "09:00:00"
  end_time: string;
}

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const { data: rules, refresh: refreshRules } = await useAsyncData(
  `availability-${staffId}`,
  async () => {
    const { data, error } = await supabase
      .from("availability_rules")
      .select("id, day_of_week, start_time, end_time")
      .eq("staff_id", staffId)
      .order("day_of_week")
      .order("start_time");
    if (error) throw error;
    return (data ?? []) as Rule[];
  },
);

const rulesByDay = computed(() => {
  const map: Record<number, Rule[]> = {};
  for (const rule of rules.value ?? []) {
    (map[rule.day_of_week] ??= []).push(rule);
  }
  return map;
});

const hhmm = (t: string) => t.slice(0, 5);

// Add-rule form
const newDay = ref(2); // Tuesday, arbitrary sensible default

/**
 * The day select, as UiSelect sees it.
 *
 * UiSelect binds STRINGS. availability_rules.day_of_week is an integer and
 * DAYS[newDay] is an array index, so the number must survive the trip
 * through the component — a bare v-model would quietly turn 2 into "2",
 * which displays identically, DAYS["2"] still resolves (array indexing
 * coerces), and only the insert would object. This bridge is the
 * TanStackTable page-size pattern: string out to the component, Number()
 * back, so `newDay` is a number everywhere else in this file.
 */
const newDayModel = computed({
  get: () => String(newDay.value),
  set: (v: string) => {
    newDay.value = Number(v);
  },
});
const newStart = ref("09:00");
const newEnd = ref("17:00");
const savingRule = ref(false);

async function addRule() {
  if (!location.value)
    return toast.error("No location", "Create a location first.");
  if (newStart.value >= newEnd.value) {
    return toast.error("Invalid hours", "Start time must be before end time.");
  }
  savingRule.value = true;
  const { error } = await supabase.from("availability_rules").insert({
    staff_id: staffId,
    location_id: location.value.id,
    day_of_week: newDay.value,
    start_time: newStart.value,
    end_time: newEnd.value,
  });
  savingRule.value = false;
  if (error) {
    // 23P01 = the no_overlapping_hours exclusion constraint fired
    if (error.code === "23P01") {
      return toast.error(
        "Hours overlap",
        `${DAYS[newDay.value]} already has hours covering part of ${newStart.value}–${newEnd.value}. Remove the existing range first.`,
      );
    }
    return toast.error("Could not add hours", error.message);
  }
  toast.success(
    "Hours added",
    `${DAYS[newDay.value]} ${newStart.value}–${newEnd.value}`,
  );
  await refreshRules();
}

async function removeRule(rule: Rule) {
  const { error } = await supabase
    .from("availability_rules")
    .delete()
    .eq("id", rule.id);
  if (error) return toast.error("Could not remove hours", error.message);
  toast.success(
    "Hours removed",
    `${DAYS[rule.day_of_week]} ${hhmm(rule.start_time)}–${hhmm(rule.end_time)}`,
  );
  await refreshRules();
}

// ---------------------------------------------------------------------------
// Time off (availability exceptions)
// ---------------------------------------------------------------------------
interface Exception {
  id: string;
  starts_at: string;
  ends_at: string;
  kind: string;
  status: "requested" | "approved" | "denied";
  note: string | null;
}

const { data: exceptions, refresh: refreshExceptions } = await useAsyncData(
  `exceptions-${staffId}`,
  async () => {
    const { data, error } = await supabase
      .from("availability_exceptions")
      .select("id, starts_at, ends_at, kind, status, note")
      .eq("staff_id", staffId)
      .gte("ends_at", new Date(Date.now() - 7 * 86_400_000).toISOString()) // recent + future
      .order("starts_at");
    if (error) throw error;
    return (data ?? []) as Exception[];
  },
);

const KIND_LABELS: Record<string, string> = {
  time_off: "Time off",
  sick: "Sick",
  break: "Break",
  extra_shift: "Extra shift",
};

const STATUS_BADGES: Record<string, string> = {
  requested: "bg-secondary text-muted-foreground",
  approved: "bg-emerald-50 text-emerald-700",
  denied: "bg-destructive/10 text-destructive",
};

// Request form
const exKind = ref("time_off");
const exStart = ref("");
const exEnd = ref("");
const exNote = ref("");
const savingException = ref(false);

const canRequest = computed(
  () => can("availability.edit.any") || (isMe.value && can("timeoff.request")),
);

async function requestTimeOff() {
  if (!exStart.value || !exEnd.value) {
    return toast.error("Missing dates", "Pick a start and end.");
  }
  if (exStart.value >= exEnd.value) {
    return toast.error("Invalid range", "Start must be before end.");
  }
  savingException.value = true;
  const { data: me } = await supabase.rpc("current_staff_id");
  if (!me) return toast.error("Session issue — please refresh");

  const { error } = await supabase.from("availability_exceptions").insert({
    staff_id: staffId,
    starts_at: new Date(exStart.value).toISOString(),
    ends_at: new Date(exEnd.value).toISOString(),
    kind: exKind.value,
    // Approvers' entries are auto-approved; own requests await approval
    status: canApprove.value ? "approved" : "requested",
    note: exNote.value || null,
    created_by: me,
  });
  savingException.value = false;
  if (error) return toast.error("Could not submit", error.message);
  toast.success(canApprove.value ? "Time off added" : "Request submitted");
  exStart.value = "";
  exEnd.value = "";
  exNote.value = "";
  await refreshExceptions();
}

async function setStatus(exception: Exception, status: "approved" | "denied") {
  const { error } = await supabase
    .from("availability_exceptions")
    .update({ status })
    .eq("id", exception.id);
  if (error) return toast.error("Could not update", error.message);
  toast.success(status === "approved" ? "Approved" : "Denied");
  await refreshExceptions();
}

function formatRange(startIso: string, endIso: string) {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return `${new Date(startIso).toLocaleString("en-US", opts)} → ${new Date(endIso).toLocaleString("en-US", opts)}`;
}

async function onStaffSaved() {
  await Promise.all([refreshStaff(), refreshRules(), refreshExceptions()]);
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <NuxtLink to="/staff" class="text-muted-foreground text-sm hover:underline">
      ← All staff
    </NuxtLink>

    <div v-if="!member" class="text-muted-foreground mt-10">
      Staff member not found.
    </div>

    <template v-else>
      <!-- Header -->
      <div class="mt-4">
        <h1 class="text-2xl font-semibold">{{ member.display_name }}</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          {{ member.title ?? "—" }} · {{ member.email }}
          <span v-if="!member.active"> · Inactive</span>
        </p>
        <UiButton
          v-if="can('staff.edit')"
          size="sm"
          variant="outline"
          @click="editOpen = true"
        >
          <Icon name="lucide:pencil" class="size-4" />
          Edit
        </UiButton>
      </div>

      <!-- Weekly hours -->
      <section class="mt-8">
        <h2 class="font-medium">Weekly hours</h2>
        <p class="text-muted-foreground mt-1 text-sm">
          Recurring working hours{{ location ? ` at ${location.name}` : "" }}.
          The scheduler only offers slots inside these windows.
        </p>

        <div class="mt-3 overflow-hidden rounded-md border bg-card">
          <div
            v-for="(day, index) in DAYS"
            :key="day"
            class="flex items-center justify-between gap-4 border-b px-5 py-3 last:border-b-0"
          >
            <p class="w-24 text-sm font-medium">{{ day }}</p>
            <div class="flex flex-1 flex-wrap gap-2">
              <span
                v-for="rule in rulesByDay[index] ?? []"
                :key="rule.id"
                class="bg-secondary inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs"
              >
                {{ hhmm(rule.start_time) }}–{{ hhmm(rule.end_time) }}
                <button
                  v-if="canEditAvailability"
                  class="text-muted-foreground hover:text-destructive"
                  :aria-label="`Remove ${day} hours`"
                  @click="removeRule(rule)"
                >
                  <Icon name="lucide:x" class="size-3" />
                </button>
              </span>
              <span
                v-if="!rulesByDay[index]?.length"
                class="text-muted-foreground text-xs"
              >
                Not working
              </span>
            </div>
          </div>
        </div>

        <!-- Add hours -->
        <div
          v-if="canEditAvailability"
          class="mt-3 flex flex-wrap items-end gap-3 rounded-md border bg-card p-4"
        >
          <div>
            <label class="text-sm font-medium" for="rule-day">Day</label>
            <UiSelect v-model="newDayModel">
              <UiSelectTrigger id="rule-day" class="mt-1.5 w-40" />
              <UiSelectContent>
                <UiSelectItem
                  v-for="(day, index) in DAYS"
                  :key="day"
                  :value="String(index)"
                  :text="day"
                />
              </UiSelectContent>
            </UiSelect>
          </div>
          <div>
            <label class="text-sm font-medium" for="rule-start">From</label>
            <input
              id="rule-start"
              v-model="newStart"
              type="time"
              class="border-input mt-1.5 block h-9 rounded-md border bg-transparent px-3 text-sm"
            />
          </div>
          <div>
            <label class="text-sm font-medium" for="rule-end">To</label>
            <input
              id="rule-end"
              v-model="newEnd"
              type="time"
              class="border-input mt-1.5 block h-9 rounded-md border bg-transparent px-3 text-sm"
            />
          </div>
          <UiButton
            size="sm"
            :disabled="savingRule"
            :text="savingRule ? 'Adding…' : 'Add hours'"
            @click="addRule"
          />
        </div>
      </section>

      <!-- Time off -->
      <section class="mt-10">
        <h2 class="font-medium">Time off & exceptions</h2>

        <ul class="mt-3 space-y-2">
          <li
            v-for="exception in exceptions"
            :key="exception.id"
            class="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-5 py-3"
          >
            <div>
              <p class="text-sm font-medium">
                {{ KIND_LABELS[exception.kind] ?? exception.kind }}
                <span
                  class="ml-2 rounded-full px-2 py-0.5 text-xs"
                  :class="STATUS_BADGES[exception.status]"
                >
                  {{ exception.status }}
                </span>
              </p>
              <p class="text-muted-foreground mt-0.5 text-xs">
                {{ formatRange(exception.starts_at, exception.ends_at) }}
                <span v-if="exception.note"> · {{ exception.note }}</span>
              </p>
            </div>
            <div
              v-if="canApprove && exception.status === 'requested'"
              class="flex gap-2"
            >
              <UiButton
                size="sm"
                variant="outline"
                @click="setStatus(exception, 'approved')"
              >
                Approve
              </UiButton>
              <UiButton
                size="sm"
                variant="ghost"
                class="text-destructive"
                @click="setStatus(exception, 'denied')"
              >
                Deny
              </UiButton>
            </div>
          </li>
          <li v-if="!exceptions?.length" class="text-muted-foreground text-sm">
            Nothing recent or upcoming.
          </li>
        </ul>

        <!-- Request form -->
        <div v-if="canRequest" class="mt-4 rounded-md border bg-card p-4">
          <p class="text-sm font-medium">
            {{ canApprove ? "Add time off" : "Request time off" }}
          </p>
          <div class="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label class="text-sm font-medium" for="ex-kind">Type</label>
              <UiSelect v-model="exKind">
                <UiSelectTrigger id="ex-kind" class="mt-1.5 w-40" />
                <UiSelectContent>
                  <UiSelectItem value="time_off" text="Time off" />
                  <UiSelectItem value="sick" text="Sick" />
                  <UiSelectItem value="extra_shift" text="Extra shift" />
                </UiSelectContent>
              </UiSelect>
            </div>
            <div>
              <label class="text-sm font-medium" for="ex-start">From</label>
              <input
                id="ex-start"
                v-model="exStart"
                type="datetime-local"
                class="border-input mt-1.5 block h-9 rounded-md border bg-transparent px-3 text-sm"
              />
            </div>
            <div>
              <label class="text-sm font-medium" for="ex-end">To</label>
              <input
                id="ex-end"
                v-model="exEnd"
                type="datetime-local"
                class="border-input mt-1.5 block h-9 rounded-md border bg-transparent px-3 text-sm"
              />
            </div>
            <input
              v-model="exNote"
              placeholder="Note (optional)"
              class="border-input mt-1.5 h-9 min-w-40 flex-1 rounded-md border bg-transparent px-3 text-sm"
            />
            <UiButton
              size="sm"
              :disabled="savingException"
              :text="
                savingException ? 'Submitting…' : canApprove ? 'Add' : 'Request'
              "
              @click="requestTimeOff"
            />
          </div>
          <p
            v-if="exKind === 'extra_shift'"
            class="text-muted-foreground mt-2 text-xs"
          >
            Extra shifts add bookable time outside the weekly hours.
          </p>
        </div>
      </section>
    </template>

    <!-- at the bottom of the template -->
    <StaffEditSheet
      v-model:open="editOpen"
      :staff-id="staffId"
      @saved="onStaffSaved()"
    />
  </div>
</template>
