---
name: reserve-frontend
description: Build and change UI in The Reserve's house style — ui-thing components and how they differ from the native controls they resemble, the UiVeeInput + useForm pattern, TanStack tables, dialogs and sheets, and the traps that have actually caused regressions here (template auto-unwrap, Enter inside dialogs, size-* on inline elements, UiChip's raw-class color, UiSelect's string values, v-calendar's week anchor, Stripe's Card vs Payment Element). Use this whenever the task touches app/pages/ or app/components/ — including when the user only says "add a screen", "build a form", "add a modal" or dialog, drawer, sheet, dropdown, select, checkbox, table, list, toast, badge, chip, icon, calendar or datepicker; "make this look right", "polish this", "match the rest of the app", "make it responsive", "check it on mobile", "convert this to ui-thing", "why doesn't this render / why is it the wrong size / why doesn't Enter submit", or anything about accessibility, brand colours, or the public-facing join page. Also use it before any UI-consistency pass, and when reviewing frontend code for convention drift — several of these components look like their native equivalents and behave differently in ways that break silently.
---

# The Reserve — frontend

The UI layer is where correctness stops being enforced by Postgres and starts
depending on convention. `can()` gates what the UI *shows*; RLS is what
*enforces* — so a component that renders the wrong thing is a usability bug,
not a security one, and should be fixed calmly rather than urgently. What
this file protects against is different: **components that look like their
native equivalents and do not behave like them.** Those regressions are
silent, survive typecheck, and are found by a person clicking.

| File | Read it when |
| --- | --- |
| `references/components.md` | using any ui-thing component beyond a button |
| `references/conversion.md` | swapping a native control for a ui-thing one |
| `references/tables-and-data.md` | building a TanStack table, or rendering `_cents` / `_at` / `_id` |
| `references/third-party.md` | touching v-calendar, Stripe Elements, or icons |

## The defaults

- **ui-thing is the house default** (`npx ui-thing@latest add <name>`).
  Native controls still in staff pages are LEGACY, not a pattern to copy.
  See `references/conversion.md` for how to move them without churn.
- **lucide icons only** — `<Icon name="lucide:..." />`. No heroicons.
- **The FILE name and the TAG differ.** Nuxt builds the tag from the path
  under `app/components/`, so directory segments concatenate in PascalCase:
  `Ui/TanStackTable.vue` → `<UiTanStackTable>`, `Ui/Vee/Input.vue` →
  `<UiVeeInput>`, `Ui/Select/Item.vue` → `<UiSelectItem>`,
  `Ui/List/Title.vue` → `<UiListTitle>`. Grep for the TAG when checking how
  a component is used and for the FILE when reading how it works — searching
  for the wrong one returns nothing and reads as "this component does not
  exist", which is why the TanStack table's name in particular keeps being
  questioned.
- **Forms use `UiVeeInput` + `useForm`**, not raw `UiInput` with refs. 53
  `UiVeeInput` uses against 37 raw `UiInput`; the wrapper carries the label,
  the required marker and the error message, and binds by `name` to the
  schema (`app/pages/clients/index.vue:127,390`).
- **Zod schemas via `toTypedSchema`**, one schema per form, defined next to
  the `useForm` call.
- **Money is `_cents` integers end to end.** Format at the edge, never store
  or bind a float.

## Two decisions that are capability, not taste

**Checkbox: pick by BINDING TARGET, not by looks.**

- Bound to an **array** (a group of choices, Vue's checkbox-array `v-model`)
  → **native `<input type="checkbox">`**. That array push/remove behaviour is
  a native capability; `UiCheckbox` is a reka-ui `role="checkbox"` button, not
  an input, and does not replicate it cleanly.
  (`app/components/JoinFormField.vue:124-126`)
- A boolean **QUESTION put to a person** ("Are you currently pregnant?")
  → **Yes/No radios, never a lone checkbox**, with neither preselected.
  A single tick box cannot express "no" — it can only fail to express
  "yes" — so the record cannot tell a no from a silence, and a required
  yes/no question becomes unanswerable. This shipped as a bug once.
  (`app/components/JoinFormField.vue:76`)
- A boolean **acknowledgement or toggle** the user either does or does not
  do (consent, a filter flag, a setting) → **`UiCheckbox`**. Unticked
  genuinely means "not done" here, so one box is honest.
  (`app/pages/join/[token].vue:210`)

The behavioural difference is real and bit browser testing in this repo:
`UiCheckbox` has no `.checked`, does not participate in implicit form
submission, and updates asynchronously after `.click()` — reading its state
in the same tick returns the OLD value.

**Public pages may diverge from staff-tool styling; staff tools may not.**

The public form — `app/pages/join/[token].vue` with its field renderer
`app/components/JoinFormField.vue` — is deliberately native-controlled and
brand-styled: larger type and targets, requirements written as the word
"(required)" rather than an asterisk, errors pairing an icon with text, and
the brand purple overriding the app's neutral `--primary`. **Do not "fix"
it to match staff screens** — the divergence is the accessibility
requirement, for readers who are often older, low-vision and not confident
with forms.

Generalising: a public-facing page may diverge from staff styling where
accessibility or brand requires it, and **the divergence must carry a comment
saying so**. Without the comment the next person reads it as drift and
normalises it away. Divergence without a stated reason is drift.

## The traps that have actually bitten

**Refs inside a returned object do NOT auto-unwrap in templates.** Only
top-level setup bindings unwrap. A composable returning `{ set, toggle, has }`
needs `.value` in the template too:

```vue
<!-- app/pages/messages/[[id]].vue:633 — correct, and looks wrong -->
<div v-if="picked.set.value.size > 1">
```

`has()` and `toggle()` are functions, so they read normally — which is what
makes the inconsistency confusing. If a `.size` or `.length` reads as
`undefined` in a template, this is why.

**Enter does not submit inside a dialog.** Dialogs here contain no `<form>`
element, so implicit form submission never fires. Handle it explicitly:

```vue
@keydown.enter.prevent="lookup"
```

(`GiftCardLookup.vue:81`, `AskDock.vue:374`, `forms/index.vue:673`.)

**`size-*` does nothing on an inline element.** Width and height are ignored
until it becomes a block. The unread dot needs `block`:

```vue
<span class="block size-1.5 rounded-full bg-emerald-500" />
```

(`NotificationsBell.vue:196`.) Reach for this when a sized `<span>` renders
at zero or text-height.

**`UiChip`'s `color` takes RAW CLASS STRINGS, not a semantic name.** It is
merged straight into `class` (`Ui/Chip.vue:11,40`), so `color="success"`
silently does nothing:

```vue
color="bg-emerald-500 text-white dark:bg-emerald-400 dark:text-emerald-950"
```

**`UiSelect` values are STRINGS.** It is a compound component
(`Trigger` / `Content` / `Item`), not a drop-in for `<select>`, and it binds
strings. Numbers need converting on both sides — `UiTanStackTable` keeps a
computed purely for this (`Ui/TanStackTable.vue:727`). Full API and the
`text` prop vs slot in `references/components.md`.

## Before you call UI work done

Read `CLAUDE.md`'s definition-of-done convention first — it exists because
this feature shipped three "finished" flows a human could not complete.

- Drive the actual loop in a browser: open the page, click the control, see
  the result. Not "the component renders".
- Check it at `mobile` width. The public pages are used on phones in car parks.
- Nothing conveys meaning by colour alone — pair colour with text or an icon.
- `npx nuxt typecheck` at 0, and the ritual after adding components or
  composables: `npx nuxt prepare` + restart the TS server.
