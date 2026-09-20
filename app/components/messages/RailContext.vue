<script setup lang="ts">
/**
 * The right rail's top: WHO the open conversation is with. shrink-0 and
 * DISPLAY-ONLY — nothing in here reacts to a click except the one
 * profile link on a DM card (a link, not the card). Two modes
 * (docs/design/messaging-enhancements.md, feature 1):
 *
 *  - dm: one partner → a contact card: avatar, name, role (job title),
 *    WORK contact (email, phone — staff seeing colleagues' work contact
 *    is permission-appropriate; nothing personal, never the emergency
 *    fields), and "View profile" → /staff/[id].
 *  - group: stacked overlapping avatars (ui-thing's -space-x-3 idiom),
 *    at most four plus a "+N" bubble, names on hover only. No contact
 *    detail, no links, no click — membership at a glance, and a fixed
 *    footprint however large the group, so it never needs to scroll.
 *
 * Data comes from the page's already-loaded staff list; this component
 * fetches nothing.
 */
export interface RailPerson {
  id: string;
  display_name: string;
  avatar_url: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  pronouns?: string | null;
}

const props = defineProps<{
  /** null when no conversation is open. */
  kind: "dm" | "group" | null;
  /** The conversation's display name (group name, or the partner's). */
  name: string;
  /** Everyone in the conversation except the viewer. */
  people: RailPerson[];
}>();

const MAX_AVATARS = 4;
const partner = computed(() => props.people[0] ?? null);
const shown = computed(() => props.people.slice(0, MAX_AVATARS));
const overflow = computed(() => Math.max(props.people.length - MAX_AVATARS, 0));
</script>

<template>
  <!-- Same card look as the directory frame below it (rounded, bordered,
       bg-card, p-3); mx-3 mt-3 lines its edges up with the frame's m-3, and
       the frame's own top margin is the gap between the two. -->
  <div
    class="mx-3 mt-3 shrink-0 rounded-md border bg-card p-3"
    data-rail-context
  >
    <!-- No conversation open -->
    <p v-if="!kind" class="text-muted-foreground text-sm">
      Pick a conversation to see who is in it.
    </p>

    <!-- DM: contact card -->
    <div v-else-if="kind === 'dm' && partner" class="flex items-start gap-3">
      <UiAvatar class="size-14">
        <UiAvatarImage
          v-if="partner.avatar_url"
          :src="partner.avatar_url"
          :alt="partner.display_name"
        />
        <UiAvatarFallback class="text-base">
          {{ initials(partner.display_name) }}
        </UiAvatarFallback>
      </UiAvatar>
      <div class="min-w-0 flex-1">
        <p class="truncate font-medium">
          {{ partner.display_name }}
          <span
            v-if="partner.pronouns"
            class="text-muted-foreground text-xs font-normal"
          >
            {{ partner.pronouns }}
          </span>
        </p>
        <p class="text-muted-foreground truncate text-sm">
          {{ partner.title || "Staff" }}
        </p>
        <dl class="text-muted-foreground mt-2 space-y-0.5 text-xs">
          <div v-if="partner.email" class="flex items-center gap-1.5">
            <Icon
              name="lucide:mail"
              class="size-3.5 shrink-0"
              aria-hidden="true"
            />
            <dt class="sr-only">Email</dt>
            <dd class="truncate">{{ partner.email }}</dd>
          </div>
          <div v-if="partner.phone" class="flex items-center gap-1.5">
            <Icon
              name="lucide:phone"
              class="size-3.5 shrink-0"
              aria-hidden="true"
            />
            <dt class="sr-only">Phone</dt>
            <dd class="truncate">{{ partner.phone }}</dd>
          </div>
        </dl>
        <NuxtLink
          :to="`/staff/${partner.id}`"
          class="mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          View profile
          <Icon name="lucide:arrow-right" class="size-3" aria-hidden="true" />
        </NuxtLink>
      </div>
    </div>

    <!-- Group: avatar stack, names on hover, nothing clickable -->
    <div v-else>
      <p class="truncate font-medium">{{ name }}</p>
      <p class="text-muted-foreground text-sm">
        {{ people.length + 1 }} people, including you
      </p>
      <div class="mt-3 flex items-center">
        <div class="flex -space-x-3">
          <UiAvatar
            v-for="person in shown"
            :key="person.id"
            class="ring-background size-9 ring-2"
            :title="person.display_name"
          >
            <UiAvatarImage
              v-if="person.avatar_url"
              :src="person.avatar_url"
              :alt="person.display_name"
            />
            <UiAvatarFallback class="text-xs">
              {{ initials(person.display_name) }}
            </UiAvatarFallback>
          </UiAvatar>
          <span
            v-if="overflow"
            class="ring-background bg-muted text-muted-foreground inline-flex size-9 items-center justify-center rounded-full text-xs font-medium ring-2"
            :title="
              people
                .slice(MAX_AVATARS)
                .map((p) => p.display_name)
                .join(', ')
            "
          >
            +{{ overflow }}
          </span>
        </div>
      </div>
      <p class="sr-only">
        Members: {{ people.map((p) => p.display_name).join(", ") }}
      </p>
    </div>
  </div>
</template>
