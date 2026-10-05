<script setup lang="ts">
import {
  FIELD_TYPES,
  CONTACT_FIELD_KEYS,
  PROSPECT_INTAKE_FORM_KEY,
} from "~~/shared/forms/fields";
import type { FormField, FormFieldType } from "~~/shared/forms/fields";
import { FORM_TEMPLATES } from "~~/shared/forms/templates";

/**
 * Form authoring — create a form, edit its questions, and send it.
 *
 * Two rules from the design shape this whole screen:
 *
 * 1. Published versions never change. "Editing" a form publishes the NEXT
 *    version, and every response keeps pointing at the version it
 *    answered. That is what makes a waiver reconstructible years later,
 *    so the wording here says "Publish" rather than "Save".
 *
 * 2. A prospect form must carry first name, last name and email, required
 *    and non-sensitive, because those answers become the person's record.
 *    Rather than letting someone break that and meet it as a validation
 *    error, the seeded template arrives satisfying it and this editor
 *    locks those three fields.
 */
definePageMeta({ middleware: "can", permission: "forms.manage" });
useSeoMeta({ title: "Forms — The Reserve" });

const toast = useToast();

interface VersionSummary {
  id: string;
  version: number;
  fields: FormField[];
  consentText: string | null;
  publishedAt: string;
}
interface DefinitionSummary {
  id: string;
  key: string;
  name: string;
  description: string | null;
  active: boolean;
  currentVersion: VersionSummary | null;
}

const { data, pending, refresh } = await useFetch<{
  definitions: DefinitionSummary[];
}>("/api/forms");
const definitions = computed(() => data.value?.definitions ?? []);

const existingKeys = computed(
  () => new Set(definitions.value.map((d) => d.key)),
);
const availableTemplates = computed(() =>
  FORM_TEMPLATES.filter((t) => !existingKeys.value.has(t.key)),
);

// ── creating from a template ─────────────────────────────────────────
const creating = ref<string | null>(null);

async function createFromTemplate(templateKey: string) {
  const template = FORM_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) return;
  creating.value = templateKey;
  try {
    await $fetch("/api/forms", {
      method: "POST",
      body: {
        key: template.key,
        name: template.name,
        description: template.description,
        fields: template.fields,
        consentText: template.consentText,
      },
    });
    await refresh();
    toast.success(
      "Form created",
      "You can change the questions before sending it to anyone.",
    );
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not create the form",
      err.data?.statusMessage ?? "Please try again.",
    );
  } finally {
    creating.value = null;
  }
}

// ── editing questions ────────────────────────────────────────────────
const editorOpen = ref(false);
const editing = ref<DefinitionSummary | null>(null);
const draftFields = ref<FormField[]>([]);
const draftConsent = ref("");
const publishing = ref(false);

/**
 * Contact fields on a prospect form are constrained, but not equally.
 *
 * first_name / last_name / email are STRUCTURAL — the person's record
 * cannot be created without them, so they cannot be removed, renamed or
 * made optional. phone is optional in the same contract, so it stays
 * editable and removable; the only thing it may never be is sensitive,
 * because a sensitive answer routes to the health rows and would never
 * reach the contact promotion.
 */
const REQUIRED_CONTACT_KEYS = ["first_name", "last_name", "email"] as const;

function isStructural(
  def: DefinitionSummary | null,
  field: FormField,
): boolean {
  return (
    def?.key === PROSPECT_INTAKE_FORM_KEY &&
    (REQUIRED_CONTACT_KEYS as readonly string[]).includes(field.key)
  );
}

/** Any contact field, including phone: none of them may be sensitive. */
function isContactField(
  def: DefinitionSummary | null,
  field: FormField,
): boolean {
  return (
    def?.key === PROSPECT_INTAKE_FORM_KEY &&
    (CONTACT_FIELD_KEYS as readonly string[]).includes(field.key)
  );
}

function openEditor(def: DefinitionSummary) {
  editing.value = def;
  // A deep copy: editing a draft must not mutate the list behind it, and
  // abandoning the sheet must leave nothing changed.
  draftFields.value = JSON.parse(
    JSON.stringify(def.currentVersion?.fields ?? []),
  );
  draftConsent.value = def.currentVersion?.consentText ?? "";
  editorOpen.value = true;
}

