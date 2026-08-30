# postgres

## Tables

| Name                                                                            | Columns | Comment                                                                                                                                                                                                                                                                                                                                    | Type       |
| ------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| [public.organizations](public.organizations.md)                                 | 5       | Tenant root. Single row today; every domain table hangs off organization_id for future multi-tenancy.                                                                                                                                                                                                                                      | BASE TABLE |
| [public.locations](public.locations.md)                                         | 14      |                                                                                                                                                                                                                                                                                                                                            | BASE TABLE |
| [public.staff](public.staff.md)                                                 | 21      | Employees. Linked 1:1 to auth.users via user_id. Deactivated (active=false), never deleted. Self-editable personal fields are guarded by trg_guard_staff_self_update.                                                                                                                                                                      | BASE TABLE |
| [public.staff_locations](public.staff_locations.md)                             | 2       |                                                                                                                                                                                                                                                                                                                                            | BASE TABLE |
| [public.roles](public.roles.md)                                                 | 4       | Role definitions. system=true rows (super_admin, admin, front_desk, provider) cannot be deleted.                                                                                                                                                                                                                                           | BASE TABLE |
| [public.permissions](public.permissions.md)                                     | 2       | Permission catalog: domain.action(.own|.any) keys. Seeded in migration 1; code references keys as strings.                                                                                                                                                                                                                                 | BASE TABLE |
| [public.role_permissions](public.role_permissions.md)                           | 2       | The permission matrix as data. Changing a row changes app behavior everywhere with zero deploys.                                                                                                                                                                                                                                           | BASE TABLE |
| [public.staff_roles](public.staff_roles.md)                                     | 2       | Role assignments. Audit-logged by trigger; last-super-admin removal blocked by trigger.                                                                                                                                                                                                                                                    | BASE TABLE |
| [public.audit_log](public.audit_log.md)                                         | 8       | Append-only. Inserts via service role / security-definer functions only. Includes health_note.viewed (app-layer, since SELECTs cannot fire triggers), appointment.booked, staff lifecycle events.                                                                                                                                          | BASE TABLE |
| [public.staff_invites](public.staff_invites.md)                                 | 13      | Tokenized invites (7-day expiry). Accepted atomically by accept_staff_invite() — service-role only. Partial unique index prevents duplicate pending invites per email.                                                                                                                                                                     | BASE TABLE |
| [public.service_categories](public.service_categories.md)                       | 5       | Menu grouping (Massage, Facials, ...).                                                                                                                                                                                                                                                                                                     | BASE TABLE |
| [public.services](public.services.md)                                           | 13      | The treatment catalog. duration_minutes is client-facing; buffers extend the blocked window. Prices in cents. requires_intake gates booking once intake forms exist. Deactivated, never deleted.                                                                                                                                           | BASE TABLE |
| [public.resource_types](public.resource_types.md)                               | 3       | Room categories services require (Massage Room, Facial Room, ...).                                                                                                                                                                                                                                                                         | BASE TABLE |
| [public.resources](public.resources.md)                                         | 6       | Concrete rooms per location. Inactive rooms leave bookable inventory immediately.                                                                                                                                                                                                                                                          | BASE TABLE |
| [public.service_resource_requirements](public.service_resource_requirements.md) | 2       | Service -> room TYPE requirement; a concrete free room of the type is assigned at booking.                                                                                                                                                                                                                                                 | BASE TABLE |
| [public.service_staff](public.service_staff.md)                                 | 5       | Qualification: who may perform what, with optional per-staff duration/price overrides that the slot and booking routes apply.                                                                                                                                                                                                              | BASE TABLE |
| [public.clients](public.clients.md)                                             | 26      | Spa clients (no auth accounts). no_show_count is maintained by trigger from appointment status changes. flags is an extensible jsonb for operational booleans (requires_card_on_file).                                                                                                                                                     | BASE TABLE |
| [public.client_notes](public.client_notes.md)                                   | 6       | Tiered notes: preference | internal | health. HEALTH notes are RLS-gated to clients.notes.health.view and must be read through the audited server route (reads cannot fire triggers, so auditing lives at the app layer). Append-only.                                                                                                     | BASE TABLE |
| [public.availability_rules](public.availability_rules.md)                       | 9       | Recurring weekly hours in LOCATION-LOCAL time (survives DST). Overlaps per staff/day are impossible: no_overlapping_hours exclusion constraint (timerange custom type).                                                                                                                                                                    | BASE TABLE |
| [public.availability_exceptions](public.availability_exceptions.md)             | 9       | Time off / sick / breaks (remove availability) and extra shifts (add it). requested -> approved/denied workflow; decisions notify the subject and new requests notify approvers via triggers.                                                                                                                                              | BASE TABLE |
| [public.appointments](public.appointments.md)                                   | 18      | Never deleted — status lifecycle only (booked→confirmed→checked_in→in_progress→completed | cancelled | no_show). Double-booking of staff or rooms is impossible: gist exclusion constraints on the blocked window, which ignore cancelled/no_show rows so slots free themselves.                                                           | BASE TABLE |
| [public.appointment_services](public.appointment_services.md)                   | 7       | Line items with name/price/duration SNAPSHOTS taken at booking: catalog edits never rewrite booked history.                                                                                                                                                                                                                                | BASE TABLE |
| [public.notifications](public.notifications.md)                                 | 8       | In-app notifications. Created ONLY by triggers/service role (no authenticated insert policy). RLS scopes reads and mark-read to the recipient — including over Realtime, which is published for this table.                                                                                                                                | BASE TABLE |
| [public.products](public.products.md)                                           | 12      | Retail catalog (lotions, candles, ...). Stock decremented by trigger on sale. cost_cents enables margin reporting. Deactivated, never deleted.                                                                                                                                                                                             | BASE TABLE |
| [public.gift_cards](public.gift_cards.md)                                       | 10      | Balance maintained by triggers: created/loaded by a gift_card SALE item, decremented by a gift_card PAYMENT. Balance can never go negative (trigger).                                                                                                                                                                                      | BASE TABLE |
| [public.transactions](public.transactions.md)                                   | 14      | The immutable money ledger: one row per checkout. NEVER updated or deleted (no policies exist). Refunds are new rows with negative amounts referencing the original via refunds_transaction_id. All financial reporting reads from here.                                                                                                   | BASE TABLE |
| [public.transaction_items](public.transaction_items.md)                         | 14      | Line items with name/price SNAPSHOTS (catalog edits never rewrite sold history). kind=service carries appointment + staff attribution; kind=tip carries staff attribution for payroll reads; kind=discount is negative; kind=gift_card is a liability sale, excluded from revenue reporting.                                               | BASE TABLE |
| [public.payments](public.payments.md)                                           | 8       | How each transaction settled. Multiple rows = split tender ("$80 gift card + rest on card"). card_external = charged on the spa's existing physical terminal and recorded here; in-app charging arrives with Stripe (4b).                                                                                                                  | BASE TABLE |
| [public.conversations](public.conversations.md)                                 | 7       | DMs and ad-hoc group chats. updated_at is bumped by every message (list sort key). Append-only messaging: no edit/delete in v1.                                                                                                                                                                                                            | BASE TABLE |
| [public.conversation_participants](public.conversation_participants.md)         | 4       | Membership + read state. last_read_at is the unread mechanism: unread = messages newer than it. Rows are created only by the conversation functions (security definer).                                                                                                                                                                    | BASE TABLE |
| [public.messages](public.messages.md)                                           | 5       | Append-only (no update/delete policies). Org-scoped through the parent conversation (transaction_items precedent). Published to realtime; RLS limits delivery to participants.                                                                                                                                                             | BASE TABLE |
| [public.card_consents](public.card_consents.md)                                 | 7       | Consent records for storing a card on file (cancellation-fee enabler). Append-only: no update/delete policies. method=front_desk_attested is v1; client_signed arrives with intake forms. policy_text is a snapshot of the exact language shown at capture.                                                                                | BASE TABLE |
| [public.client_payment_methods](public.client_payment_methods.md)               | 11      | Display-fields-only mirror of Stripe PaymentMethods (pm_...). consent_id is NOT NULL: no card exists without a consent record. Detached/expired cards are deactivated (active=false), never deleted — historical payments may reference them.                                                                                              | BASE TABLE |
| [public.stripe_events](public.stripe_events.md)                                 | 3       | Processed Stripe webhook event ids for idempotency. Insert-on-arrival; unique violation = duplicate delivery, skip. Service-role only (no policies).                                                                                                                                                                                       | BASE TABLE |
| [public.ask_queries](public.ask_queries.md)                                     | 11      | Append-only record of every Ask The Reserve question: the text asked, the SQL that ran, and what came back. No update/delete policies — a query log that can be edited is not a query log. Written by the /api/ask route; readable with ask.query. Rows with a non-null error are failed generations, which is the signal for prompt work. | BASE TABLE |

