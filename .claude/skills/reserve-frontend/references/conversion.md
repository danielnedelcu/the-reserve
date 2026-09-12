# Converting a native control to ui-thing

ui-thing is the house default. Any native `<select>`,
`<input type="checkbox">` or `<input type="radio">` still in `app/` is a
**legacy conversion target, not a pattern to copy**. Where that stands on
2026-09-12: every `<select>` is gone (two staff batches, then the public
`/join` field renderer — which keeps its brand styling on top of the
ui-thing controls, see SKILL.md). Native checkboxes remain in nine staff
files (`grep -rn 'type="checkbox"' app | grep -v /Ui/`) and two native
radios in `checkout.vue`; those are the next batches, by type, using the
checklist below.

But a working native control is **inconsistent, not broken**. That single
fact sets the pace: conversion is worth doing carefully and never worth
rushing, because the downside of a sloppy sweep (a filter that stops
filtering, a checkbox that stops checking) is worse than the inconsistency
it removes.

## How to convert

**Either** in reviewed batches **by component type** — all native selects
together, then all checkboxes — so each batch has ONE behavioural risk and
the review question is a single sentence: *"does `v-model` still bind, and
did anything rely on `@change`?"*

**Or** opportunistically, when you are already editing a file for another
reason.

**Never** as one sweeping churn across working screens. A diff that touches
twenty files and four component types cannot be reviewed for behaviour, only
for shape — and behaviour is the entire risk here.

## What to check on each conversion

These are the things that differ. They are reasons to CHECK, not reasons to
avoid converting.

### Native `<select>` → `UiSelect`

- [ ] One element became four (`UiSelect` / `Trigger` / `Content` / `Item`).
- [ ] **`@change` no longer fires.** Anything that hung off it must move to
      `v-model` or a watcher. This is the most common silent breakage.
- [ ] **The value is a string.** Numeric options need `.toString()` out and
      `Number()` back (`Ui/TanStackTable.vue:727`).
- [ ] The `id` your `<label for>` points at now belongs on `UiSelectTrigger`.
- [ ] The empty/placeholder option is a `placeholder` prop, not an
      `<option value="">`.
- [ ] Options carry `value` plus `text` (or a slot) — not element text alone.

### Native checkbox → `UiCheckbox`

- [ ] **Is it bound to an array?** Then it is a `UiCheckboxGroup` with a
      `UiCheckbox :value` per option — the group owns the array. A bare
      `UiCheckbox` has no array behaviour; do not try to fake it with a
      handler per box.
- [ ] `.checked` reads are gone; state lives in `data-state` / `aria-checked`.
- [ ] It no longer participates in implicit form submission.
- [ ] Anything reading state straight after a programmatic click needs to
      wait a tick.

### Anything moving into a dialog or sheet

- [ ] Enter no longer submits — add `@keydown.enter.prevent`.
- [ ] A long body needs `min-h-0 flex-1 overflow-y-auto` in `#content`, or
      the footer scrolls away.

## After converting

Click it. Every one of these differences survives `typecheck` and every unit
test, and shows up only when a person uses the control — which is the same
reason `CLAUDE.md`'s definition-of-done convention exists.

Do it on a **throwaway record**, never live data: driving a sheet with real
clicks once published a stray version on a test form. Do not lean on a
`window.fetch` intercept to keep a supabase-js write off the database — it
does not see supabase-js at all (SKILL.md, trap 4); press no save, or use
a throwaway. And if the driven test goes red, read "Driving the browser
without being fooled" before concluding the converted component is broken
— a stale paint, a still-open listbox, or a mid-check page remount each
produces exactly that picture.
