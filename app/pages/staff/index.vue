<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

definePageMeta({ middleware: "can", permission: "staff.view" });
useSeoMeta({ title: "Staff — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// Staff directory
// ---------------------------------------------------------------------------
interface StaffRow {
  id: string;
  display_name: string;
  email: string;
  title: string | null;
  bookable: boolean;
  active: boolean;
  staff_roles: { roles: { id: string; name: string } | null }[];
}

const showInactive = ref(false);

const {
  data: staff,
  refresh: refreshStaff,
  pending: staffLoading,
} = await useAsyncData("staff-directory", async () => {
  const { data, error } = await supabase
    .from("staff")
    .select(
      "id, display_name, email, title, bookable, active, staff_roles(roles(id, name))",
    )
    .order("display_name");
  if (error) throw error;
  return (data ?? []) as unknown as StaffRow[];
});

const visibleStaff = computed(() =>
  (staff.value ?? []).filter((s) => showInactive.value || s.active),
);

function roleNames(member: StaffRow): string[] {
  return member.staff_roles
    .map((sr) => sr.roles?.name)
    .filter((n): n is string => !!n);
}

const roleLabels: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  front_desk: "Front Desk",
  provider: "Provider",
};

async function deactivate(member: StaffRow) {
  if (
    !confirm(
      `Deactivate ${member.display_name}? They will no longer be able to log in.`,
    )
  ) {
    return;
  }
  const { error } = await supabase
    .from("staff")
    .update({ active: false })
    .eq("id", member.id);

  if (error) {
    // The database refuses to deactivate the last active super admin
    const friendly = error.message.includes("last active super admin")
      ? "You can't deactivate the last active super admin."
      : error.message;
    toast.error("Could not deactivate", friendly);
    return;
  }
  toast.success("Staff member deactivated", member.display_name);
  await refreshStaff();
}

// ---------------------------------------------------------------------------
// Roles (for the invite form's role picker) — data-driven, never hardcoded
// ---------------------------------------------------------------------------
const { data: roles } = await useAsyncData("org-roles", async () => {
  if (!can("staff.invite")) return [];
  const { data, error } = await supabase
    .from("roles")
    .select("id, name")
    .order("name");
  if (error) throw error;
  return data ?? [];
});

// ---------------------------------------------------------------------------
// Invite form
// ---------------------------------------------------------------------------
const InviteSchema = z.object({
  email: z.email("Enter a valid email"),
  title: z.string().optional(),
});

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: toTypedSchema(InviteSchema),
});

const selectedRoles = ref<string[]>([]);
const roleError = ref("");
const lastInviteUrl = ref(""); // dev convenience until email delivery exists

const sendInvite = handleSubmit(async (values) => {
  roleError.value = "";
  if (selectedRoles.value.length === 0) {
    roleError.value = "Select at least one role.";
    return;
  }
  try {
    const result = await $fetch<{ inviteUrl?: string; email: string }>(
      "/api/invites",
      {
        method: "POST",
        body: {
          email: values.email,
          title: values.title || undefined,
          roleNames: selectedRoles.value,
        },
      },
    );
    toast.success("Invite created", `Invitation for ${result.email} is ready.`);
    lastInviteUrl.value = result.inviteUrl ?? "";
    resetForm();
    selectedRoles.value = [];
    await refreshInvites();
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not create invite",
      err.data?.statusMessage ?? "Something went wrong.",
    );
  }
});

async function copyInviteUrl() {
  await navigator.clipboard.writeText(lastInviteUrl.value);
  toast.info("Copied", "Invite link copied to clipboard.");
}

// ---------------------------------------------------------------------------
// Pending invites
// ---------------------------------------------------------------------------
interface InviteRow {
  id: string;
  email: string;
  title: string | null;
  expires_at: string;
  created_at: string;
}

const { data: invites, refresh: refreshInvites } = await useAsyncData(
  "pending-invites",
  async () => {
    if (!can("staff.invite")) return [];
    const { data, error } = await supabase
      .from("staff_invites")
      .select("id, email, title, expires_at, created_at")
      .is("accepted_at", null)
      .is("revoked_at", null)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as InviteRow[];
  },
);

function isExpired(invite: InviteRow) {
  return new Date(invite.expires_at) < new Date();
}

function expiryLabel(invite: InviteRow) {
  const ms = new Date(invite.expires_at).getTime() - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.ceil(ms / 86_400_000);
  return days === 1 ? "Expires in 1 day" : `Expires in ${days} days`;
}