## Stored procedures and functions

| Name                                         | ReturnType     | Arguments                                                                                         | Type     |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- | -------- |
| public.current_staff_id                      | uuid           |                                                                                                   | FUNCTION |
| public.current_org_id                        | uuid           |                                                                                                   | FUNCTION |
| public.has_permission                        | bool           | perm text                                                                                         | FUNCTION |
| public.prevent_last_super_admin_removal      | trigger        |                                                                                                   | FUNCTION |
| public.accept_staff_invite                   | uuid           | invite_token uuid, new_user_id uuid, final_display_name text, final_title text DEFAULT NULL::text | FUNCTION |
| public.count_other_active_super_admins       | int4           | org uuid, excluded_staff uuid                                                                     | FUNCTION |
| public.prevent_last_super_admin_deactivation | trigger        |                                                                                                   | FUNCTION |
| public.prevent_system_role_deletion          | trigger        |                                                                                                   | FUNCTION |
| public.audit_staff_role_change               | trigger        |                                                                                                   | FUNCTION |
| public.get_my_permissions                    | text           |                                                                                                   | FUNCTION |
| public.touch_updated_at                      | trigger        |                                                                                                   | FUNCTION |
| public.gbtreekey4_in                         | gbtreekey4     | cstring                                                                                           | FUNCTION |
| public.gbtreekey4_out                        | cstring        | gbtreekey4                                                                                        | FUNCTION |
| public.gbtreekey8_in                         | gbtreekey8     | cstring                                                                                           | FUNCTION |
| public.gbtreekey8_out                        | cstring        | gbtreekey8                                                                                        | FUNCTION |
| public.gbtreekey16_in                        | gbtreekey16    | cstring                                                                                           | FUNCTION |
| public.gbtreekey16_out                       | cstring        | gbtreekey16                                                                                       | FUNCTION |
| public.gbtreekey32_in                        | gbtreekey32    | cstring                                                                                           | FUNCTION |
| public.gbtreekey32_out                       | cstring        | gbtreekey32                                                                                       | FUNCTION |
| public.gbtreekey_var_in                      | gbtreekey_var  | cstring                                                                                           | FUNCTION |
| public.gbtreekey_var_out                     | cstring        | gbtreekey_var                                                                                     | FUNCTION |
| public.cash_dist                             | money          | money, money                                                                                      | FUNCTION |
| public.date_dist                             | int4           | date, date                                                                                        | FUNCTION |
| public.float4_dist                           | float4         | real, real                                                                                        | FUNCTION |
| public.float8_dist                           | float8         | double precision, double precision                                                                | FUNCTION |
| public.int2_dist                             | int2           | smallint, smallint                                                                                | FUNCTION |
| public.int4_dist                             | int4           | integer, integer                                                                                  | FUNCTION |
| public.int8_dist                             | int8           | bigint, bigint                                                                                    | FUNCTION |
| public.interval_dist                         | interval       | interval, interval                                                                                | FUNCTION |
| public.oid_dist                              | oid            | oid, oid                                                                                          | FUNCTION |
| public.time_dist                             | interval       | time without time zone, time without time zone                                                    | FUNCTION |
| public.ts_dist                               | interval       | timestamp without time zone, timestamp without time zone                                          | FUNCTION |
| public.tstz_dist                             | interval       | timestamp with time zone, timestamp with time zone                                                | FUNCTION |
| public.gbt_oid_consistent                    | bool           | internal, oid, smallint, oid, internal                                                            | FUNCTION |
| public.gbt_oid_distance                      | float8         | internal, oid, smallint, oid, internal                                                            | FUNCTION |
| public.gbt_oid_fetch                         | internal       | internal                                                                                          | FUNCTION |
| public.gbt_oid_compress                      | internal       | internal                                                                                          | FUNCTION |
| public.gbt_decompress                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_var_decompress                    | internal       | internal                                                                                          | FUNCTION |
| public.gbt_var_fetch                         | internal       | internal                                                                                          | FUNCTION |
| public.gbt_oid_penalty                       | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_oid_picksplit                     | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_oid_union                         | gbtreekey8     | internal, internal                                                                                | FUNCTION |
| public.gbt_oid_same                          | internal       | gbtreekey8, gbtreekey8, internal                                                                  | FUNCTION |
| public.gbt_int2_consistent                   | bool           | internal, smallint, smallint, oid, internal                                                       | FUNCTION |
| public.gbt_int2_distance                     | float8         | internal, smallint, smallint, oid, internal                                                       | FUNCTION |
| public.gbt_int2_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_int2_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_int2_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_int2_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_int2_union                        | gbtreekey4     | internal, internal                                                                                | FUNCTION |
| public.gbt_int2_same                         | internal       | gbtreekey4, gbtreekey4, internal                                                                  | FUNCTION |
| public.gbt_int4_consistent                   | bool           | internal, integer, smallint, oid, internal                                                        | FUNCTION |
| public.gbt_int4_distance                     | float8         | internal, integer, smallint, oid, internal                                                        | FUNCTION |
| public.gbt_int4_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_int4_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_int4_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_int4_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_int4_union                        | gbtreekey8     | internal, internal                                                                                | FUNCTION |
| public.gbt_int4_same                         | internal       | gbtreekey8, gbtreekey8, internal                                                                  | FUNCTION |
| public.gbt_int8_consistent                   | bool           | internal, bigint, smallint, oid, internal                                                         | FUNCTION |
| public.gbt_int8_distance                     | float8         | internal, bigint, smallint, oid, internal                                                         | FUNCTION |
| public.gbt_int8_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_int8_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_int8_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_int8_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_int8_union                        | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_int8_same                         | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_float4_consistent                 | bool           | internal, real, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_float4_distance                   | float8         | internal, real, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_float4_compress                   | internal       | internal                                                                                          | FUNCTION |
| public.gbt_float4_fetch                      | internal       | internal                                                                                          | FUNCTION |
| public.gbt_float4_penalty                    | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_float4_picksplit                  | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_float4_union                      | gbtreekey8     | internal, internal                                                                                | FUNCTION |
| public.gbt_float4_same                       | internal       | gbtreekey8, gbtreekey8, internal                                                                  | FUNCTION |
| public.gbt_float8_consistent                 | bool           | internal, double precision, smallint, oid, internal                                               | FUNCTION |
| public.gbt_float8_distance                   | float8         | internal, double precision, smallint, oid, internal                                               | FUNCTION |
| public.gbt_float8_compress                   | internal       | internal                                                                                          | FUNCTION |
| public.gbt_float8_fetch                      | internal       | internal                                                                                          | FUNCTION |
| public.gbt_float8_penalty                    | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_float8_picksplit                  | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_float8_union                      | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_float8_same                       | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_ts_consistent                     | bool           | internal, timestamp without time zone, smallint, oid, internal                                    | FUNCTION |
| public.gbt_ts_distance                       | float8         | internal, timestamp without time zone, smallint, oid, internal                                    | FUNCTION |
| public.gbt_tstz_consistent                   | bool           | internal, timestamp with time zone, smallint, oid, internal                                       | FUNCTION |
| public.gbt_tstz_distance                     | float8         | internal, timestamp with time zone, smallint, oid, internal                                       | FUNCTION |
| public.gbt_ts_compress                       | internal       | internal                                                                                          | FUNCTION |
| public.gbt_tstz_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_ts_fetch                          | internal       | internal                                                                                          | FUNCTION |
| public.gbt_ts_penalty                        | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_ts_picksplit                      | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_ts_union                          | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_ts_same                           | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_time_consistent                   | bool           | internal, time without time zone, smallint, oid, internal                                         | FUNCTION |
| public.gbt_time_distance                     | float8         | internal, time without time zone, smallint, oid, internal                                         | FUNCTION |
| public.gbt_timetz_consistent                 | bool           | internal, time with time zone, smallint, oid, internal                                            | FUNCTION |
| public.gbt_time_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_timetz_compress                   | internal       | internal                                                                                          | FUNCTION |
| public.gbt_time_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_time_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_time_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_time_union                        | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_time_same                         | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_date_consistent                   | bool           | internal, date, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_date_distance                     | float8         | internal, date, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_date_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_date_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_date_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_date_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_date_union                        | gbtreekey8     | internal, internal                                                                                | FUNCTION |
| public.gbt_date_same                         | internal       | gbtreekey8, gbtreekey8, internal                                                                  | FUNCTION |
| public.gbt_intv_consistent                   | bool           | internal, interval, smallint, oid, internal                                                       | FUNCTION |
| public.gbt_intv_distance                     | float8         | internal, interval, smallint, oid, internal                                                       | FUNCTION |
| public.gbt_intv_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_intv_decompress                   | internal       | internal                                                                                          | FUNCTION |
| public.gbt_intv_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_intv_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_intv_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_intv_union                        | gbtreekey32    | internal, internal                                                                                | FUNCTION |
| public.gbt_intv_same                         | internal       | gbtreekey32, gbtreekey32, internal                                                                | FUNCTION |
| public.gbt_cash_consistent                   | bool           | internal, money, smallint, oid, internal                                                          | FUNCTION |
| public.gbt_cash_distance                     | float8         | internal, money, smallint, oid, internal                                                          | FUNCTION |
| public.gbt_cash_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_cash_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_cash_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_cash_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_cash_union                        | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_cash_same                         | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_macad_consistent                  | bool           | internal, macaddr, smallint, oid, internal                                                        | FUNCTION |
| public.gbt_macad_compress                    | internal       | internal                                                                                          | FUNCTION |
| public.gbt_macad_fetch                       | internal       | internal                                                                                          | FUNCTION |
| public.gbt_macad_penalty                     | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_macad_picksplit                   | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_macad_union                       | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_macad_same                        | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_text_consistent                   | bool           | internal, text, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_bpchar_consistent                 | bool           | internal, character, smallint, oid, internal                                                      | FUNCTION |
| public.gbt_text_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_bpchar_compress                   | internal       | internal                                                                                          | FUNCTION |
| public.gbt_text_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_text_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_text_union                        | gbtreekey_var  | internal, internal                                                                                | FUNCTION |
| public.gbt_text_same                         | internal       | gbtreekey_var, gbtreekey_var, internal                                                            | FUNCTION |
| public.gbt_bytea_consistent                  | bool           | internal, bytea, smallint, oid, internal                                                          | FUNCTION |
| public.gbt_bytea_compress                    | internal       | internal                                                                                          | FUNCTION |
| public.gbt_bytea_penalty                     | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_bytea_picksplit                   | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_bytea_union                       | gbtreekey_var  | internal, internal                                                                                | FUNCTION |
| public.gbt_bytea_same                        | internal       | gbtreekey_var, gbtreekey_var, internal                                                            | FUNCTION |
| public.gbt_numeric_consistent                | bool           | internal, numeric, smallint, oid, internal                                                        | FUNCTION |
| public.gbt_numeric_compress                  | internal       | internal                                                                                          | FUNCTION |
| public.gbt_numeric_penalty                   | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_numeric_picksplit                 | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_numeric_union                     | gbtreekey_var  | internal, internal                                                                                | FUNCTION |
| public.gbt_numeric_same                      | internal       | gbtreekey_var, gbtreekey_var, internal                                                            | FUNCTION |
| public.gbt_bit_consistent                    | bool           | internal, bit, smallint, oid, internal                                                            | FUNCTION |
| public.gbt_bit_compress                      | internal       | internal                                                                                          | FUNCTION |
| public.gbt_bit_penalty                       | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_bit_picksplit                     | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_bit_union                         | gbtreekey_var  | internal, internal                                                                                | FUNCTION |
| public.gbt_bit_same                          | internal       | gbtreekey_var, gbtreekey_var, internal                                                            | FUNCTION |
| public.gbt_inet_consistent                   | bool           | internal, inet, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_inet_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_inet_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_inet_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_inet_union                        | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_inet_same                         | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_uuid_consistent                   | bool           | internal, uuid, smallint, oid, internal                                                           | FUNCTION |
| public.gbt_uuid_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_uuid_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_uuid_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_uuid_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_uuid_union                        | gbtreekey32    | internal, internal                                                                                | FUNCTION |
| public.gbt_uuid_same                         | internal       | gbtreekey32, gbtreekey32, internal                                                                | FUNCTION |
| public.gbt_macad8_consistent                 | bool           | internal, macaddr8, smallint, oid, internal                                                       | FUNCTION |
| public.gbt_macad8_compress                   | internal       | internal                                                                                          | FUNCTION |
| public.gbt_macad8_fetch                      | internal       | internal                                                                                          | FUNCTION |
| public.gbt_macad8_penalty                    | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_macad8_picksplit                  | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_macad8_union                      | gbtreekey16    | internal, internal                                                                                | FUNCTION |
| public.gbt_macad8_same                       | internal       | gbtreekey16, gbtreekey16, internal                                                                | FUNCTION |
| public.gbt_enum_consistent                   | bool           | internal, anyenum, smallint, oid, internal                                                        | FUNCTION |
| public.gbt_enum_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_enum_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_enum_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_enum_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_enum_union                        | gbtreekey8     | internal, internal                                                                                | FUNCTION |
| public.gbt_enum_same                         | internal       | gbtreekey8, gbtreekey8, internal                                                                  | FUNCTION |
| public.gbtreekey2_in                         | gbtreekey2     | cstring                                                                                           | FUNCTION |
| public.gbtreekey2_out                        | cstring        | gbtreekey2                                                                                        | FUNCTION |
| public.gbt_bool_consistent                   | bool           | internal, boolean, smallint, oid, internal                                                        | FUNCTION |
| public.gbt_bool_compress                     | internal       | internal                                                                                          | FUNCTION |
| public.gbt_bool_fetch                        | internal       | internal                                                                                          | FUNCTION |
| public.gbt_bool_penalty                      | internal       | internal, internal, internal                                                                      | FUNCTION |
| public.gbt_bool_picksplit                    | internal       | internal, internal                                                                                | FUNCTION |
| public.gbt_bool_union                        | gbtreekey2     | internal, internal                                                                                | FUNCTION |
| public.gbt_bool_same                         | internal       | gbtreekey2, gbtreekey2, internal                                                                  | FUNCTION |
| public.maintain_no_show_count                | trigger        |                                                                                                   | FUNCTION |
| public.timerange                             | timerange      | time without time zone, time without time zone                                                    | FUNCTION |
| public.timerange                             | timerange      | time without time zone, time without time zone, text                                              | FUNCTION |
| public.timemultirange                        | timemultirange |                                                                                                   | FUNCTION |
| public.timemultirange                        | timemultirange | timerange                                                                                         | FUNCTION |
| public.timemultirange                        | timemultirange | VARIADIC timerange[]                                                                              | FUNCTION |
| public.notify_timeoff_decision               | trigger        |                                                                                                   | FUNCTION |
| public.notify_timeoff_requested              | trigger        |                                                                                                   | FUNCTION |
| public.guard_staff_self_update               | trigger        |                                                                                                   | FUNCTION |
| public.apply_gift_card_payment               | trigger        |                                                                                                   | FUNCTION |
| public.apply_product_sale                    | trigger        |                                                                                                   | FUNCTION |
| public.is_conversation_participant           | bool           | p_conversation_id uuid                                                                            | FUNCTION |
| public.find_or_create_dm                     | uuid           | p_other_staff_id uuid                                                                             | FUNCTION |
| public.create_group_conversation             | uuid           | p_name text, p_staff_ids uuid[]                                                                   | FUNCTION |
| public.mark_conversation_read                | void           | p_conversation_id uuid                                                                            | FUNCTION |
| public.message_bumps_conversation            | trigger        |                                                                                                   | FUNCTION |
| public.notify_message_received               | trigger        |                                                                                                   | FUNCTION |
| public.leave_conversation                    | void           | p_conversation_id uuid                                                                            | FUNCTION |

## Enums

| Name | Values |
| ---- | ------- |
| auth.aal_level | aal1, aal2, aal3 |
| auth.code_challenge_method | plain, s256 |
| auth.factor_status | unverified, verified |
| auth.factor_type | phone, totp, webauthn |
| auth.oauth_authorization_status | approved, denied, expired, pending |
| auth.oauth_client_type | confidential, public |
| auth.oauth_registration_type | dynamic, manual |
| auth.oauth_response_type | code |
| auth.one_time_token_type | confirmation_token, email_change_token_current, email_change_token_new, phone_change_token, reauthentication_token, recovery_token |
| realtime.action | DELETE, ERROR, INSERT, TRUNCATE, UPDATE |
| realtime.equality_op | eq, gt, gte, ilike, imatch, in, is, isdistinct, like, lt, lte, match, neq |
| storage.buckettype | ANALYTICS, STANDARD, VECTOR |

## Relations

![er](schema.svg)

---

> Generated by [tbls](https://github.com/k1LoW/tbls)