/** A stable machine key derived from the label, unique within the form. */
function keyFor(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([0-9])/, "q$1")
      .slice(0, 60) || "question";
  let key = base;
  let n = 2;
  while (taken.has(key)) key = `${base}_${n++}`;
  return key;
}

function addField() {
  const taken = new Set(draftFields.value.map((f) => f.key));
  draftFields.value.push({
    key: keyFor("new question", taken),
    label: "",
    type: "text",
    required: false,
    sensitive: false,
  });
}

function removeField(index: number) {
  draftFields.value.splice(index, 1);
}

function move(index: number, by: number) {
  const to = index + by;
  if (to < 0 || to >= draftFields.value.length) return;
  const [item] = draftFields.value.splice(index, 1);
  draftFields.value.splice(to, 0, item!);
}

/** New fields get their key from their label until they are published. */
function onLabelChange(field: FormField, index: number) {
  const published = new Set(
    (editing.value?.currentVersion?.fields ?? []).map((f) => f.key),
  );
  if (published.has(field.key)) return; // never re-key an answered question
  const taken = new Set(
    draftFields.value.filter((_, i) => i !== index).map((f) => f.key),
  );
  field.key = keyFor(field.label, taken);
}

function optionsText(field: FormField): string {
  return (field.options ?? []).join("\n");
}
function setOptions(field: FormField, text: string) {
  field.options = text
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
}

const needsOptions = (type: FormFieldType) =>
  type === "select" || type === "multiselect";

/**
 * Assign an answer type through the select.
 *
 * UiSelect binds `AcceptableValue`, not our FormFieldType union, so this
 * guards the value at runtime instead of casting it away — a cast would
 * typecheck and still let a stray string reach `parseFields` at publish.
 *
 * It also drops `options` when the new type cannot carry any. parseFields
 * rejects options on a non-choice field, so leaving them behind after a
 * select → text change would make a later publish fail for a question that
 * looks perfectly fine on screen. This was latent before the conversion.
 */
function setType(field: FormField, value: unknown) {
  if (
    typeof value !== "string" ||
    !(FIELD_TYPES as readonly string[]).includes(value)
  )
    return;
  field.type = value as FormFieldType;
  if (!needsOptions(field.type)) delete field.options;
}

async function publish() {
  if (!editing.value) return;
  publishing.value = true;
  try {
    await $fetch(`/api/forms/${editing.value.key}/versions`, {
      method: "POST",
      body: {
        fields: draftFields.value,
        consentText: draftConsent.value || null,
      },
    });
    await refresh();
    editorOpen.value = false;
    toast.success(
      "New version published",
      "Forms already filled in keep the questions they were asked.",
    );
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not publish",
      err.data?.statusMessage ?? "Please check the questions.",
    );
  } finally {
    publishing.value = false;
  }
}

// ── sending a link ───────────────────────────────────────────────────
const supabase = useSupabaseClient();

const sendOpen = ref(false);
const sendingFor = ref<DefinitionSummary | null>(null);
const recipientEmail = ref("");
const sending = ref(false);
const result = ref<{
  url: string;
  emailed: boolean | null;
  to: string | null;
} | null>(null);

/**
 * Can this form stand up a NEW person, or must it go to someone we
 * already have?
 *
 * A link with no subject becomes a prospect on submit, and a prospect
 * needs a name and an email — so a form without those questions (a
 * treatment waiver, say) can only be sent to an existing client. Asking
 * the form's own fields is how this stays true for forms nobody has
 * written yet, rather than keying off the form's name.
 */
function createsProspects(def: DefinitionSummary): boolean {
  const fields = def.currentVersion?.fields ?? [];
  return (["first_name", "last_name", "email"] as const).every((key) =>
    fields.some((f) => f.key === key && f.required && !f.sensitive),
  );
}

interface ClientOption {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}
const clientQuery = ref("");
const clientResults = ref<ClientOption[]>([]);
const selectedClient = ref<ClientOption | null>(null);
const searchingClients = ref(false);

