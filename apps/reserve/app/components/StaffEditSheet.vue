<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

/**
 * StaffEditSheet — admin editing of a staff member.
 * Gated by the caller (render only for staff.edit holders); role management
 * inside additionally gates on roles.manage. The last-super-admin database
 * trigger is the final guard against removing the last super_admin role.
 */
const props = defineProps<{
  staffId: string;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ saved: [] }>();

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

const title = ref("");

// ---------------------------------------------------------------------------
// Load the staff member + roles when the sheet opens
// ---------------------------------------------------------------------------
interface StaffRecord {
  id: string;
  display_name: string;
  title: string | null;
  email: string;
  bookable: boolean;
  phone: string | null;
  pronouns: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
}
interface Role {
  id: string;
  name: string;
  description: string | null;
}

const record = ref<StaffRecord | null>(null);
const allRoles = ref<Role[]>([]);
const currentRoleIds = ref<Set<string>>(new Set());
const checkedRoles = useToggleSet();
const bookable = ref(false);

const StaffSchema = z.object({
  displayName: z.string().min(1, "Name is required"),
  title: z.string().optional(),
  phone: z.string().optional(),
  pronouns: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
});

const { handleSubmit, isSubmitting, setValues } = useForm({
  validationSchema: toTypedSchema(StaffSchema),
});

watch(open, async (isOpen) => {
  if (!isOpen) return;
  const { data, error } = await supabase
    .from("staff")
    .select(
      "id, display_name, title, email, bookable, phone, pronouns, address_line1, address_line2, city, state, postal_code, emergency_contact_name, emergency_contact_phone",
    )
    .eq("id", props.staffId)
    .single();
  if (error) {
    toast.error("Could not load staff member", error.message);
    open.value = false;
    return;
  }
  record.value = data as StaffRecord;
  bookable.value = data.bookable;
  title.value = data.title ?? "";
  setValues({
    displayName: data.display_name,
    title: data.title ?? "",
    phone: data.phone ?? "",
    pronouns: data.pronouns ?? "",
    addressLine1: data.address_line1 ?? "",
    addressLine2: data.address_line2 ?? "",
    city: data.city ?? "",
    state: data.state ?? "",
    postalCode: data.postal_code ?? "",
    emergencyName: data.emergency_contact_name ?? "",
    emergencyPhone: data.emergency_contact_phone ?? "",
  });

  if (can("roles.manage")) {
    const [{ data: roles }, { data: assigned }] = await Promise.all([
      supabase.from("roles").select("id, name").order("name"),
      supabase
        .from("staff_roles")
        .select("role_id")
        .eq("staff_id", props.staffId),
    ]);
    allRoles.value = (roles ?? []) as Role[];
    currentRoleIds.value = new Set((assigned ?? []).map((r) => r.role_id));
    checkedRoles.set.value = new Set(currentRoleIds.value);
  }
});

// ---------------------------------------------------------------------------
// Save: profile update + role adds/removes
// ---------------------------------------------------------------------------
const save = handleSubmit(async (values) => {
  if (!record.value) return;

  const { error: profileError } = await supabase
    .from("staff")
    .update({
      display_name: values.displayName,
      title: title.value || null,
      bookable: bookable.value,
      phone: values.phone || null,
      pronouns: values.pronouns || null,
      address_line1: values.addressLine1 || null,
      address_line2: values.addressLine2 || null,
      city: values.city || null,
      state: values.state || null,
      postal_code: values.postalCode || null,
      emergency_contact_name: values.emergencyName || null,
      emergency_contact_phone: values.emergencyPhone || null,
    })
    .eq("id", record.value.id);
  if (profileError) {
    return toast.error("Could not save", profileError.message);
  }

  // Role changes (only when the section was shown and something changed)
  if (can("roles.manage")) {
    const toAdd = [...checkedRoles.set.value].filter(
      (id) => !currentRoleIds.value.has(id),
    );
    const toRemove = [...currentRoleIds.value].filter(
      (id) => !checkedRoles.has(id),
    );

    if (checkedRoles.set.value.size === 0) {
      return toast.error(
        "Roles required",
        "A staff member needs at least one role.",
      );
    }

    if (toAdd.length) {
      const { error } = await supabase.from("staff_roles").insert(
        toAdd.map((roleId) => ({
          staff_id: record.value!.id,
          role_id: roleId,
        })),
      );
      if (error) return toast.error("Could not add role", error.message);
    }
    for (const roleId of toRemove) {
      const { error } = await supabase
        .from("staff_roles")
        .delete()
        .eq("staff_id", record.value.id)
        .eq("role_id", roleId);
      if (error) {
        // The last-super-admin trigger raises here if this would orphan the org
        return toast.error("Could not remove role", error.message);
      }
    }
  }

  toast.success("Staff member updated", values.displayName);
  open.value = false;
  emit("saved");
});

