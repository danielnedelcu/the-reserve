# Component APIs, as this codebase actually uses them

Every example below is from live code, cited. Where a component differs
from the native control it resembles, the difference is stated first —
that is the part that causes regressions.

## UiVeeInput — the default form field (53 uses)

Binds by `name` to the surrounding `useForm` schema. Carries its own label,
required marker and error message, so do not wrap it in your own label.

```vue
<UiVeeInput label="First name" name="firstName" />
<UiVeeInput label="Date of birth" name="dateOfBirth" type="date" />
```

```ts
const { handleSubmit, isSubmitting, resetForm, setValues } = useForm({
  validationSchema: toTypedSchema(ClientSchema),
});
```
(`app/pages/clients/index.vue:127,390-398`)

`required` renders a red asterisk (`Ui/Vee/Input.vue:10`). That is fine for
staff tools and deliberately NOT used on the public form, which spells the
word "(required)" instead.

Use raw `UiInput` only outside a vee-validate form — a search box, a filter,
a one-field dialog.

## UiSelect — compound, and string-valued

**Differs from `<select>` in two ways that break a naive swap:** it is four
components rather than one, and its value is always a string.

```vue
<UiSelect v-model="preferredContact">
  <UiSelectTrigger id="c-contact-method" class="mt-1.5" placeholder="Email" />
  <UiSelectContent>
    <UiSelectItem value="email" text="Email" />
    <UiSelectItem value="phone" text="Phone call" />
  </UiSelectContent>
</UiSelect>
```
(`app/pages/clients/index.vue:425-436`)

- `UiSelectTrigger` takes `placeholder` and the `id` your label points at.
  `UiSelectValue` is the alternative when you want the trigger to render the
  chosen item itself (`Ui/TanStackTable.vue:272`).
- `UiSelectItem` takes `value` plus EITHER a `text` prop or a default slot
  (`Ui/Select/Item.vue:11`).
- **Numeric options must be converted on both sides.** The paging control
  keeps a computed for exactly this:

```ts
const pageSize = computed({
  get: () => table.atoms.pagination.get().pageSize.toString(),
  set: (value: string) => table.setPageSize(Number(value)),
});
```
(`Ui/TanStackTable.vue:689`)

There is no `change` event to listen to — use `v-model`, or watch the bound
ref. Code ported from `<select>` that relied on `@change` will silently stop
firing.

## UiCheckbox vs native

Choose by binding target — see SKILL.md. The behavioural differences, for
when you are converting or testing:

| | native `<input type="checkbox">` | `UiCheckbox` |
| --- | --- | --- |
| element | `<input>` | `<button role="checkbox">` (reka-ui) |
| state in DOM | `.checked` | `data-state` / `aria-checked` |
| array `v-model` | yes, push/remove | only inside `UiCheckboxGroup` (`:value` per box) |
| implicit form submit | participates | does not |
| after `.click()` | state readable immediately | updates on the next tick |

That last row matters when driving the UI in a test or a browser session:
reading state in the same tick returns the previous value.

## UiList — props, not slots, with separators between items

```vue
<UiList v-if="newClients?.length">
  <template v-for="client in newClients" :key="client.id">
    <UiListItem :to="`/clients/${client.id}`" class="rounded-lg px-0">
      <UiAvatar class="size-8">
        <UiAvatarFallback class="text-xs">{{ initials(client) }}</UiAvatarFallback>
      </UiAvatar>
      <UiListContent>
        <UiListTitle :title="`${client.first_name} ${client.last_name}`" />
        <UiListSubtitle v-if="client.email" :subtitle="client.email" class="line-clamp-1" />
      </UiListContent>
      <span class="text-muted-foreground ml-auto shrink-0 self-center text-xs">
        {{ joinedLabel(client.created_at) }}
      </span>
    </UiListItem>
    <UiSeparator class="my-1 ml-auto w-full last:hidden" />
  </template>
</UiList>
```
(`app/components/dashboard/NewClients.vue:56-80`)

- `:title` / `:subtitle` are PROPS. A default slot exists as a fallback
  (`Ui/List/Title.vue:6`), but the prop is the house form.
- The separator goes INSIDE the `v-for` template, after the item, with
  `last:hidden` — that is what puts dividers between items and not after the
  last one. `<template v-for>` is required so both siblings share the key.

## UiChip — decoration around a trigger

Wraps its child and positions a badge on it; `color` is raw classes
(`Ui/Chip.vue:11,40`).

```vue
<UiChip
  v-if="unreadCount"
  size="xl"
  color="bg-emerald-500 text-white dark:bg-emerald-400 dark:text-emerald-950"
  :text="unreadCount > 99 ? '99+' : unreadCount.toString()"
>
  <UiButton size="icon-sm" variant="outline" class="relative" aria-label="Open notifications">
    <Icon name="lucide:bell" class="size-4" aria-hidden="true" />
  </UiButton>
</UiChip>
```
(`app/components/NotificationsBell.vue:105-118`)

## Dialogs and sheets

**Neither contains a `<form>`, so Enter does not submit.** Bind it:
`@keydown.enter.prevent="…"` on the input that should trigger the action.

Dialog — `UiDialog` > `UiDialogContent` > `Header` / body / `Footer`, opened
with `v-model:open` (`GiftCardLookup.vue:67`, `pages/forms/index.vue:602`).

Sheet — side panel for anything with a long body. `title` and `description`
are props on `UiSheetContent`; the body goes in `#content` and the actions in
`#footer`, so the body scrolls and the footer stays put:

```vue
<UiSheet v-model:open="open">
  <UiSheetContent
    side="right"
    class="sm:max-w-none md:w-[90vw] lg:w-[720px]"
    :title="record ? `Edit ${record.display_name}` : 'Edit staff member'"
    description="Employment details, personal info, and roles."
  >
    <template #content>
      <form class="min-h-0 flex-1 overflow-y-auto">…</form>
    </template>
    <template #footer>
      <UiSheetFooter class="flex-row justify-end gap-2 border-t p-4">…</UiSheetFooter>
    </template>
  </UiSheetContent>
</UiSheet>
```
(`app/components/StaffEditSheet.vue:200-328`)

The `min-h-0 flex-1 overflow-y-auto` on the body is load-bearing: without
`min-h-0` a flex child refuses to shrink and the panel scrolls as a whole,
taking the footer off-screen.

## Toasts

`useToast()` is the single vocabulary — `success` / `error` / `info` /
`warning`, each taking a title and a body (`app/composables/useToast.ts`).
Do not call `vue-sonner` directly.