async function searchClients() {
  const q = clientQuery.value.trim();
  if (q.length < 2) {
    clientResults.value = [];
    return;
  }
  searchingClients.value = true;
  const { data } = await supabase
    .from("clients")
    .select("id, first_name, last_name, email")
    .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
    .eq("active", true)
    .limit(8);
  clientResults.value = (data ?? []) as ClientOption[];
  searchingClients.value = false;
}

function chooseClient(client: ClientOption) {
  selectedClient.value = client;
  clientResults.value = [];
  clientQuery.value = "";
  // Their address is the obvious default, and it is editable.
  if (client.email) recipientEmail.value = client.email;
}

function openSend(def: DefinitionSummary) {
  sendingFor.value = def;
  recipientEmail.value = "";
  selectedClient.value = null;
  clientQuery.value = "";
  clientResults.value = [];
  result.value = null;
  sendOpen.value = true;
}

/** A waiver cannot be sent until we know who it is for. */
const canSendLink = computed(() => {
  if (!sendingFor.value) return false;
  if (createsProspects(sendingFor.value)) return true;
  return !!selectedClient.value;
});

async function createLink() {
  if (!sendingFor.value) return;
  sending.value = true;
  try {
    const res = await $fetch<{
      path: string;
      emailed: boolean | null;
      deliveryEmail: string | null;
    }>(`/api/forms/${sendingFor.value.key}/links`, {
      method: "POST",
      body: {
        deliveryEmail: recipientEmail.value.trim() || undefined,
        clientId: selectedClient.value?.id,
      },
    });
    result.value = {
      url: `${window.location.origin}${res.path}`,
      emailed: res.emailed,
      to: res.deliveryEmail,
    };
    if (res.emailed)
      toast.success("Sent", `The form is on its way to ${res.deliveryEmail}.`);
    else if (res.emailed === false)
      toast.warning(
        "Link ready, but not emailed",
        "Send it yourself using the link below.",
      );
    else toast.success("Link ready", "Copy it and send it however you like.");
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error(
      "Could not create a link",
      err.data?.statusMessage ?? "Please try again.",
    );
  } finally {
    sending.value = false;
  }
}

async function copyLink() {
  if (!result.value) return;
  await navigator.clipboard.writeText(result.value.url);
  toast.info("Copied", "The link is on your clipboard.");
}

function fieldSummary(field: FormField): string {
  const parts: string[] = [field.type];
  if (field.required) parts.push("required");
  if (field.sensitive) parts.push("health");
  return parts.join(" · ");
}
</script>