const { data: existingTitles } = await useAsyncData(
  "staff-titles",
  async () => {
    const { data } = await supabase
      .from("staff")
      .select("title")
      .not("title", "is", null);
    return [...new Set((data ?? []).map((s) => s.title as string))].sort();
  },
);
</script>

<template>
  <UiSheet v-model:open="open">
    <UiSheetContent
      side="right"
      class="sm:max-w-none md:w-[90vw] lg:w-[720px]"
      :title="record ? `Edit ${record.display_name}` : 'Edit staff member'"
      description="Employment details, personal info, and roles."
    >
      <template #content>
        <form
          v-if="record"
          id="staff-edit-form"
          class="min-h-0 flex-1 overflow-y-auto"
          @submit="save"
        >
          <fieldset :disabled="isSubmitting" class="grid gap-5 p-4">
            <!-- Employment -->
            <div class="grid gap-4 sm:grid-cols-2">
              <UiVeeInput label="Display name" name="displayName" />
              <UiVeeInput
                v-model="title"
                label="Title"
                name="title"
                placeholder="Massage Therapist"
              />
              <datalist id="title-suggestions">
                <option v-for="t in existingTitles" :key="t" :value="t" />
              </datalist>
            </div>
            <p class="text-muted-foreground -mt-2 text-xs">
              Signed in as {{ record.email }} — email is the login identity and
              can't be changed here.
            </p>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <input
                v-model="bookable"
                type="checkbox"
                class="size-4 accent-primary"
              />
              Bookable — appears as a provider in scheduling
            </label>

            <!-- Roles -->
            <div
              v-if="can('roles.manage') && allRoles.length"
              class="rounded-xl border p-4"
            >
              <p class="text-sm font-medium">Roles</p>
              <p class="text-muted-foreground mt-1 text-xs">
                Roles decide what this person can see and do, everywhere,
                immediately.
              </p>
              <div class="mt-3 grid gap-2">
                <label
                  v-for="role in allRoles"
                  :key="role.id"
                  class="flex cursor-pointer items-start gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    class="mt-0.5 size-4 accent-primary"
                    :checked="checkedRoles.has(role.id)"
                    @change="checkedRoles.toggle(role.id)"
                  />
                  <span>
                    <span class="font-medium capitalize">{{
                      role.name.replace("_", " ")
                    }}</span>
                    <span v-if="role.description" class="text-muted-foreground">
                      — {{ role.description }}
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <!-- Personal -->
            <div class="grid gap-4 sm:grid-cols-2">
              <UiVeeInput label="Phone" name="phone" type="tel" />
              <UiVeeInput
                label="Pronouns"
                name="pronouns"
                placeholder="she/her (optional)"
              />
            </div>
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
          </fieldset>
        </form>
      </template>

      <template #footer>
        <UiSheetFooter class="flex-row justify-end gap-2 border-t p-4">
          <UiButton variant="outline" type="button" @click="open = false">
            Cancel
          </UiButton>
          <UiButton
            type="submit"
            form="staff-edit-form"
            :text="isSubmitting ? 'Saving…' : 'Save'"
          />
        </UiSheetFooter>
      </template>
    </UiSheetContent>
  </UiSheet>
</template>