async function revoke(invite: InviteRow) {
  if (!confirm(`Revoke the invite for ${invite.email}?`)) return;
  try {
    await $fetch(`/api/invites/${invite.id}/revoke`, { method: "PATCH" });
    toast.success("Invite revoked", invite.email);
    await refreshInvites();
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not revoke",
      err.data?.statusMessage ?? "Something went wrong.",
    );
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl p-6 md:p-10">
    <div
      class="grid grid-cols-1 gap-5 md:flex md:items-center md:justify-between"
    >
      <div class="flex flex-col">
        <h1 class="text-2xl font-semibold text-[#3b2f1e]">Staff</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Your team, their roles, and pending invitations.
        </p>
      </div>
      <label
        class="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
      >
        <input
          v-model="showInactive"
          type="checkbox"
          class="size-4 accent-[#3b2f1e]"
        />
        Show inactive
      </label>
    </div>

    <!-- Invite form -->
    <section
      v-if="can('staff.invite')"
      class="mt-8 rounded-xl border border-[#d9cdb4] bg-background p-6"
    >
      <h2 class="font-medium text-foreground">Invite an employee</h2>
      <form class="mt-4" @submit="sendInvite">
        <fieldset :disabled="isSubmitting" class="grid gap-4 sm:grid-cols-2">
          <UiVeeInput
            label="Email"
            type="email"
            name="email"
            placeholder="name@thereserve.com"
          />
          <UiVeeInput
            label="Title (optional)"
            type="text"
            name="title"
            placeholder="Massage Therapist"
          />

          <div class="sm:col-span-2">
            <p class="text-sm font-medium">Roles</p>
            <div class="mt-2 flex flex-wrap gap-4">
              <label
                v-for="role in roles"
                :key="role.id"
                class="flex cursor-pointer items-center gap-2 text-sm"
              >
                <input
                  v-model="selectedRoles"
                  type="checkbox"
                  :value="role.name"
                  class="size-4 accent-[#3b2f1e]"
                />
                {{ roleLabels[role.name] ?? role.name }}
              </label>
            </div>
            <p v-if="roleError" class="mt-1 text-sm text-red-600" role="alert">
              {{ roleError }}
            </p>
          </div>

          <div class="sm:col-span-2">
            <UiButton
              type="submit"
              :text="isSubmitting ? 'Sending…' : 'Send invite'"
            />
          </div>
        </fieldset>
      </form>

      <!-- Dev convenience: until email delivery is wired, surface the link -->
      <div
        v-if="lastInviteUrl"
        class="mt-4 flex items-center gap-3 rounded-lg bg-[#f5efe1] px-4 py-3"
      >
        <p class="min-w-0 flex-1 truncate text-xs text-[#4a3d2a]">
          {{ lastInviteUrl }}
        </p>
        <UiButton
          variant="outline"
          size="sm"
          text="Copy link"
          @click="copyInviteUrl"
        />
      </div>
    </section>

    <!-- Pending invites -->
    <section v-if="can('staff.invite') && invites?.length" class="mt-8">
      <h2 class="font-medium text-foreground">Pending invites</h2>
      <ul
        class="mt-3 divide-y divide-[#eee5d2] rounded-xl border border-[#d9cdb4] bg-background"
      >
        <li
          v-for="invite in invites"
          :key="invite.id"
          class="flex items-center justify-between gap-4 px-5 py-3"
        >
          <div class="min-w-0">
            <p class="truncate text-sm font-medium">{{ invite.email }}</p>
            <p
              class="text-xs"
              :class="
                isExpired(invite) ? 'text-red-600' : 'text-muted-foreground'
              "
            >
              {{ expiryLabel(invite) }}
            </p>
          </div>
          <UiButton
            variant="outline"
            size="sm"
            text="Revoke"
            @click="revoke(invite)"
          />
        </li>
      </ul>
    </section>

    <!-- Directory -->
    <section class="mt-8">
      <h2 class="font-medium text-foreground">Directory</h2>

      <div
        class="mt-3 rounded-xl border border-[#d9cdb4] bg-background px-5 [&>div]:max-h-[500px]"
      >
        <UiTable>
          <UiTableHeader
            class="bg-background/90 sticky top-0 z-10 backdrop-blur-sm"
          >
            <UiTableRow>
              <UiTableHead class="text-foreground pl-0 font-semibold"
                >Name</UiTableHead
              >
              <UiTableHead class="text-foreground pl-0 font-semibold"
                >Roles</UiTableHead
              >
              <UiTableHead
                class="text-foreground hidden pl-0 font-semibold lg:table-cell"
              >
                Title
              </UiTableHead>
              <UiTableHead class="text-foreground pl-0 font-semibold"
                >Status</UiTableHead
              >
              <UiTableHead v-if="can('staff.deactivate')" class="pl-0">
                <span class="sr-only">Actions</span>
              </UiTableHead>
            </UiTableRow>
          </UiTableHeader>
          <UiTableBody>
            <UiTableRow v-if="staffLoading">
              <UiTableCell
                colspan="5"
                class="text-muted-foreground py-6 text-center"
              >
                Loading…
              </UiTableCell>
            </UiTableRow>
            <template v-for="member in visibleStaff" :key="member.id">
              <UiTableRow>
                <UiTableCell class="pl-0">
                  <div class="flex flex-col">
                    <NuxtLink
                      :to="`/staff/${member.id}`"
                      class="font-medium hover:underline"
                    >
                      {{ member.display_name }}
                    </NuxtLink>
                    <p class="text-muted-foreground text-xs">
                      {{ member.email }}
                    </p>
                    <p class="text-muted-foreground text-xs lg:hidden">
                      {{ member.title ?? "" }}
                    </p>
                  </div>
                </UiTableCell>
                <UiTableCell class="pl-0">
                  <span
                    v-for="name in roleNames(member)"
                    :key="name"
                    class="mr-1 inline-block rounded-full bg-[#f0e9d8] px-2.5 py-0.5 text-xs text-[#4a3d2a]"
                  >
                    {{ roleLabels[name] ?? name }}
                  </span>
                </UiTableCell>
                <UiTableCell
                  class="text-muted-foreground hidden pl-0 lg:table-cell"
                >
                  {{ member.title ?? "—" }}
                </UiTableCell>
                <UiTableCell class="pl-0">
                  <span
                    class="inline-block rounded-full px-2.5 py-0.5 text-xs"
                    :class="
                      member.active
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-gray-100 text-gray-500'
                    "
                  >
                    {{ member.active ? "Active" : "Inactive" }}
                  </span>
                </UiTableCell>
                <UiTableCell
                  v-if="can('staff.deactivate')"
                  class="pl-0 text-right"
                >
                  <UiButton
                    v-if="member.active"
                    size="sm"
                    text="Deactivate"
                    @click="deactivate(member)"
                  />
                </UiTableCell>
              </UiTableRow>
            </template>
          </UiTableBody>
        </UiTable>
      </div>
    </section>
  </div>
</template>
