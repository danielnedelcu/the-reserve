<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";
import type { TablesUpdate, TablesInsert } from "~~/shared/types/database";

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
// TanStack table columns
// ---------------------------------------------------------------------------
const clientColumns = [
  {
    id: "name",
    accessorFn: (c: ClientRow) =>
      `${c.last_name}, ${c.first_name}`.toLowerCase(),
    header: "Name",
    enableSorting: true,
  },
  {
    id: "contact",
    accessorFn: (c: ClientRow) => c.email ?? c.phone ?? "",
    header: "Contact",
    enableSorting: true,
  },
  {
    id: "noShows",
    accessorFn: (c: ClientRow) => c.no_show_count,
    header: "No-shows",
    enableSorting: true,
  },
  // No header at all, rather than header: "" — TanStack Table v9 renders an
  // empty string as an empty text node on the client while the server emits
  // nothing, which is a hydration mismatch on every page with this column.
  { id: "actions", enableSorting: false },
];

// ---------------------------------------------------------------------------
// Create / edit sheet
// ---------------------------------------------------------------------------
const ClientSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  // Not `.or(z.literal(""))`: @vee-validate/zod 4.15 is a Zod 3 adapter
  // (peer ^3.24) and reads `issue.unionErrors` on invalid_union, which Zod
  // 4 no longer sets — every invalid email threw an uncaught TypeError from
  // the adapter (the message still rendered, but the suite counted the
  // rejection and CI failed). A refine expresses the same rule with no
  // union issue to mishandle. Tracked in docs/TODO.md: the adapter/Zod
  // mismatch bites any future union.
  email: z.string().refine((v) => v === "" || z.email().safeParse(v).success, {
    message: "Enter a valid email",
  }),
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
  const payload: Omit<TablesInsert<"clients">, "organization_id"> = {
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
    if (!orgId) return toast.error("Session issue — please refresh");
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
  <div class="mx-auto flex h-[calc(100dvh-3rem)] w-full flex-col p-6 md:p-10">
    <!-- The page owns the viewport: the layout header is h-12 (3rem), so
         this root fills the rest, as a flex column. Everything above the
         table is shrink-0; the table card is the one thing allowed to
         shrink, which is what lets a long list scroll inside the card with
         the pager pinned at the bottom of the window, while a short list
         keeps the card content-sized and the pager right under the last
         row. -->
    <div
      class="grid shrink-0 grid-cols-1 gap-5 md:flex md:items-center md:justify-between"
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

    <div class="mt-6 flex shrink-0 flex-wrap items-center gap-4">
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

    <!-- The card is a flex column that may SHRINK (min-h-0, no grow): with
         more rows than fit, it takes the remaining height and the table
         scrolls inside it; with fewer, it stays as tall as its rows. The
         constraint has to reach the scroll container through
         UiTanStackTable's own markup — a fragment of two siblings, the
         table wrapper (first child) and the pager (last child) — so those
         are addressed from here with child selectors, and the table's
         container (data-slot=table-container) gets the overflow. Header
         cells stick to the container's top; sticky goes on the <th>s, not
         the <thead>, because under collapsed table borders a sticky thead
         loses its bottom border, so the line is an inset shadow per cell —
         and the header row's own border-b is switched off, or the two
         stack into a 2px line at rest.
         No minimum height anywhere: a floor on the container padded a
         one-row list up to the floor and pushed the pager off the rows,
         which is exactly what this layout is meant to avoid. All styled
         from the page: Ui/TanStackTable.vue stays the stock upstream
         file. overflow-hidden clips the square sticky header cells to the
         card's rounded corners — without it their bg-card paints over the
         border's curve at the top corners. -->
    <div
      class="mt-4 flex min-h-0 flex-col overflow-hidden rounded-md border bg-card [&>div:first-child]:flex [&>div:first-child]:min-h-0 [&>div:first-child]:flex-col [&>div:last-child]:shrink-0 **:data-[slot=table-container]:min-h-0 **:data-[slot=table-container]:overflow-y-auto **:data-[slot=table-head]:sticky **:data-[slot=table-head]:top-0 **:data-[slot=table-head]:z-10 **:data-[slot=table-head]:bg-card **:data-[slot=table-head]:shadow-[inset_0_-1px_0_var(--border)] [&_thead_tr]:border-b-0"
    >
      <UiTanStackTable
        :data="visibleClients"
        :columns="clientColumns"
        :show-selected-count="false"
        :show-rows-per-page="false"
      >
        <template #name-cell="{ row }">
          <NuxtLink :to="`/clients/${row.original.id}`" class="hover:underline">
            <p
              class="font-medium"
              :class="
                !row.original.active && 'text-muted-foreground line-through'
              "
            >
              {{ row.original.last_name }}, {{ row.original.first_name }}
            </p>
          </NuxtLink>
          <p
            v-if="row.original.flags?.requires_card_on_file"
            class="text-muted-foreground text-xs"
          >
            Card on file required
          </p>
        </template>

        <template #contact-cell="{ row }">
          <p v-if="row.original.email" class="text-muted-foreground text-sm">
            {{ row.original.email }}
          </p>
          <p v-if="row.original.phone" class="text-muted-foreground text-xs">
            {{ row.original.phone }}
          </p>
        </template>

        <template #noShows-cell="{ row }">
          <UiBadge
            variant="outline"
            class="min-w-9 justify-center rounded-full tabular-nums"
            :class="
              row.original.no_show_count > 0
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-400'
                : ''
            "
          >
            {{ row.original.no_show_count }}
          </UiBadge>
        </template>

        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UiTooltip>
              <UiTooltipTrigger as-child>
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  :aria-label="`View ${row.original.first_name} ${row.original.last_name}`"
                  :to="`/clients/${row.original.id}`"
                >
                  <Icon name="lucide:eye" class="size-4" />
                </UiButton>
              </UiTooltipTrigger>
              <UiTooltipContent>View client</UiTooltipContent>
            </UiTooltip>

            <UiTooltip v-if="can('clients.edit')">
              <UiTooltipTrigger as-child>
                <UiButton
                  variant="ghost"
                  size="icon-sm"
                  class="text-muted-foreground"
                  :aria-label="`Edit ${row.original.first_name} ${row.original.last_name}`"
                  @click="openEdit(row.original)"
                >
                  <Icon name="lucide:pencil" class="size-4" />
                </UiButton>
              </UiTooltipTrigger>
              <UiTooltipContent>Edit client</UiTooltipContent>
            </UiTooltip>
          </div>
        </template>
      </UiTanStackTable>
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
                    class="mt-1.5"
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
          <UiSheetFooter class="flex-row justify-end gap-2 border-t p-4">
            <UiButton
              variant="outline"
              type="button"
              class="mt-2 sm:mt-0"
              @click="sheetOpen = false"
            >
              Cancel
            </UiButton>
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
