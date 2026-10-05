<script setup lang="ts">
import type { RailPerson } from "~/components/messages/RailContext.vue";
import type { useStartConversation } from "~/composables/useStartConversation";

/**
 * The rail's directory: every colleague, one row each, in a ScrollFrame
 * that fills the rail below the context card and scrolls within it
 * (docs/design/messaging-enhancements.md, feature 2).
 *
 * The ROW IS INERT — it is a container for two controls, not a button,
 * so it gets no hover state and no cursor. The two actionable bits are:
 *   - the checkbox → multi-select. Native input, because it binds a set
 *     (the reserve-frontend checkbox rule) — and it is the SAME set the
 *     new-message dialog uses, handed in as `starter`, so a selection
 *     here and a selection there are one selection.
 *   - the ⋮ menu → "Chat with" (a DM via the shared starter with that
 *     one id) and "Go to profile" (/staff/[id]).
 * With one or more selected, "Start conversation" / "Start group" is
 * pinned at the bottom of the rail (the frame's footer) and calls the
 * shared starter — the dialog's exact one-vs-many logic, not a copy.
 */
const props = defineProps<{
  /** Colleagues (the viewer excluded), from the page's loaded staff list. */
  staff: RailPerson[];
  /** The page's useStartConversation() — shared with the dialog. */
  starter: ReturnType<typeof useStartConversation>;
  /** The shared group name (v-model from the page's starter.groupName). */
  groupName: string;
}>();
const emit = defineEmits<{ "update:groupName": [value: string] }>();

// Refs inside a returned object do NOT auto-unwrap in the template
// (reserve-frontend trap), hence the computeds.
const selectedCount = computed(() => props.starter.picked.set.value.size);
const creating = computed(() => props.starter.creating.value);
</script>

<template>
  <DashboardScrollFrame data-rail-directory>
    <template #header>
      <p
        class="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide"
      >
        Staff
      </p>
    </template>

    <ul class="space-y-0.5">
      <li
        v-for="member in staff"
        :key="member.id"
        class="flex items-center gap-3 rounded-md px-2 py-1.5"
        :data-staff-row="member.id"
      >
        <input
          type="checkbox"
          class="size-4 shrink-0 accent-primary"
          :checked="starter.picked.has(member.id)"
          :aria-label="`Select ${member.display_name}`"
          @change="starter.picked.toggle(member.id)"
        />
        <UiAvatar class="size-7 shrink-0">
          <UiAvatarImage
            v-if="member.avatar_url"
            :src="member.avatar_url"
            :alt="member.display_name"
          />
          <UiAvatarFallback class="text-xs">
            {{ initials(member.display_name) }}
          </UiAvatarFallback>
        </UiAvatar>
        <span class="min-w-0 flex-1 truncate text-sm">
          {{ member.display_name }}
        </span>
        <UiDropdownMenu>
          <UiDropdownMenuTrigger as-child>
            <UiButton
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground shrink-0"
              :aria-label="`Actions for ${member.display_name}`"
            >
              <Icon name="lucide:ellipsis-vertical" class="size-4" />
            </UiButton>
          </UiDropdownMenuTrigger>
          <UiDropdownMenuContent align="end" class="w-44">
            <UiDropdownMenuItem
              icon="lucide:message-circle"
              title="Chat with"
              @select="starter.start([member.id])"
            />
            <UiDropdownMenuItem
              icon="lucide:user"
              title="Go to profile"
              @select="navigateTo(`/staff/${member.id}`)"
            />
          </UiDropdownMenuContent>
        </UiDropdownMenu>
      </li>
      <li v-if="!staff.length" class="text-muted-foreground px-2 py-2 text-sm">
        No colleagues yet.
      </li>
    </ul>

    <template v-if="selectedCount" #footer>
      <div class="mt-3 space-y-2 border-t pt-3" data-rail-start>
        <UiInput
          v-if="selectedCount > 1"
          :model-value="groupName"
          placeholder="Group name (optional)"
          @update:model-value="emit('update:groupName', String($event))"
        />
        <UiButton
          class="w-full"
          :disabled="creating"
          :text="
            creating
              ? 'Starting…'
              : selectedCount > 1
                ? `Start group (${selectedCount})`
                : 'Start conversation'
          "
          @click="starter.start()"
        />
      </div>
    </template>
  </DashboardScrollFrame>
</template>
