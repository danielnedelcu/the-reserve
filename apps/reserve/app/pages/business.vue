<script setup lang="ts">
definePageMeta({ middleware: "can", permission: "org.settings.manage" });
useSeoMeta({ title: "Business — The Reserve" });

const supabase = useSupabaseClient();
const toast = useToast();

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const { data: org, refresh: refreshOrg } = await useAsyncData(
  "business-org",
  async () => {
    const { data, error } = await supabase
      .from("organizations")
      .select("id, name")
      .limit(1)
      .single();
    if (error) throw error;
    return data;
  },
);

const { data: location, refresh: refreshLocation } = await useAsyncData(
  "business-location",
  async () => {
    const { data, error } = await supabase
      .from("locations")
      .select(
        "id, name, timezone, tax_rate_bps, phone, address_line1, address_line2, city, state, postal_code",
      )
      .limit(1)
      .single();
    if (error) throw error;
    return data;
  },
);

// Local editable state, hydrated from the fetches
const orgName = ref("");
const locName = ref("");
const locPhone = ref("");
const address1 = ref("");
const address2 = ref("");
const city = ref("");
const state = ref("");
const postal = ref("");
const taxPercent = ref<number | null>(null);
const timezone = ref("");

watch(
  [org, location],
  () => {
    if (org.value) orgName.value = org.value.name;
    if (location.value) {
      locName.value = location.value.name ?? "";
      locPhone.value = location.value.phone ?? "";
      address1.value = location.value.address_line1 ?? "";
      address2.value = location.value.address_line2 ?? "";
      city.value = location.value.city ?? "";
      state.value = location.value.state ?? "";
      postal.value = location.value.postal_code ?? "";
      taxPercent.value = (location.value.tax_rate_bps ?? 0) / 100;
      timezone.value = location.value.timezone ?? "America/New_York";
    }
  },
  { immediate: true },
);

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
];

// ---------------------------------------------------------------------------
// Saves (sectioned: each card saves independently)
// ---------------------------------------------------------------------------
const savingOrg = ref(false);
async function saveOrg() {
  if (!org.value || !orgName.value.trim()) return;
  savingOrg.value = true;
  const { error } = await supabase
    .from("organizations")
    .update({ name: orgName.value.trim() })
    .eq("id", org.value.id);
  savingOrg.value = false;
  if (error) return toast.error("Could not save", error.message);
  toast.success("Business name saved");
  await refreshOrg();
}

const savingLocation = ref(false);
async function saveLocation() {
  if (!location.value) return;
  savingLocation.value = true;
  const { error } = await supabase
    .from("locations")
    .update({
      name: locName.value.trim() || location.value.name,
      phone: locPhone.value || null,
      address_line1: address1.value || null,
      address_line2: address2.value || null,
      city: city.value || null,
      state: state.value || null,
      postal_code: postal.value || null,
    })
    .eq("id", location.value.id);
  savingLocation.value = false;
  if (error) return toast.error("Could not save", error.message);
  toast.success("Location details saved");
  await refreshLocation();
}

const savingTax = ref(false);
async function saveTax() {
  if (!location.value) return;
  const pct = taxPercent.value ?? 0;
  if (pct < 0 || pct > 30) {
    return toast.error(
      "Invalid rate",
      "Enter the combined percentage, e.g. 8.9",
    );
  }
  savingTax.value = true;
  const { error } = await supabase
    .from("locations")
    .update({ tax_rate_bps: Math.round(pct * 100) })
    .eq("id", location.value.id);
  savingTax.value = false;
  if (error) return toast.error("Could not save", error.message);
  toast.success("Tax rate saved", `${pct}% on taxable retail`);
  await refreshLocation();
}

