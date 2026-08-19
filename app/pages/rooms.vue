<script setup lang="ts">
import { z } from "zod";
import { toTypedSchema } from "@vee-validate/zod";

definePageMeta({ middleware: "can", permission: "services.view" });
useSeoMeta({ title: "Rooms — The Reserve" });

const supabase = useSupabaseClient();
const { can } = usePermissions();
const toast = useToast();

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
interface RoomType {
  id: string;
  name: string;
}
interface Room {
  id: string;
  name: string;
  resource_type_id: string;
  active: boolean;
}

const { data: location } = await useAsyncData("rooms-location", async () => {
  const { data, error } = await supabase
    .from("locations")
    .select("id, name")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
});

const { data: roomTypes, refresh: refreshTypes } = await useAsyncData(
  "room-types",
  async () => {
    const { data, error } = await supabase
      .from("resource_types")
      .select("id, name")
      .order("name");
    if (error) throw error;
    return (data ?? []) as RoomType[];
  },
);

const { data: rooms, refresh: refreshRooms } = await useAsyncData(
  "rooms-list",
  async () => {
    const { data, error } = await supabase
      .from("resources")
      .select("id, name, resource_type_id, active")
      .order("name");
    if (error) throw error;
    return (data ?? []) as Room[];
  },
);

// How many services require each room type (context for admins)
const { data: requirementCounts } = await useAsyncData(
  "room-type-usage",
  async () => {
    const { data, error } = await supabase
      .from("service_resource_requirements")
      .select("resource_type_id");
    if (error) throw error;
    const counts: Record<string, number> = {};
    for (const row of data ?? []) {
      counts[row.resource_type_id] = (counts[row.resource_type_id] ?? 0) + 1;
    }
    return counts;
  },
);

const roomsByType = computed(() => {
  const map: Record<string, Room[]> = {};
  for (const room of rooms.value ?? []) {
    (map[room.resource_type_id] ??= []).push(room);
  }
  return map;
});

const manage = computed(() => can("services.manage"));

// ---------------------------------------------------------------------------
// Room create / edit dialog
// ---------------------------------------------------------------------------
const RoomSchema = z.object({
  name: z.string().min(1, "Room name is required"),
});

const { handleSubmit, isSubmitting, resetForm, setValues } = useForm({
  validationSchema: toTypedSchema(RoomSchema),
});

const dialogOpen = ref(false);
const editingId = ref<string | null>(null);
const roomTypeId = ref("");

function openCreate(typeId?: string) {
  editingId.value = null;
  resetForm({ values: { name: "" } });
  roomTypeId.value = typeId ?? roomTypes.value?.[0]?.id ?? "";
  dialogOpen.value = true;
}

function openEdit(room: Room) {
  editingId.value = room.id;
  setValues({ name: room.name });
  roomTypeId.value = room.resource_type_id;
  dialogOpen.value = true;
}

const saveRoom = handleSubmit(async (values) => {
  if (!roomTypeId.value) return toast.error("Pick a room type");
  if (!location.value) return toast.error("No location configured");

  if (editingId.value) {
    const { error } = await supabase
      .from("resources")
      .update({ name: values.name, resource_type_id: roomTypeId.value })
      .eq("id", editingId.value);
    if (error) return toast.error("Could not save room", error.message);
  } else {
    const { error } = await supabase.from("resources").insert({
      location_id: location.value.id,
      resource_type_id: roomTypeId.value,
      name: values.name,
    });
    if (error) {
      if (error.code === "23505") {
        return toast.error(
          "Duplicate name",
          "A room with this name already exists at this location.",
        );
      }
      return toast.error("Could not create room", error.message);
    }
  }

  toast.success(editingId.value ? "Room updated" : "Room added", values.name);
  dialogOpen.value = false;
  await refreshRooms();
});

async function toggleRoomActive(room: Room) {
  const { error } = await supabase
    .from("resources")
    .update({ active: !room.active })
    .eq("id", room.id);
  if (error) return toast.error("Could not update room", error.message);
  toast.success(room.active ? "Room deactivated" : "Room activated", room.name);
  await refreshRooms();
}

// ---------------------------------------------------------------------------
// Room types: add + rename inline
// ---------------------------------------------------------------------------
const newTypeName = ref("");
const savingType = ref(false);

async function addType() {
  const name = newTypeName.value.trim();
  if (!name) return;
  savingType.value = true;
  const { data: orgId } = await supabase.rpc("current_org_id");
  const { error } = await supabase
    .from("resource_types")
    .insert({ organization_id: orgId, name });
  savingType.value = false;
  if (error) {
    if (error.code === "23505") {
      return toast.error(
        "Duplicate type",
        "A room type with this name already exists.",
      );
    }
    return toast.error("Could not add room type", error.message);
  }
  toast.success("Room type added", name);
  newTypeName.value = "";
  await refreshTypes();
}

const renamingTypeId = ref<string | null>(null);
const renameValue = ref("");

function startRename(type: RoomType) {
  renamingTypeId.value = type.id;
  renameValue.value = type.name;
}

