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

- Bound to an **array** (a group of choices) → **`UiCheckboxGroup`** owning
  the array, with a `UiCheckbox :value="option"` per choice. The group is
  what adds and removes members; a bare `UiCheckbox` on its own has no
  array behaviour, which is why this used to be the one native holdout.
  (`app/components/JoinFormField.vue`, the multiselect branch)
- A boolean **QUESTION put to a person** ("Are you currently pregnant?")
  → **Yes/No radios, never a lone checkbox**, with neither preselected.
  A single tick box cannot express "no" — it can only fail to express
  "yes" — so the record cannot tell a no from a silence, and a required
  yes/no question becomes unanswerable. This shipped as a bug once.
  `UiRadioGroup` values are STRINGS (reka's `AcceptableValue` has no
  boolean), so the component bridges `"yes"`/`"no"` ↔ `true`/`false` in a
  computed and leaves unset as `undefined` — prove the TYPE round-trips
  when you touch it; `false` arriving as anything but boolean false is
  the exact bug above wearing a new coat.
  (`app/components/JoinFormField.vue`, the boolean branch and `yesNo`)
- A boolean **acknowledgement or toggle** the user either does or does not
  do (consent, a filter flag, a setting) → **`UiCheckbox`**. Unticked
  genuinely means "not done" here, so one box is honest.
  (`app/pages/join/[token].vue:210`)

The behavioural difference is real and bit browser testing in this repo:
`UiCheckbox` has no `.checked`, does not participate in implicit form
submission, and updates asynchronously after `.click()` — reading its state
in the same tick returns the OLD value.

Blur for a GROUP (radios, tick boxes): validate on the fieldset's
`focusout` only when `relatedTarget` is outside it, not on each item's
blur — otherwise focusing "Yes" and clicking "No" flashes "please answer"
in between. A `UiSelect` validates when it CLOSES (`@update:open`), never
on the trigger's blur, which fires as the list opens.

**Public pages may diverge from staff-tool styling; staff tools may not.**

The public form — `app/pages/join/[token].vue` with its field renderer
`app/components/JoinFormField.vue` — uses the same ui-thing controls as
the rest of the app (converted 2026-09-12; it was the last native holdout)
but is deliberately brand-styled on top of them (its date field is a
`UiDatepicker` behind a typed input — see `references/third-party.md`):
larger type and targets (`h-11` triggers, `size-5` boxes and radios,
`text-base` items),
requirements written as the word "(required)" rather than an asterisk,
errors pairing an icon with text, and the brand purple overriding the
app's neutral `--primary`. **Do not "fix" it to match staff screens** —
the divergence is the accessibility requirement, for readers who are often
older, low-vision and not confident with forms.

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

### Driving the browser without being fooled

The traps above are silent failures: the product is broken and everything
looks green. Traps 1–3, 5 and 6 here are the inverse, and just as
expensive — **the product is fine and the test says it is broken**, which
sends someone debugging a component that works. The fourth is worse than
either: **the test's safety net is a no-op and the test writes to real
data.** All were paid for on 2026-09-07 while verifying `UiSelect`
conversions: a throwaway form acquired an unrequested v2 (a "Move up" and
a "Publish" fired from misplaced clicks) before the causes were found.
That it was a throwaway is the only reason the live prospect form did not
get a rogue version.

1. **Force a paint before a real click that follows a programmatic
   scroll.** Real (CDP) clicks hit-test against the last PAINTED frame. If
   the pane is hidden or throttled, `el.scrollTop = …` updates layout —
   `getBoundingClientRect()` reports the new position — but nothing
   repaints, and the click lands on whatever was there before the scroll.
   A screenshot (even at `scale: 0.1`) forces the paint. Symptom: JS says
   the trigger is at the coordinate, the click opens a different row.

2. **Confirm no listbox is open before clicking a trigger.** reka-ui's
   dismissable layer treats a click outside an open `SelectContent` as
   "dismiss", so a trigger click while another row's listbox is still open
   closes that one and opens nothing. Check
   `document.querySelectorAll('[role="listbox"][data-state="open"]').length === 0`
   first. Symptom: `aria-expanded` stays `false` after a click that worked
   on the previous row.

3. **Run a browser verification as ONE continuous batch, never
   stepwise across turns.** The Supabase session refresh can remount the
   page at any moment — it fired twice mid-verification on 2026-09-07 — and
   a remount wipes everything held in the page: a `window.fetch` override,
   an open sheet, a half-edited draft, `creating` state. A stepwise check
   that does not notice the remount then reads its "result" from a fresh
   page and concludes the feature is broken (or, worse, that its own setup
   never happened). Put setup, action and assertion in a single
   `browser_batch`, and have the assertion also report something that
   proves it is still the same page — the override marker, the dialog
   being open, `location.pathname`. Symptom: state that was verifiably set
   a moment ago reads as never having existed.

4. **A `window.fetch` override does NOT intercept supabase-js. Your
   isolation can silently be a no-op.** supabase-js captures its own
   `fetch` reference when the client is created, so overriding
   `window.fetch` afterwards catches our own `/api/...` routes (`$fetch`,
   `useFetch`) and **nothing that goes through `useSupabaseClient()`** —
   every direct PostgREST read and write sails past it. The danger is not
   the missed request; it is the false belief. A test that installs an
   intercept "so the save can't land", then presses Save, has just
   written to real data while its log shows nothing happened. Proved
   2026-09-07: an intercept installed before the services edit dialog
   opened logged zero `/rest/v1/` calls while the page was plainly
   fetching through supabase-js.

   The rule: to exercise a flow that writes via supabase-js without
   touching the database, **do not trust an intercept.** Either drive
   everything up to the write and then **do not press the button**,
   reading the bound state that the payload is built from (the value
   `services.vue:196` reads is `categoryId.value` — assert that) and
   **reading the database back** to confirm zero rows changed; or run the
   whole flow on a **throwaway record** you created and will delete.
   Interception is fine for our own routes, and only for them — and even
   there, verify the intercept caught something before relying on it
   (`window.__reqs` logging the expected call is the check).

5. **Screenshot pixels are not CSS pixels in the pane.** The screenshot
   frame (e.g. 800×949) is the CSS viewport (e.g. 775×920) scaled by
   ~1.03. Coordinates measured with `getBoundingClientRect()` and clicked
   as-is land ~25px high and left — enough to miss a 44px input, open the
   wrong control, or tick the first item of a group you never aimed at
   (all three happened on 2026-09-12). Either click at coordinates read
   FROM a screenshot, or multiply measured CSS coordinates by
   `frame / innerWidth` and `frame / innerHeight` before clicking.

6. **The pane's `key` action does not activate buttons for Space or
   Return.** Those presses arrive with `e.key === ""`, so the browser never
   synthesises the button's click — a keyboard-activation test reads as
   "the button does nothing" while the component is fine (a datepicker
   button "failed" this way on 2026-09-12; `Tab` and `Escape` do work).
   To test keyboard activation, dispatch a coordinate-less `el.click()` —
   that IS what keyboard activation produces (`detail: 0`, `clientX: 0`)
   — and confirm with a capturing `click` listener that the event reached
   the element.

Two related facts from the same session: synthetic `pointerdown` can open
a reka-ui layer but leaves its stack inconsistent (body keeps
`pointer-events: none`; only a reload clears it), so open with REAL input;
and a `<button role="checkbox">` updates on the next tick, so read its
state after `await`, not in the same tick as the click. When a real-input
test fails, rule traps 1–3, 5 and 6 out before touching the component;
when a test is "safe", rule the fourth out before pressing anything.