const savingTz = ref(false);
async function saveTimezone() {
  if (!location.value || !timezone.value) return;
  savingTz.value = true;
  const { error } = await supabase
    .from("locations")
    .update({ timezone: timezone.value })
    .eq("id", location.value.id);
  savingTz.value = false;
  if (error) return toast.error("Could not save", error.message);
  toast.success("Timezone saved", timezone.value);
  await refreshLocation();
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <h1 class="text-2xl font-semibold">Business</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      Organization-wide configuration. These settings affect everyone.
    </p>

    <!-- Organization -->
    <section class="mt-8 rounded-md border bg-card p-5">
      <h2 class="font-medium">Business name</h2>
      <div class="mt-3 flex flex-wrap items-end gap-3">
        <div class="min-w-64 flex-1">
          <UiInput v-model="orgName" />
        </div>
        <UiButton
          size="sm"
          :disabled="savingOrg || !orgName.trim()"
          :text="savingOrg ? 'Saving…' : 'Save'"
          @click="saveOrg"
        />
      </div>
    </section>

    <!-- Location details -->
    <section class="mt-6 rounded-md border bg-card p-5">
      <h2 class="font-medium">Location</h2>
      <p class="text-muted-foreground mt-1 text-xs">
        Appears on receipts and client-facing emails.
      </p>
      <div class="mt-4 grid gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="text-sm font-medium" for="biz-loc-name"
              >Location name</label
            >
            <UiInput id="biz-loc-name" v-model="locName" class="mt-1.5" />
          </div>
          <div>
            <label class="text-sm font-medium" for="biz-phone">Phone</label>
            <UiInput
              id="biz-phone"
              v-model="locPhone"
              type="tel"
              class="mt-1.5"
            />
          </div>
        </div>
        <div>
          <label class="text-sm font-medium" for="biz-addr1">Address</label>
          <UiInput
            id="biz-addr1"
            v-model="address1"
            placeholder="Street address"
            class="mt-1.5"
          />
        </div>
        <UiInput v-model="address2" placeholder="Suite, floor (optional)" />
        <div class="grid gap-4 sm:grid-cols-3">
          <UiInput v-model="city" placeholder="City" />
          <UiInput v-model="state" placeholder="State" />
          <UiInput v-model="postal" placeholder="ZIP" />
        </div>
        <div>
          <UiButton
            size="sm"
            :disabled="savingLocation"
            :text="savingLocation ? 'Saving…' : 'Save location'"
            @click="saveLocation"
          />
        </div>
      </div>
    </section>

    <!-- Tax -->
    <section class="mt-6 rounded-md border bg-card p-5">
      <h2 class="font-medium">Sales tax</h2>
      <p class="text-muted-foreground mt-1 text-xs">
        The combined state + local rate for this location's address — check the
        Georgia DOR rate chart. Applies to taxable retail products only
        (services are non-taxable in Georgia). Changes affect future sales; past
        transactions keep the rate they were charged.
      </p>
      <div class="mt-3 flex flex-wrap items-end gap-3">
        <div>
          <label class="text-sm font-medium" for="biz-tax">Rate (%)</label>
          <div class="mt-1.5 flex items-center gap-2">
            <UiInput
              id="biz-tax"
              v-model.number="taxPercent"
              type="number"
              min="0"
              max="30"
              step="0.05"
              class="w-28"
            />
            <span class="text-muted-foreground text-sm">%</span>
          </div>
        </div>
        <UiButton
          size="sm"
          :disabled="savingTax"
          :text="savingTax ? 'Saving…' : 'Save rate'"
          @click="saveTax"
        />
      </div>
    </section>

    <!-- Timezone -->
    <section class="mt-6 rounded-md border bg-card p-5">
      <h2 class="font-medium">Timezone</h2>
      <p class="text-muted-foreground mt-1 text-xs">
        Drives scheduling math — staff weekly hours are interpreted in this
        zone. Only change this if the business physically operates in a
        different timezone than configured.
      </p>
      <div class="mt-3 flex flex-wrap items-end gap-3">
        <div class="min-w-64">
          <UiSelect v-model="timezone">
            <UiSelectTrigger placeholder="Select timezone" />
            <UiSelectContent>
              <UiSelectItem
                v-for="tz in TIMEZONES"
                :key="tz"
                :value="tz"
                :text="tz"
              />
            </UiSelectContent>
          </UiSelect>
        </div>
        <UiButton
          size="sm"
          variant="outline"
          :disabled="savingTz"
          :text="savingTz ? 'Saving…' : 'Save timezone'"
          @click="saveTimezone"
        />
      </div>
    </section>
  </div>
</template>
