<script setup lang="ts">
import type { FormField } from "~~/shared/forms/fields";

/**
 * Form authoring — definitions and their versions.
 *
 * Editing a published form is not possible, and the interface says so
 * rather than hiding it: publishing produces a NEW version, and every
 * response keeps pointing at the version it answered. That is what makes
 * a waiver reconstructible years later, so the wording here ("Publish a
 * new version") is load-bearing, not decoration.
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
const expanded = ref<string | null>(null);

/** Issue-link state, per definition. */
const issuing = ref<string | null>(null);
const issuedLink = ref<{ key: string; url: string } | null>(null);

async function issueLink(def: DefinitionSummary) {
  issuing.value = def.key;
  issuedLink.value = null;
  try {
    const result = await $fetch<{ path: string; expiresAt: string }>(
      `/api/forms/${def.key}/links`,
      { method: "POST", body: {} },
    );
    issuedLink.value = {
      key: def.key,
      url: `${window.location.origin}${result.path}`,
    };
    toast.success("Link ready", "Copy it and send it to the person filling in the form.");
  } catch (e: unknown) {
    const err = e as { data?: { statusMessage?: string } };
    toast.error("Could not create a link", err.data?.statusMessage ?? "Please try again.");
  } finally {
    issuing.value = null;
  }
}

async function copyLink() {
  if (!issuedLink.value) return;
  await navigator.clipboard.writeText(issuedLink.value.url);
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
  <div class="mx-auto w-full max-w-4xl px-4 py-8">
    <div>
      <h1 class="text-2xl font-semibold">Forms</h1>
      <p class="text-muted-foreground mt-1 text-sm">
        Intake forms and waivers, and the links you send people to fill them
        in.
      </p>
    </div>

    <div v-if="pending" class="mt-8 space-y-3">
      <UiSkeleton v-for="i in 2" :key="i" class="h-24 w-full rounded-xl" />
    </div>

    <div
      v-else-if="!definitions.length"
      class="mt-8 rounded-xl border border-dashed p-10 text-center"
    >
      <Icon
        name="lucide:clipboard-list"
        class="text-muted-foreground mx-auto size-8"
        aria-hidden="true"
      />
      <p class="mt-3 font-medium">No forms yet</p>
      <p class="text-muted-foreground mx-auto mt-1 max-w-md text-sm">
        Forms are created through the API for now — a prospect intake form
        needs first name, last name and email so the person's details can
        become their record.
      </p>
    </div>

    <div v-else class="mt-8 space-y-4">
      <div v-for="def in definitions" :key="def.id" class="rounded-xl border">
        <div class="flex flex-wrap items-start justify-between gap-4 p-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="font-medium">{{ def.name }}</h2>
              <UiBadge v-if="!def.active" variant="outline">Inactive</UiBadge>
            </div>
            <p class="text-muted-foreground mt-0.5 font-mono text-xs">
              {{ def.key }}
            </p>
            <p v-if="def.description" class="text-muted-foreground mt-1 text-sm">
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
            <UiButton
              variant="outline"
              size="sm"
              @click="expanded = expanded === def.id ? null : def.id"
            >
              {{ expanded === def.id ? "Hide questions" : "See questions" }}
            </UiButton>
            <UiButton
              size="sm"
              :disabled="!def.currentVersion || issuing === def.key"
              @click="issueLink(def)"
            >
              {{ issuing === def.key ? "Creating…" : "Create a link" }}
            </UiButton>
          </div>
        </div>

        <!-- The issued link, shown once. It is the only time it appears:
             the token is stored hashed nowhere and shown nowhere else, so
             copying it now is the whole point. -->
        <div
          v-if="issuedLink?.key === def.key"
          class="bg-muted/40 flex flex-wrap items-center gap-3 border-t px-4 py-3"
        >
          <code class="min-w-0 flex-1 truncate text-xs">{{
            issuedLink.url
          }}</code>
          <UiButton variant="outline" size="sm" @click="copyLink">
            <Icon name="lucide:copy" class="mr-1.5 size-3.5" />
            Copy
          </UiButton>
        </div>

        <div v-if="expanded === def.id && def.currentVersion" class="border-t">
          <ul class="divide-y">
            <li
              v-for="field in def.currentVersion.fields"
              :key="field.key"
              class="flex items-start justify-between gap-4 px-4 py-2.5"
            >
              <div class="min-w-0">
                <p class="truncate text-sm">{{ field.label }}</p>
                <p class="text-muted-foreground font-mono text-xs">
                  {{ field.key }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Icon
                  v-if="field.sensitive"
                  name="lucide:shield"
                  class="size-4"
                  aria-hidden="true"
                />
                <span class="text-muted-foreground text-xs">
                  {{ fieldSummary(field) }}
                </span>
              </div>
            </li>
          </ul>
          <p class="text-muted-foreground border-t px-4 py-3 text-xs">
            Questions marked <span class="font-medium">health</span> are stored
            separately and need the health-notes permission to read. They never
            appear on the approval screen. To change any question, publish a
            new version — published versions never change, so older answers
            keep their meaning.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
