# Third-party components, and the decisions already made about them

## v-calendar — the weekly view anchors to the FIRST attribute

`@yuta-inoue-ph/nuxt-vcalendar`, wrapped by `UiCalendar` / `UiDatepicker`.

Its weekly view opens on the week of the **first attribute in the array** —
not on today, and not on the current month. A calendar fed appointments
therefore opens on the OLDEST appointment's week, which looks like a loading
bug and is not one.

The fix in place is an invisible anchor attribute for today, `unshift`ed so
it sits at array position 0:

```ts
// LOAD-BEARING: v-calendar's weekly view opens on the FIRST attribute's week.
// This invisible anchor must be unshifted LAST (array position 0) so the
// calendar opens on today instead of the oldest appointment's week.
```
(`app/components/dashboard/WeekCalendar.vue:81-86`)

If you rebuild that attributes array, **keep the anchor first**. Sorting the
array, or appending the anchor instead of unshifting it, silently
reintroduces the bug — the calendar still renders, just on the wrong week.

## v-calendar as a single-date field — type first, pick second

`UiDatepicker` without `.range` is a plain date field. The public form's
date answers (`app/components/JoinFormField.vue`, the `date` branch) are
the reference:

- **Bind through the shared bridge.** The picker speaks `Date`; the form
  contract, the Zod schema and the server speak `"YYYY-MM-DD"`.
  `dateKey` / `parseDateKey` in `shared/forms/fields.ts` are the ONLY
  formatter and parser allowed between them — `dateKey` is
  `toLocaleDateString("en-CA")`, never `toISOString()` (UTC lands on the
  wrong day in the evening), and `tests/shared/formValidation.test.ts`
  asserts every key it emits passes the server's `isRealDate`, leap days
  and year-ends included.
- **Give the person an input, not only a calendar.** For a date of birth
  the target is decades back; paging a calendar month by month is not an
  answer. Use the default slot's `inputValue` + `inputEvents` on a
  `UiInput` with `masks.input = 'MM/DD/YYYY'`, and put the calendar behind
  a button that calls `togglePopover({ target: $event.currentTarget })`.
  Bind only `input`/`change`/`keyup` from `inputEvents`: the slot's
  `click` would open the calendar on top of a phone keyboard.
- **Validate on `popover-did-hide` and the input's blur**, the two moments
  the person is done with it.
- The picker renders inside `<ClientOnly>`; there is no SSR fallback, so
  the field appears on hydration.

## Stripe — classic Card Element, NOT Payment Element

```ts
const cardElement = elements.create("card"); // plain card input — no Link, no wallets
```
(`app/components/ClientCards.vue:89`)

Payment Element drags in Link and wallet options. For a card being entered
**by staff, on the client's behalf, at the front desk**, those are wrong:
they prompt for a consumer login, offer payment methods the desk cannot use,
and confuse a flow whose entire purpose is capturing a card on file with
consent.

Do not "upgrade" this to Payment Element because it is the newer API. The
choice is about who is standing at the keyboard.

Card save/charge/refund all go through server routes under the service role;
the client never prices anything (`CLAUDE.md`, money rules).

## Icons — lucide only

`<Icon name="lucide:bell" class="size-4" aria-hidden="true" />`

- `aria-hidden="true"` whenever the icon sits beside text that already says
  it — otherwise a screen reader reads it twice.
- An icon that is the ONLY content of a control needs an `aria-label` on the
  control (`NotificationsBell.vue:113-117`).
- No heroicons. Mixing icon sets is visible at a glance in a toolbar.

## Supabase realtime in components

RLS applies to sockets, so a subscription only ever delivers rows the viewer
could already read — the channel needs no filtering of its own for access.

Always `removeChannel` on unmount. The house pattern keeps the channel in a
module-scope variable and tears it down in `onUnmounted`:

```ts
if (channel) supabase.removeChannel(channel);
```
(`NotificationsBell.vue:60`, `pages/messages/[[id]].vue:233-234`)

A component that subscribes without tearing down leaks a channel per
navigation, and the handlers stack — the symptom is a toast or a refetch
firing two, then three, then four times for one event.