async function saveRename() {
  const name = renameValue.value.trim();
  if (!name || !renamingTypeId.value) return;
  const { error } = await supabase
    .from("resource_types")
    .update({ name })
    .eq("id", renamingTypeId.value);
  if (error) return toast.error("Could not rename", error.message);
  toast.success("Room type renamed", name);
  renamingTypeId.value = null;
  await refreshTypes();
}
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div
      class="grid grid-cols-1 gap-5 md:flex md:items-center md:justify-between"
    >
      <div>
        <h1 class="text-2xl font-semibold">Rooms</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Treatment rooms{{ location ? ` at ${location.name}` : "" }} — the
          scheduler assigns a free room of the service's required type at
          booking.
        </p>
      </div>
      <UiButton v-if="manage" size="sm" @click="openCreate()">
        <Icon name="lucide:plus" class="size-4" />
        New room
      </UiButton>
    </div>

    <!-- Room types, each with its rooms -->
    <section v-for="type in roomTypes" :key="type.id" class="mt-8">
      <div class="flex items-center gap-3">
        <template v-if="renamingTypeId === type.id">
          <UiInput
            v-model="renameValue"
            class="h-8 max-w-56"
            @keyup.enter="saveRename"
            @keyup.esc="renamingTypeId = null"
          />
          <UiButton size="sm" variant="outline" @click="saveRename"
            >Save</UiButton
          >
          <UiButton size="sm" variant="ghost" @click="renamingTypeId = null"
            >Cancel</UiButton
          >
        </template>
        <template v-else>
          <h2 class="font-serif text-lg tracking-wide">{{ type.name }}</h2>
          <span class="text-muted-foreground text-xs">
            Required by {{ requirementCounts?.[type.id] ?? 0 }} service{{
              (requirementCounts?.[type.id] ?? 0) === 1 ? "" : "s"
            }}
          </span>
          <UiButton
            v-if="manage"
            variant="ghost"
            size="sm"
            class="text-muted-foreground"
            @click="startRename(type)"
          >
            Rename
          </UiButton>
        </template>
      </div>

      <ul class="mt-3 grid gap-2 sm:grid-cols-2">
        <li
          v-for="room in roomsByType[type.id] ?? []"
          :key="room.id"
          class="flex items-center justify-between rounded-xl border bg-card px-4 py-3"
        >
          <p
            class="text-sm font-medium"
            :class="!room.active && 'text-muted-foreground line-through'"
          >
            {{ room.name }}
          </p>
          <div v-if="manage" class="flex gap-1">
            <UiButton variant="ghost" size="sm" @click="openEdit(room)"
              >Edit</UiButton
            >
            <UiButton
              variant="ghost"
              size="sm"
              :class="room.active ? 'text-destructive' : ''"
              @click="toggleRoomActive(room)"
            >
              {{ room.active ? "Deactivate" : "Activate" }}
            </UiButton>
          </div>
        </li>
        <li
          v-if="!roomsByType[type.id]?.length"
          class="text-muted-foreground rounded-xl border border-dashed px-4 py-3 text-sm"
        >
          No rooms of this type yet.
          <button
            v-if="manage"
            class="underline underline-offset-4"
            @click="openCreate(type.id)"
          >
            Add one
          </button>
        </li>
      </ul>
    </section>

    <!-- Add a room type -->
    <section v-if="manage" class="mt-10 rounded-xl border bg-card p-4">
      <p class="text-sm font-medium">Add a room type</p>
      <p class="text-muted-foreground mt-1 text-xs">
        Room types connect services to rooms — e.g. a "Sauna" service requires a
        "Sauna" room type, and the scheduler books any free room of that type.
      </p>
      <div class="mt-3 flex gap-2">
        <UiInput
          v-model="newTypeName"
          placeholder="e.g. Sauna, Couples Suite"
          class="max-w-64"
          @keyup.enter="addType"
        />
        <UiButton
          size="sm"
          :disabled="savingType || !newTypeName.trim()"
          :text="savingType ? 'Adding…' : 'Add type'"
          @click="addType"
        />
      </div>
    </section>

    <!-- Room create / edit dialog -->
    <UiDialog v-model:open="dialogOpen">
      <UiDialogContent class="sm:max-w-sm">
        <UiDialogHeader>
          <UiDialogTitle>{{
            editingId ? "Edit room" : "New room"
          }}</UiDialogTitle>
        </UiDialogHeader>
        <form @submit="saveRoom">
          <fieldset :disabled="isSubmitting" class="grid gap-4">
            <UiVeeInput label="Room name" name="name" placeholder="Room 4" />
            <div>
              <label class="text-sm font-medium" for="room-type"
                >Room type</label
              >
              <UiSelect v-model="roomTypeId">
                <UiSelectTrigger
                  id="room-type"
                  class="mt-1.5"
                  placeholder="Select a type"
                />
                <UiSelectContent>
                  <UiSelectItem
                    v-for="type in roomTypes"
                    :key="type.id"
                    :value="type.id"
                    :text="type.name"
                  />
                </UiSelectContent>
              </UiSelect>
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
                :text="isSubmitting ? 'Saving…' : 'Save room'"
              />
            </UiDialogFooter>
          </fieldset>
        </form>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
