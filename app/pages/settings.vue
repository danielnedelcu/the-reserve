<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

// No permission gate: settings is always about YOUR OWN row.
useSeoMeta({ title: "Settings — The Reserve" });

const supabase = useSupabaseClient();
const user = useSupabaseUser();
const toast = useToast();
const colorMode = useColorMode();

// ---------------------------------------------------------------------------
// My staff row
// ---------------------------------------------------------------------------
const { data: me, refresh: refreshMe } = await useAsyncData(
  "settings-me",
  async () => {
    const { data: myId } = await supabase.rpc("current_staff_id");
    if (!myId) return null;
    const { data, error } = await supabase
      .from("staff")
      .select(
        "id, display_name, email, title, pronouns, phone, avatar_url, address_line1, address_line2, city, state, postal_code, emergency_contact_name, emergency_contact_phone",
      )
      .eq("id", myId)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
);

// ---------------------------------------------------------------------------
// Profile form
// ---------------------------------------------------------------------------
const ProfileSchema = z.object({
  displayName: z.string().min(1, "Display name is required"),
  pronouns: z.string().optional(),
  phone: z.string().optional(),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  emergencyName: z.string().optional(),
  emergencyPhone: z.string().optional(),
});

const { handleSubmit, isSubmitting, setValues } = useForm({
  validationSchema: toTypedSchema(ProfileSchema),
});

watch(
  me,
  (value) => {
    if (!value) return;
    setValues({
      displayName: value.display_name ?? "",
      pronouns: value.pronouns ?? "",
      phone: value.phone ?? "",
      addressLine1: value.address_line1 ?? "",
      addressLine2: value.address_line2 ?? "",
      city: value.city ?? "",
      state: value.state ?? "",
      postalCode: value.postal_code ?? "",
      emergencyName: value.emergency_contact_name ?? "",
      emergencyPhone: value.emergency_contact_phone ?? "",
    });
  },
  { immediate: true },
);

const saveProfile = handleSubmit(async (values) => {
  if (!me.value) return;
  const { error } = await supabase
    .from("staff")
    .update({
      display_name: values.displayName,
      pronouns: values.pronouns || null,
      phone: values.phone || null,
      address_line1: values.addressLine1 || null,
      address_line2: values.addressLine2 || null,
      city: values.city || null,
      state: values.state || null,
      postal_code: values.postalCode || null,
      emergency_contact_name: values.emergencyName || null,
      emergency_contact_phone: values.emergencyPhone || null,
    })
    .eq("id", me.value.id);
  if (error) return toast.error("Could not save profile", error.message);
  toast.success("Profile saved");
  await refreshMe();
});

// ---------------------------------------------------------------------------
// Avatar upload (Supabase Storage, path keyed by auth uid)
// ---------------------------------------------------------------------------
const uploadingAvatar = ref(false);
const avatarInput = ref<HTMLInputElement | null>(null);

async function onAvatarPicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !me.value || !user.value) return;

  if (!file.type.startsWith("image/")) {
    return toast.error("Not an image", "Please choose a PNG or JPG.");
  }
  if (file.size > 2 * 1024 * 1024) {
    return toast.error("Too large", "Please choose an image under 2 MB.");
  }

  uploadingAvatar.value = true;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "png";
  const path = `${user.value.id}/avatar.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("avatars")
    .upload(path, file, { upsert: true, cacheControl: "3600" });

  if (uploadError) {
    uploadingAvatar.value = false;
    return toast.error("Upload failed", uploadError.message);
  }

  const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(path);
  // Cache-bust so the new image shows immediately everywhere
  const url = `${urlData.publicUrl}?v=${Date.now()}`;

  const { error: saveError } = await supabase
    .from("staff")
    .update({ avatar_url: url })
    .eq("id", me.value.id);

  uploadingAvatar.value = false;
  if (saveError) return toast.error("Could not save avatar", saveError.message);
  toast.success("Avatar updated");
  await refreshMe();
}

const initials = computed(() =>
  (me.value?.display_name ?? user.value?.email ?? "?")
    .split(" ")
    .map((part) => part.charAt(0))
    .slice(0, 2)
    .join("")
    .toUpperCase(),
);

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------
const MODES = [
  { value: "light", label: "Light", icon: "lucide:sun" },
  { value: "dark", label: "Dark", icon: "lucide:moon" },
  { value: "system", label: "System", icon: "lucide:monitor" },
];

// ---------------------------------------------------------------------------
// Security: change password
// ---------------------------------------------------------------------------
const newPassword = ref("");
const confirmPassword = ref("");
const changingPassword = ref(false);

async function changePassword() {
  if (newPassword.value.length < 8) {
    return toast.error("Too short", "Password must be at least 8 characters.");
  }
  if (newPassword.value !== confirmPassword.value) {
    return toast.error("Passwords don't match");
  }
  changingPassword.value = true;
  const { error } = await supabase.auth.updateUser({
    password: newPassword.value,
  });
  changingPassword.value = false;
  if (error) return toast.error("Could not change password", error.message);
  toast.success("Password changed");
  newPassword.value = "";
  confirmPassword.value = "";
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <h1 class="text-2xl font-semibold">Settings</h1>
    <p class="text-muted-foreground mt-1 text-sm">
      Your personal details and preferences.
    </p>

    <div v-if="!me" class="text-muted-foreground mt-10 text-sm">
      Couldn't load your profile.
    </div>

    <template v-else>
      <!-- Avatar -->
      <section
        class="mt-8 flex items-center gap-5 rounded-md border bg-card p-5"
      >
        <UiAvatar class="size-16 rounded-md">
          <UiAvatarImage
            v-if="me.avatar_url"
            :src="me.avatar_url"
            alt="Your avatar"
          />
          <UiAvatarFallback
            class="rounded-md bg-[#f0e9d8] text-lg text-[#4a3d2a]"
          >
            {{ initials }}
          </UiAvatarFallback>
        </UiAvatar>
        <div>
          <p class="text-sm font-medium">Profile photo</p>
          <p class="text-muted-foreground text-xs">
            Shown in the sidebar, staff directory, and schedule. PNG or JPG, up
            to 2 MB.
          </p>
          <UiButton
            size="sm"
            variant="outline"
            class="mt-2"
            :disabled="uploadingAvatar"
            :text="uploadingAvatar ? 'Uploading…' : 'Upload photo'"
            @click="avatarInput?.click()"
          />
          <input
            ref="avatarInput"
            type="file"
            accept="image/*"
            class="hidden"
            @change="onAvatarPicked"
          />
        </div>
      </section>

      <!-- Profile -->
      <section class="mt-6 rounded-md border bg-card p-5">
        <h2 class="font-medium">Profile</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          Signed in as {{ me.email }} · {{ me.title ?? "No title" }} — email,
          title, and role are managed by an administrator.
        </p>
        <form class="mt-4" @submit="saveProfile">
          <fieldset :disabled="isSubmitting" class="grid gap-4">
            <div class="grid gap-4 sm:grid-cols-2">
              <UiVeeInput label="Display name" name="displayName" />
              <UiVeeInput
                label="Pronouns"
                name="pronouns"
                placeholder="she/her (optional)"
              />
            </div>
            <UiVeeInput label="Phone" name="phone" type="tel" />
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
            <div>
              <UiButton
                type="submit"
                size="sm"
                :text="isSubmitting ? 'Saving…' : 'Save profile'"
              />
            </div>
          </fieldset>
        </form>
      </section>

      <!-- Appearance -->
      <section class="mt-6 rounded-md border bg-card p-5">
        <h2 class="font-medium">Appearance</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          Theme preference for this browser.
        </p>
        <div class="mt-3 flex gap-2">
          <UiButton
            v-for="mode in MODES"
            :key="mode.value"
            size="sm"
            :variant="
              colorMode.preference === mode.value ? 'default' : 'outline'
            "
            @click="colorMode.preference = mode.value"
          >
            <Icon :name="mode.icon" class="size-4" />
            {{ mode.label }}
          </UiButton>
        </div>
      </section>

      <!-- Security -->
      <section class="mt-6 rounded-md border bg-card p-5">
        <h2 class="font-medium">Security</h2>
        <div class="mt-3 grid gap-4 sm:max-w-sm">
          <div>
            <label class="text-sm font-medium" for="new-password"
              >New password</label
            >
            <UiInput
              id="new-password"
              v-model="newPassword"
              type="password"
              autocomplete="new-password"
              class="mt-1.5"
            />
          </div>
          <div>
            <label class="text-sm font-medium" for="confirm-password"
              >Confirm password</label
            >
            <UiInput
              id="confirm-password"
              v-model="confirmPassword"
              type="password"
              autocomplete="new-password"
              class="mt-1.5"
            />
          </div>
          <div>
            <UiButton
              size="sm"
              variant="outline"
              :disabled="changingPassword || !newPassword"
              :text="changingPassword ? 'Changing…' : 'Change password'"
              @click="changePassword"
            />
          </div>
        </div>
      </section>

      <!-- Notifications (stub — grows with the notification kinds) -->
      <section class="mt-6 rounded-md border bg-card p-5">
        <h2 class="font-medium">Notifications</h2>
        <p class="text-muted-foreground mt-1 text-xs">
          In-app notifications are on for time-off decisions and requests.
          Per-type preferences are coming as more notification kinds are added.
        </p>
      </section>
    </template>
  </div>
</template>