<template>
  <div class="w-full px-4 py-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Forms</h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Intake forms and waivers, and the links you send people to fill them
          in.
        </p>
      </div>
      <div
        v-if="definitions.length && availableTemplates.length"
        class="flex gap-2"
      >
        <UiButton
          v-for="t in availableTemplates"
          :key="t.key"
          variant="outline"
          size="sm"
          :disabled="creating === t.key"
          @click="createFromTemplate(t.key)"
        >
          <Icon name="lucide:plus" class="mr-1.5 size-4" />
          {{ creating === t.key ? "Creating…" : t.name }}
        </UiButton>
      </div>
    </div>

    <div v-if="pending" class="mt-8 space-y-3">
      <UiSkeleton v-for="i in 2" :key="i" class="h-24 w-full rounded-xl" />
    </div>

    <!-- Empty: offer the templates rather than a blank page. -->
    <div
      v-else-if="!definitions.length"
      class="rounded-xl border border-dashed p-10"
    >
      <div class="text-center">
        <Icon
          name="lucide:clipboard-list"
          class="text-muted-foreground mx-auto size-8"
          aria-hidden="true"
        />
        <p class="mt-3 font-medium">No forms yet</p>
        <p class="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
          Start from one of ours. Everything in it can be changed, and nothing
          is sent to anyone until you create a link.
        </p>
      </div>
      <div class="mt-6 grid gap-3 sm:grid-cols-2">
        <button
          v-for="t in FORM_TEMPLATES"
          :key="t.key"
          type="button"
          class="hover:border-primary/40 focus-visible:ring-ring/50 rounded-xl border p-4 text-left transition outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50"
          :disabled="creating === t.key"
          @click="createFromTemplate(t.key)"
        >
          <p class="font-medium">{{ t.name }}</p>
          <p class="text-muted-foreground mt-1 text-sm">{{ t.description }}</p>
          <p class="text-muted-foreground mt-3 text-xs">
            {{ t.fields.length }} questions ·
            {{ t.fields.filter((f) => f.sensitive).length }} health questions
          </p>
          <span
            class="mt-3 inline-flex items-center gap-1.5 text-sm font-medium"
          >
            <Icon name="lucide:plus" class="size-4" aria-hidden="true" />
            {{ creating === t.key ? "Creating…" : "Use this form" }}
          </span>
        </button>
      </div>
    </div>

    <div v-else class="mt-8 flex flex-col gap-4 md:flex-row md:gap-8">
      <div v-for="def in definitions" :key="def.id" class="rounded-xl border">
        <div class="flex flex-wrap items-start justify-between gap-4 p-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="font-medium">{{ def.name }}</h2>
              <UiBadge v-if="!def.active" variant="outline">Inactive</UiBadge>
            </div>
            <p
              v-if="def.description"
              class="text-muted-foreground mt-1 text-sm"
            >
              {{ def.description }}
            </p>
            <p class="text-muted-foreground mt-2 text-sm">
              <template v-if="def.currentVersion">
                Version {{ def.currentVersion.version }} ·
                {{ def.currentVersion.fields.length }} questions · published
                {{
                  new Date(def.currentVersion.publishedAt).toLocaleDateString(
                    "en-CA",
                  )
                }}
              </template>
              <template v-else>No published version yet</template>
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <UiButton variant="outline" size="sm" @click="openEditor(def)">
              <Icon name="lucide:pencil" class="mr-1.5 size-4" />
              Questions
            </UiButton>
            <UiButton
              size="sm"
              :disabled="!def.currentVersion"
              @click="openSend(def)"
            >
              <Icon name="lucide:send" class="mr-1.5 size-4" />
              Send this form
            </UiButton>
          </div>
        </div>

        <ul v-if="def.currentVersion" class="divide-y border-t">
          <li
            v-for="field in def.currentVersion.fields"
            :key="field.key"
            class="flex items-start justify-between gap-4 px-4 py-2.5"
          >
            <p class="min-w-0 truncate text-sm">{{ field.label }}</p>
            <div class="flex shrink-0 items-center gap-2">
              <Icon
                v-if="field.sensitive"
                name="lucide:shield"
                class="size-4"
                aria-hidden="true"
              />
              <span class="text-muted-foreground text-xs">{{
                fieldSummary(field)
              }}</span>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- ── The question editor ───────────────────────────────────── -->
    <UiSheet v-model:open="editorOpen">
      <UiSheetContent
        side="right"
        class="sm:max-w-none md:w-[90vw] lg:w-[760px]"
        :title="editing ? `Questions — ${editing.name}` : 'Questions'"
        description="Changing anything here publishes a new version. Forms already filled in keep the questions they were asked."
      >
        <template #content>
          <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <div
              v-for="(field, index) in draftFields"
              :key="index"
              class="rounded-xl border p-4"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <UiLabel :for="`label-${index}`" class="text-xs"
                    >Question</UiLabel
                  >
                  <UiInput
                    :id="`label-${index}`"
                    v-model="field.label"
                    :disabled="isStructural(editing, field)"
                    placeholder="What do you want to ask?"
                    class="mt-1"
                    @blur="onLabelChange(field, index)"
                  />
                </div>
                <div class="flex shrink-0 gap-1 pt-5">
                  <UiButton
                    variant="ghost"
                    size="icon-sm"
                    :disabled="index === 0"
                    aria-label="Move up"
                    @click="move(index, -1)"
                  >
                    <Icon name="lucide:chevron-up" class="size-4" />
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    size="icon-sm"
                    :disabled="index === draftFields.length - 1"
                    aria-label="Move down"
                    @click="move(index, 1)"
                  >
                    <Icon name="lucide:chevron-down" class="size-4" />
                  </UiButton>
                  <UiButton
                    variant="ghost"
                    size="icon-sm"
                    :disabled="isStructural(editing, field)"
                    aria-label="Remove question"
                    @click="removeField(index)"
                  >
                    <Icon name="lucide:trash-2" class="size-4" />
                  </UiButton>
                </div>
              </div>

              <div class="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <UiLabel :for="`type-${index}`" class="text-xs"
                    >Answer type</UiLabel
                  >
                  <UiSelect
                    :model-value="field.type"
                    :disabled="isStructural(editing, field)"
                    @update:model-value="(v) => setType(field, v)"
                  >
                    <UiSelectTrigger :id="`type-${index}`" class="mt-1" />
                    <UiSelectContent>
                      <UiSelectItem
                        v-for="t in FIELD_TYPES"
                        :key="t"
                        :value="t"
                        :text="t"
                      />
                    </UiSelectContent>
                  </UiSelect>
                </div>
                <label class="flex items-center gap-2 pt-6 text-sm">
                  <UiCheckbox
                    v-model="field.required"
                    :disabled="isStructural(editing, field)"
                  />
                  Must be answered
                </label>
                <label class="flex items-center gap-2 pt-6 text-sm">
                  <UiCheckbox
                    v-model="field.sensitive"
                    :disabled="isContactField(editing, field)"
                  />
                  Health question
                </label>
              </div>

              <div v-if="needsOptions(field.type)" class="mt-3">
                <UiLabel :for="`options-${index}`" class="text-xs">
                  Choices, one per line
                </UiLabel>
                <UiTextarea
                  :id="`options-${index}`"
                  :model-value="optionsText(field)"
                  :rows="3"
                  class="mt-1"
                  @update:model-value="(v) => setOptions(field, String(v))"
                />
              </div>

              <p
                v-if="field.sensitive"
                class="text-muted-foreground mt-3 text-xs"
              >
                <Icon
                  name="lucide:shield"
                  class="mr-1 inline size-3.5"
                  aria-hidden="true"
                />
                Stored separately from the rest. Needs the health-notes
                permission to read, and never shows on the approval screen.
              </p>
              <p
                v-if="isStructural(editing, field)"
                class="text-muted-foreground mt-3 text-xs"
              >
                <Icon
                  name="lucide:lock"
                  class="mr-1 inline size-3.5"
                  aria-hidden="true"
                />
                This answer becomes the person's record, so it stays required
                and cannot be a health question.
              </p>
              <p
                v-else-if="isContactField(editing, field)"
                class="text-muted-foreground mt-3 text-xs"
              >
                <Icon
                  name="lucide:lock"
                  class="mr-1 inline size-3.5"
                  aria-hidden="true"
                />
                You can reword or remove this, but it cannot be a health
                question — it goes into the person's contact details.
              </p>
            </div>

            <UiButton variant="outline" class="w-full" @click="addField">
              <Icon name="lucide:plus" class="mr-1.5 size-4" />
              Add a question
            </UiButton>

            <div class="pt-2">
              <UiLabel for="consent" class="text-xs">
                What they agree to (leave blank for none)
              </UiLabel>
              <UiTextarea
                id="consent"
                v-model="draftConsent"
                :rows="5"
                class="mt-1"
              />
              <p class="text-muted-foreground mt-1.5 text-xs">
                Shown above the send button, with a tick box. The exact wording
                is saved with each answer, so changing it later never rewrites
                what someone already agreed to.
              </p>
            </div>
          </div>
        </template>

        <template #footer>
          <UiSheetFooter class="flex-row justify-end gap-2 border-t p-4">
            <UiButton variant="outline" @click="editorOpen = false"
              >Cancel</UiButton
            >
            <UiButton
              :disabled="publishing || !draftFields.length"
              @click="publish"
            >
              {{ publishing ? "Publishing…" : "Publish new version" }}
            </UiButton>
          </UiSheetFooter>
        </template>
      </UiSheetContent>
    </UiSheet>

    <!-- ── Send a link ───────────────────────────────────────────── -->
    <UiDialog v-model:open="sendOpen">
      <UiDialogContent class="sm:max-w-lg">
        <UiDialogHeader>
          <UiDialogTitle>Send {{ sendingFor?.name }}</UiDialogTitle>
          <UiDialogDescription>
            We email a private link that works once. You can also copy it and
            send it yourself.
          </UiDialogDescription>
        </UiDialogHeader>

        <div v-if="!result" class="space-y-4">
          <!-- Forms with no contact questions cannot create a new person,
               so they must be addressed to someone already on file. -->
          <div v-if="sendingFor && !createsProspects(sendingFor)">
            <UiLabel for="client-search">Which client is this for?</UiLabel>
            <div
              v-if="selectedClient"
              class="mt-1.5 flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">
                  {{ selectedClient.first_name }} {{ selectedClient.last_name }}
                </p>
                <p class="text-muted-foreground truncate text-xs">
                  {{ selectedClient.email ?? "No email on file" }}
                </p>
              </div>
              <UiButton
                variant="ghost"
                size="sm"
                @click="selectedClient = null"
              >
                Change
              </UiButton>
            </div>
            <template v-else>
              <UiInput
                id="client-search"
                v-model="clientQuery"
                placeholder="Search by name or email"
                class="mt-1.5"
                @input="searchClients"
              />
              <ul
                v-if="clientResults.length"
                class="mt-2 divide-y rounded-lg border"
              >
                <li v-for="c in clientResults" :key="c.id">
                  <button
                    type="button"
                    class="hover:bg-muted/50 w-full px-3 py-2 text-left"
                    @click="chooseClient(c)"
                  >
                    <span class="text-sm"
                      >{{ c.first_name }} {{ c.last_name }}</span
                    >
                    <span class="text-muted-foreground ml-2 text-xs">{{
                      c.email
                    }}</span>
                  </button>
                </li>
              </ul>
              <p
                v-else-if="clientQuery.trim().length >= 2 && !searchingClients"
                class="text-muted-foreground mt-2 text-sm"
              >
                No matching clients.
              </p>
              <p class="text-muted-foreground mt-1.5 text-xs">
                This form has no name or email questions, so it can only go to
                someone already on file.
              </p>
            </template>
          </div>

          <div>
            <UiLabel for="recipient">Their email address</UiLabel>
            <UiInput
              id="recipient"
              v-model="recipientEmail"
              type="email"
              placeholder="name@example.com"
              class="mt-1.5"
              @keydown.enter.prevent="createLink"
            />
            <p class="text-muted-foreground mt-1.5 text-xs">
              Leave blank to just get a link without emailing anyone.
            </p>
          </div>
        </div>

        <div v-else class="space-y-3">
          <p class="flex items-start gap-2 text-sm">
            <Icon
              :name="result.emailed ? 'lucide:mail-check' : 'lucide:link'"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>
              <template v-if="result.emailed"
                >Emailed to {{ result.to }}.</template
              >
              <template v-else-if="result.emailed === false">
                We could not send the email. The link below still works — send
                it yourself.
              </template>
              <template v-else>Link ready.</template>
            </span>
          </p>
          <div class="bg-muted/40 flex items-center gap-2 rounded-lg p-3">
            <code class="min-w-0 flex-1 truncate text-xs">{{
              result.url
            }}</code>
            <UiButton variant="outline" size="sm" @click="copyLink">
              <Icon name="lucide:copy" class="mr-1.5 size-3.5" />
              Copy
            </UiButton>
          </div>
        </div>

        <UiDialogFooter>
          <UiButton v-if="result" variant="outline" @click="sendOpen = false"
            >Done</UiButton
          >
          <template v-else>
            <UiButton variant="outline" @click="sendOpen = false"
              >Cancel</UiButton
            >
            <UiButton :disabled="sending || !canSendLink" @click="createLink">
              {{
                sending
                  ? "Working…"
                  : recipientEmail.trim()
                    ? "Send it"
                    : "Just make a link"
              }}
            </UiButton>
          </template>
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialog>
  </div>
</template>
