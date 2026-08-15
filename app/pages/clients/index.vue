<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

definePageMeta({ middleware: "can", permission: "clients.view" });
useSeoMeta({ title: "Clients — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
interface ClientRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  pronouns: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  preferred_contact_method: "email" | "phone" | "sms";
  marketing_opt_in: boolean;
  referral_source: string | null;
  preferred_staff_id: string | null;
  no_show_count: number;
  flags: Record<string, unknown>;
  active: boolean;
}

const { data: clients, refresh } = await useAsyncData(
  "clients-list",
  async () => {
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .order("last_name")
      .order("first_name");
    if (error) throw error;
    return (data ?? []) as ClientRow[];
  },
);

const { data: bookableStaff } = await useAsyncData(
  "clients-staff-options",
  async () => {
    const { data } = await supabase
      .from("staff")
      .select("id, display_name")
      .eq("active", true)
      .eq("bookable", true)
      .order("display_name");
    return data ?? [];
  },
);

const search = ref("");
const showInactive = ref(false);

const visibleClients = computed(() => {
  const q = search.value.trim().toLowerCase();
  return (clients.value ?? []).filter((c) => {
    if (!showInactive.value && !c.active) return false;
    if (!q) return true;
    return [c.first_name, c.last_name, c.email ?? "", c.phone ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
});

// ---------------------------------------------------------------------------
// Create / edit sheet
// ---------------------------------------------------------------------------
const ClientSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.email("Enter a valid email").or(z.literal("")),
  phone: z.string().optional(),
  dateOfBirth: z.string().optional(),
  pronouns: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
  referralSource: z.string().optional(),
});

const { handleSubmit, isSubmitting, resetForm, setValues } = useForm({
  validationSchema: toTypedSchema(ClientSchema),
});

const sheetOpen = ref(false);
const editingId = ref<string | null>(null);
const requiresCardOnFile = ref(false);
const preferredContact = ref<"email" | "phone" | "sms">("email");
const marketingOptIn = ref(false);
const marketingWasOptedIn = ref(false);
const preferredStaffId = ref("");

const sheetTitle = computed(() =>
  editingId.value ? "Edit client" : "New client",
);

function openCreate() {
  editingId.value = null;
  resetForm({
    values: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      dateOfBirth: "",
      pronouns: "",
      addressLine1: "",
      addressLine2: "",
      city: "",
      state: "",
      postalCode: "",
      emergencyName: "",
      emergencyPhone: "",
      referralSource: "",
    },
  });
  requiresCardOnFile.value = false;
  preferredContact.value = "email";
  marketingOptIn.value = false;
  marketingWasOptedIn.value = false;
  preferredStaffId.value = "";
  sheetOpen.value = true;
}

function openEdit(client: ClientRow) {
  editingId.value = client.id;
  setValues({
    firstName: client.first_name,
    lastName: client.last_name,
    email: client.email ?? "",
    phone: client.phone ?? "",
    dateOfBirth: client.date_of_birth ?? "",
    pronouns: client.pronouns ?? "",
    addressLine1: client.address_line1 ?? "",
    addressLine2: client.address_line2 ?? "",
    city: client.city ?? "",
    state: client.state ?? "",
    postalCode: client.postal_code ?? "",
    emergencyName: client.emergency_contact_name ?? "",
    emergencyPhone: client.emergency_contact_phone ?? "",
    referralSource: client.referral_source ?? "",
  });
  requiresCardOnFile.value = client.flags?.requires_card_on_file === true;
  preferredContact.value = client.preferred_contact_method ?? "email";
  marketingOptIn.value = client.marketing_opt_in;
  marketingWasOptedIn.value = client.marketing_opt_in;
  preferredStaffId.value = client.preferred_staff_id ?? "";
  sheetOpen.value = true;
}

const saveClient = handleSubmit(async (values) => {
  const payload: Record<string, unknown> = {
    first_name: values.firstName,
    last_name: values.lastName,
    email: values.email || null,
    phone: values.phone || null,
    date_of_birth: values.dateOfBirth || null,
    pronouns: values.pronouns || null,
    address_line1: values.addressLine1 || null,
    address_line2: values.addressLine2 || null,
    city: values.city || null,
    state: values.state || null,
    postal_code: values.postalCode || null,
    emergency_contact_name: values.emergencyName || null,
    emergency_contact_phone: values.emergencyPhone || null,
    referral_source: values.referralSource || null,
    preferred_contact_method: preferredContact.value,
    marketing_opt_in: marketingOptIn.value,
    preferred_staff_id: preferredStaffId.value || null,
    flags: { requires_card_on_file: requiresCardOnFile.value },
  };

  // Consent timestamp: record when opt-in turns on; clear when it turns off
  if (marketingOptIn.value && !marketingWasOptedIn.value) {
    payload.marketing_opt_in_at = new Date().toISOString();
  } else if (!marketingOptIn.value) {
    payload.marketing_opt_in_at = null;
  }

  if (editingId.value) {
    const { error } = await supabase
      .from("clients")
      .update(payload)
      .eq("id", editingId.value);
    if (error) return toast.error("Could not save client", error.message);
  } else {
    const { data: orgId } = await supabase.rpc("current_org_id");
    const { error } = await supabase
      .from("clients")
      .insert({ ...payload, organization_id: orgId });
    if (error) return toast.error("Could not create client", error.message);
  }

  toast.success(
    editingId.value ? "Client updated" : "Client created",
    `${values.firstName} ${values.lastName}`,
  );
  sheetOpen.value = false;
  await refresh();
});
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div
      class="grid grid-cols-1 gap-5 md:flex md:items-center md:justify-between"
    >
      <div>
        <h1 class="text-2xl font-semibold">Clients</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Everyone The Reserve takes care of.
        </p>
      </div>
      <UiButton v-if="can('clients.create')" size="sm" @click="openCreate">
        <Icon name="lucide:plus" class="size-4" />
        New client
      </UiButton>
    </div>

    <div class="mt-6 flex flex-wrap items-center gap-4">
      <UiInput
        v-model="search"
        placeholder="Search name, email, phone…"
        class="max-w-xs"
      />
      <label
        class="text-muted-foreground flex cursor-pointer items-center gap-2 text-sm"
      >
        <input
          v-model="showInactive"
          type="checkbox"
          class="size-4 accent-primary"
        />
        Show inactive
      </label>
    </div>

    <div
      class="mt-4 overflow-hidden rounded-xl border bg-card px-5 [&>div]:max-h-[70vh]"
    >
      <UiTable
        class="[&_td]:border-border [&_th]:border-border border-separate border-spacing-0 [&_tfoot_td]:border-t [&_th]:border-b [&_tr]:border-none [&_tr:not(:last-child)_td]:border-b"
      >
        <UiTableHeader class="bg-card/95 sticky top-0 z-10 backdrop-blur-sm">
          <UiTableRow class="hover:bg-transparent">
            <UiTableHead class="pl-0">Name</UiTableHead>
            <UiTableHead class="hidden pl-0 md:table-cell">
              Contact
            </UiTableHead>
            <UiTableHead class="pl-0">No-shows</UiTableHead>
            <UiTableHead class="pl-0">
              <span class="sr-only">Actions</span>
            </UiTableHead>
          </UiTableRow>
        </UiTableHeader>
        <UiTableBody>
          <UiTableRow v-for="client in visibleClients" :key="client.id">
            <UiTableCell class="pl-0">
              <NuxtLink :to="`/clients/${client.id}`" class="hover:underline">
                <p
                  class="font-medium"
                  :class="
                    !client.active && 'text-muted-foreground line-through'
                  "
                >
                  {{ client.last_name }}, {{ client.first_name }}
                </p>
              </NuxtLink>
              <p
                v-if="client.flags?.requires_card_on_file"
                class="text-muted-foreground text-xs"
              >
                Card on file required
              </p>
            </UiTableCell>
            <UiTableCell
              class="text-muted-foreground hidden pl-0 md:table-cell"
            >
              <p v-if="client.email" class="text-sm">{{ client.email }}</p>
              <p v-if="client.phone" class="text-xs">{{ client.phone }}</p>
            </UiTableCell>
            <UiTableCell class="pl-0">
              <span
                class="inline-block rounded-full px-2.5 py-0.5 text-xs"
                :class="
                  client.no_show_count > 0
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-secondary text-muted-foreground'
                "
              >
                {{ client.no_show_count }}
              </span>
            </UiTableCell>
            <UiTableCell class="pl-0 text-right">
              <UiButton variant="ghost" size="sm" :to="`/clients/${client.id}`"
                >View</UiButton
              >
              <UiButton
                v-if="can('clients.edit')"
                variant="ghost"
                size="sm"
                @click="openEdit(client)"
              >
                Edit
              </UiButton>
            </UiTableCell>
          </UiTableRow>
          <UiTableRow v-if="!visibleClients.length">
            <UiTableCell
              colspan="4"
              class="text-muted-foreground py-6 text-center"
            >
              {{ search ? "No clients match your search." : "No clients yet." }}
            </UiTableCell>
          </UiTableRow>
        </UiTableBody>
      </UiTable>
    </div>

    <!-- Create / edit sheet (documented ui-thing convention:
         title/description props + #content and #footer slots) -->
    <UiSheet v-model:open="sheetOpen">
      <UiSheetContent
        side="right"
        class="sm:max-w-none md:w-[90vw] lg:w-[1000px]"
        :title="sheetTitle"
        description="Client details are visible to staff per their permissions."
      >
        <template #content>
          <form
            id="client-form"
            class="min-h-0 flex-1 overflow-y-auto"
            @submit="saveClient"
          >
            <fieldset :disabled="isSubmitting" class="grid gap-5 p-4">
              <!-- Identity -->
              <div class="grid gap-4 sm:grid-cols-2">
                <UiVeeInput label="First name" name="firstName" />
                <UiVeeInput label="Last name" name="lastName" />
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <UiVeeInput
                  label="Date of birth"
                  name="dateOfBirth"
                  type="date"
                />
                <UiVeeInput
                  label="Pronouns"
                  name="pronouns"
                  placeholder="she/her (optional)"
                />
              </div>

              <!-- Contact -->
              <div class="grid gap-4 sm:grid-cols-2">
                <UiVeeInput
                  label="Email"
                  name="email"
                  type="email"
                  placeholder="optional"
                />
                <UiVeeInput
                  label="Phone"
                  name="phone"
                  type="tel"
                  placeholder="optional"
                />
              </div>
              <div>
                <label class="text-sm font-medium" for="c-contact-method">
                  Preferred contact method
                </label>
                <UiSelect v-model="preferredContact">
                  <UiSelectTrigger
                    id="c-contact-method"
                    class="mt-1.5 sm:max-w-48"
                    placeholder="Email"
                  />
                  <UiSelectContent>
                    <UiSelectItem value="email" text="Email" />
                    <UiSelectItem value="phone" text="Phone call" />
                    <UiSelectItem value="sms" text="Text message" />
                  </UiSelectContent>
                </UiSelect>
              </div>

              <!-- Address -->
              <div class="grid gap-4">
                <UiVeeInput
                  label="Address"
                  name="addressLine1"
                  placeholder="Street address"
                />
                <UiVeeInput
                  label="Address line 2"
                  name="addressLine2"
                  placeholder="Apt, suite (optional)"
                />
                <div class="grid gap-4 sm:grid-cols-3">
                  <UiVeeInput label="City" name="city" />
                  <UiVeeInput label="State" name="state" />
                  <UiVeeInput label="ZIP" name="postalCode" />
                </div>
              </div>

              <!-- Emergency contact -->
              <div class="grid gap-4 sm:grid-cols-2">
                <UiVeeInput
                  label="Emergency contact"
                  name="emergencyName"
                  placeholder="Name"
                />
                <UiVeeInput
                  label="Emergency phone"
                  name="emergencyPhone"
                  type="tel"
                />
              </div>

              <!-- Spa relationship -->
              <div class="grid gap-4 sm:grid-cols-2">
                <UiVeeInput
                  label="How did they hear about us?"
                  name="referralSource"
                  placeholder="Referral, Instagram, walk-in…"
                />
                <div>
                  <label class="text-sm font-medium" for="c-pref-staff">
                    Preferred provider
                  </label>
                  <UiSelect v-model="preferredStaffId">
                    <UiSelectTrigger
                      id="c-pref-staff"
                      class="mt-1.5"
                      placeholder="No preference"
                    />
                    <UiSelectContent>
                      <UiSelectItem value="none" text="No preference" />
                      <UiSelectItem
                        v-for="s in bookableStaff"
                        :key="s.id"
                        :value="s.id"
                        :text="s.display_name"
                      />
                    </UiSelectContent>
                  </UiSelect>
                </div>
              </div>

              <div class="grid gap-2">
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    v-model="marketingOptIn"
                    type="checkbox"
                    class="size-4 accent-primary"
                  />
                  Opted in to marketing emails and promotions
                </label>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    v-model="requiresCardOnFile"
                    type="checkbox"
                    class="size-4 accent-primary"
                  />
                  Requires card on file (per cancellation policy)
                </label>
              </div>
            </fieldset>
          </form>
        </template>

        <template #footer>
          <UiSheetFooter
            class="border-t p-4 flex-row justify-end gap-2 items-center"
          >
            <UiSheetClose as-child>
              <UiButton variant="outline" type="button" class="mt-2 sm:mt-0">
                Cancel
              </UiButton>
            </UiSheetClose>
            <UiButton
              type="submit"
              form="client-form"
              :text="isSubmitting ? 'Saving…' : 'Save client'"
            />
          </UiSheetFooter>
        </template>
      </UiSheetContent>
    </UiSheet>
  </div>
</template>
