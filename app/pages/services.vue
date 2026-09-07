<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

definePageMeta({ middleware: "can", permission: "services.view" });
useSeoMeta({ title: "Services — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// Types & helpers
// ---------------------------------------------------------------------------
interface ServiceRow {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_min: number;
  buffer_after_min: number;
  price_cents: number;
  requires_intake: boolean;
  active: boolean;
  service_resource_requirements: { resource_type_id: string }[];
  service_staff: { staff_id: string }[];
}

interface Category {
  id: string;
  name: string;
  sort_order: number;
}

const dollars = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );

const blockedMinutes = (s: ServiceRow) =>
  s.buffer_before_min + s.duration_minutes + s.buffer_after_min;

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const { data: categories } = await useAsyncData(
  "service-categories",
  async () => {
    const { data, error } = await supabase
      .from("service_categories")
      .select("id, name, sort_order")
      .order("sort_order");
    if (error) throw error;
    return (data ?? []) as Category[];
  },
);

const { data: services, refresh: refreshServices } = await useAsyncData(
  "services-catalog",
  async () => {
    const { data, error } = await supabase
      .from("services")
      .select(
        "id, category_id, name, description, duration_minutes, buffer_before_min, buffer_after_min, price_cents, requires_intake, active, service_resource_requirements(resource_type_id), service_staff(staff_id)",
      )
      .order("name");
    if (error) throw error;
    return (data ?? []) as unknown as ServiceRow[];
  },
);

const { data: resourceTypes } = await useAsyncData(
  "resource-types",
  async () => {
    const { data, error } = await supabase
      .from("resource_types")
      .select("id, name")
      .order("name");
    if (error) throw error;
    return data ?? [];
  },
);

// Bookable, active staff for the qualifications picker (managers only need this)
const { data: bookableStaff } = await useAsyncData(
  "bookable-staff",
  async () => {
    if (!can("services.manage")) return [];
    const { data, error } = await supabase
      .from("staff")
      .select("id, display_name")
      .eq("active", true)
      .eq("bookable", true)
      .order("display_name");
    if (error) throw error;
    return data ?? [];
  },
);

const showInactive = ref(false);

const grouped = computed(() =>
  (categories.value ?? [])
    .map((cat) => ({
      ...cat,
      services: (services.value ?? []).filter(
        (s) => s.category_id === cat.id && (showInactive.value || s.active),
      ),
    }))
    .filter((g) => g.services.length > 0),
);

const resourceTypeName = (id: string) =>
  resourceTypes.value?.find((rt) => rt.id === id)?.name ?? "?";

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------
const dialogOpen = ref(false);
const editingId = ref<string | null>(null);
const dialogTitle = computed(() =>
  editingId.value ? "Edit service" : "New service",
);

const ServiceSchema = z.object({
  name: z.string().min(2, "Name is required"),
  priceDollars: z.coerce.number().min(0, "Price can't be negative"),
  durationMinutes: z.coerce.number().int().min(5, "At least 5 minutes"),
  bufferBefore: z.coerce.number().int().min(0),
  bufferAfter: z.coerce.number().int().min(0),
});

const { handleSubmit, isSubmitting, resetForm, setValues } = useForm({
  validationSchema: toTypedSchema(ServiceSchema),
});

// Non-vee fields (same pattern as the invite form's role checkboxes)
const description = ref("");
const categoryId = ref<string>("");
const requiresIntake = ref(false);
const selectedRoomTypes = ref<string[]>([]);
const selectedStaff = ref<string[]>([]);
const roomTypeError = ref("");

function openCreate() {
  editingId.value = null;
  resetForm({
    values: {
      name: "",
      priceDollars: 0,
      durationMinutes: 60,
      bufferBefore: 0,
      bufferAfter: 10,
    },
  });
  description.value = "";
  categoryId.value = categories.value?.[0]?.id ?? "";
  requiresIntake.value = false;
  selectedRoomTypes.value = [];
  selectedStaff.value = [];
  roomTypeError.value = "";
  dialogOpen.value = true;
}

function openEdit(service: ServiceRow) {
  editingId.value = service.id;
  setValues({
    name: service.name,
    priceDollars: service.price_cents / 100,
    durationMinutes: service.duration_minutes,
    bufferBefore: service.buffer_before_min,
    bufferAfter: service.buffer_after_min,
  });
  description.value = service.description ?? "";
  categoryId.value = service.category_id ?? "";
  requiresIntake.value = service.requires_intake;
  selectedRoomTypes.value = service.service_resource_requirements.map(
    (r) => r.resource_type_id,
  );
  selectedStaff.value = service.service_staff.map((s) => s.staff_id);
  roomTypeError.value = "";
  dialogOpen.value = true;
}

const saveService = handleSubmit(async (values) => {
  roomTypeError.value = "";
  if (selectedRoomTypes.value.length === 0) {
    roomTypeError.value = "Select at least one room type.";
    return;
  }

  const payload = {
    name: values.name,
    description: description.value || null,
    category_id: categoryId.value || null,
    duration_minutes: values.durationMinutes,
    buffer_before_min: values.bufferBefore,
    buffer_after_min: values.bufferAfter,
    price_cents: Math.round(values.priceDollars * 100),
    requires_intake: requiresIntake.value,
  };

  let serviceId = editingId.value;

  if (serviceId) {
    const { error } = await supabase
      .from("services")
      .update(payload)
      .eq("id", serviceId);
    if (error) return toast.error("Could not save service", error.message);
  } else {
    const { data: orgId } = await supabase.rpc("current_org_id");
    if (!orgId) return toast.error("Session issue — please refresh");

    const { data, error } = await supabase
      .from("services")
      .insert({ ...payload, organization_id: orgId })
      .select("id")
      .single();
    if (error) return toast.error("Could not create service", error.message);
    serviceId = data.id;
  }

  // Sync room-type requirements and qualifications (delete + insert diff)
  await supabase
    .from("service_resource_requirements")
    .delete()
    .eq("service_id", serviceId);
  if (selectedRoomTypes.value.length) {
    const { error } = await supabase
      .from("service_resource_requirements")
      .insert(
        selectedRoomTypes.value.map((rt) => ({
          service_id: serviceId,
          resource_type_id: rt,
        })),
      );
    if (error)
      return toast.error("Could not save room requirements", error.message);
  }

  await supabase.from("service_staff").delete().eq("service_id", serviceId);
  if (selectedStaff.value.length) {
    const { error } = await supabase.from("service_staff").insert(
      selectedStaff.value.map((st) => ({
        service_id: serviceId,
        staff_id: st,
      })),
    );
    if (error)
      return toast.error("Could not save qualifications", error.message);
  }

  toast.success(
    editingId.value ? "Service updated" : "Service created",
    values.name,
  );
  dialogOpen.value = false;
  await refreshServices();
});

async function toggleActive(service: ServiceRow) {
  const { error } = await supabase
    .from("services")
    .update({ active: !service.active })
    .eq("id", service.id);
  if (error) return toast.error("Could not update service", error.message);
  toast.success(
    service.active ? "Service deactivated" : "Service activated",
    service.name,
  );
  await refreshServices();
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div
      class="grid grid-cols-1 gap-5 md:flex md:items-center md:justify-between"
    >
      <div class="flex flex-col">
        <h1 class="text-2xl font-semibold">Services</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          The treatment menu — durations, pricing, rooms, and who performs what.
        </p>
      </div>
      <div class="flex items-center gap-4">
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
        <UiButton v-if="can('services.manage')" size="sm" @click="openCreate">
          <Icon name="lucide:plus" class="size-4" />
          New service
        </UiButton>
      </div>
    </div>

    <!-- Category sections -->
    <section v-for="group in grouped" :key="group.id" class="mt-10">
      <h2 class="font-serif text-lg tracking-wide">{{ group.name }}</h2>

      <div class="mt-3 rounded-xl border bg-card px-5">
        <UiTable>
          <UiTableHeader>
            <UiTableRow>
              <UiTableHead class="text-foreground pl-0 font-semibold"
                >Service</UiTableHead
              >
              <UiTableHead
                class="text-foreground hidden pl-0 font-semibold sm:table-cell"
              >
                Time
              </UiTableHead>
              <UiTableHead class="text-foreground pl-0 font-semibold"
                >Price</UiTableHead
              >
              <UiTableHead
                class="text-foreground hidden pl-0 font-semibold lg:table-cell"
              >
                Rooms
              </UiTableHead>
              <UiTableHead v-if="can('services.manage')" class="pl-0">
                <span class="sr-only">Actions</span>
              </UiTableHead>
            </UiTableRow>
          </UiTableHeader>
          <UiTableBody>
            <UiTableRow v-for="service in group.services" :key="service.id">
              <UiTableCell class="pl-0">
                <div class="flex flex-col">
                  <p
                    class="font-medium"
                    :class="
                      !service.active && 'text-muted-foreground line-through'
                    "
                  >
                    {{ service.name }}
                  </p>
                  <p
                    v-if="service.description"
                    class="text-muted-foreground max-w-md truncate text-xs"
                  >
                    {{ service.description }}
                  </p>
                  <p
                    v-if="service.requires_intake"
                    class="text-muted-foreground mt-0.5 text-xs"
                  >
                    Requires intake form
                  </p>
                </div>
              </UiTableCell>
              <UiTableCell
                class="text-muted-foreground hidden pl-0 sm:table-cell"
              >
                {{ service.duration_minutes }} min
                <span class="text-xs"
                  >({{ blockedMinutes(service) }} min blocked)</span
                >
              </UiTableCell>
              <UiTableCell class="pl-0">{{
                dollars(service.price_cents)
              }}</UiTableCell>
              <UiTableCell
                class="text-muted-foreground hidden pl-0 lg:table-cell"
              >
                <span
                  v-for="req in service.service_resource_requirements"
                  :key="req.resource_type_id"
                  class="bg-secondary mr-1 inline-block rounded-full px-2.5 py-0.5 text-xs"
                >
                  {{ resourceTypeName(req.resource_type_id) }}
                </span>
              </UiTableCell>
              <UiTableCell
                v-if="can('services.manage')"
                class="pl-0 text-right"
              >
                <UiButton variant="ghost" size="sm" @click="openEdit(service)"
                  >Edit</UiButton
                >
                <UiButton
                  variant="ghost"
                  size="sm"
                  :class="service.active ? 'text-destructive' : ''"
                  @click="toggleActive(service)"
                >
                  {{ service.active ? "Deactivate" : "Activate" }}
                </UiButton>
              </UiTableCell>
            </UiTableRow>
          </UiTableBody>
        </UiTable>
      </div>
    </section>

    <p v-if="!grouped.length" class="text-muted-foreground mt-10 text-sm">
      No services yet{{
        can("services.manage") ? " — create the first one." : "."
      }}
    </p>

    <!-- Create / edit dialog -->
    <UiDialog v-model:open="dialogOpen">
      <UiDialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <UiDialogHeader>
          <UiDialogTitle>{{ dialogTitle }}</UiDialogTitle>
          <UiDialogDescription>
            Duration is client-facing; buffers extend the blocked time for prep
            and cleanup.
          </UiDialogDescription>
        </UiDialogHeader>

        <form @submit="saveService">
          <fieldset :disabled="isSubmitting" class="grid gap-4">
            <UiVeeInput
              label="Name"
              name="name"
              placeholder="Swedish Massage — 60 min"
            />

            <div>
              <label class="text-sm font-medium" for="svc-desc"
                >Description</label
              >
              <textarea
                id="svc-desc"
                v-model="description"
                rows="2"
                class="border-input mt-1.5 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label class="text-sm font-medium" for="svc-cat"
                  >Category</label
                >
                <UiSelect v-model="categoryId">
                  <UiSelectTrigger id="svc-cat" class="mt-1.5" />
                  <UiSelectContent>
                    <UiSelectItem
                      v-for="cat in categories"
                      :key="cat.id"
                      :value="cat.id"
                      :text="cat.name"
                    />
                  </UiSelectContent>
                </UiSelect>
              </div>
              <UiVeeInput
                label="Price ($)"
                name="priceDollars"
                type="number"
                step="0.01"
                min="0"
              />
            </div>

            <div class="grid gap-4 sm:grid-cols-3">
              <UiVeeInput
                label="Duration (min)"
                name="durationMinutes"
                type="number"
                min="5"
              />
              <UiVeeInput
                label="Buffer before"
                name="bufferBefore"
                type="number"
                min="0"
              />
              <UiVeeInput
                label="Buffer after"
                name="bufferAfter"
                type="number"
                min="0"
              />
            </div>

            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                v-model="requiresIntake"
                type="checkbox"
                class="size-4 accent-primary"
              />
              Requires a completed intake form before booking
            </label>

            <div>
              <p class="text-sm font-medium">Room type required</p>
              <div class="mt-2 flex flex-wrap gap-4">
                <label
                  v-for="rt in resourceTypes"
                  :key="rt.id"
                  class="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    v-model="selectedRoomTypes"
                    type="checkbox"
                    :value="rt.id"
                    class="size-4 accent-primary"
                  />
                  {{ rt.name }}
                </label>
              </div>
              <p
                v-if="roomTypeError"
                class="text-destructive mt-1 text-sm"
                role="alert"
              >
                {{ roomTypeError }}
              </p>
            </div>

            <div v-if="bookableStaff?.length">
              <p class="text-sm font-medium">Performed by</p>
              <p class="text-muted-foreground text-xs">
                Only qualified staff can be booked for this service.
              </p>
              <div class="mt-2 flex flex-wrap gap-4">
                <label
                  v-for="member in bookableStaff"
                  :key="member.id"
                  class="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    v-model="selectedStaff"
                    type="checkbox"
                    :value="member.id"
                    class="size-4 accent-primary"
                  />
                  {{ member.display_name }}
                </label>
              </div>
            </div>

            <UiDialogFooter>
              <UiButton
                type="button"
                variant="outline"
                @click="dialogOpen = false"
              >
                Cancel
              </UiButton>
              <UiButton
                type="submit"
                :text="isSubmitting ? 'Saving…' : 'Save service'"
              />
            </UiDialogFooter>
          </fieldset>
        </form>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
