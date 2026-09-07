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
