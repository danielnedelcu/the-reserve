# public.clients

## Description

Spa clients (no auth accounts). no_show_count is maintained by trigger from appointment status changes. flags is an extensible jsonb for operational booleans (requires_card_on_file).

## Columns

| Name                     | Type                     | Default           | Nullable | Children                                                                                    | Parents                                         | Comment                                                                                |
| ------------------------ | ------------------------ | ----------------- | -------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| id                       | uuid                     | gen_random_uuid() | false    | [public.client_notes](public.client_notes.md) [public.appointments](public.appointments.md) |                                                 |                                                                                        |
| organization_id          | uuid                     |                   | false    |                                                                                             | [public.organizations](public.organizations.md) |                                                                                        |
| first_name               | text                     |                   | false    |                                                                                             |                                                 |                                                                                        |
| last_name                | text                     |                   | false    |                                                                                             |                                                 |                                                                                        |
| email                    | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| phone                    | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| date_of_birth            | date                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| referral_source          | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| no_show_count            | integer                  | 0                 | false    |                                                                                             |                                                 |                                                                                        |
| flags                    | jsonb                    | '{}'::jsonb       | false    |                                                                                             |                                                 | Operational booleans, extendable without migrations. Known keys: requires_card_on_file |
| active                   | boolean                  | true              | false    |                                                                                             |                                                 |                                                                                        |
| created_at               | timestamp with time zone | now()             | false    |                                                                                             |                                                 |                                                                                        |
| updated_at               | timestamp with time zone | now()             | false    |                                                                                             |                                                 |                                                                                        |
| pronouns                 | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| address_line1            | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| address_line2            | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| city                     | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| state                    | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| postal_code              | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| emergency_contact_name   | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| emergency_contact_phone  | text                     |                   | true     |                                                                                             |                                                 |                                                                                        |
| preferred_contact_method | text                     | 'email'::text     | false    |                                                                                             |                                                 |                                                                                        |
| marketing_opt_in         | boolean                  | false             | false    |                                                                                             |                                                 |                                                                                        |
| marketing_opt_in_at      | timestamp with time zone |                   | true     |                                                                                             |                                                 |                                                                                        |
| preferred_staff_id       | uuid                     |                   | true     |                                                                                             | [public.staff](public.staff.md)                 |                                                                                        |

## Constraints

| Name                                   | Type        | Definition                                                                                  |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| clients_preferred_contact_method_check | CHECK       | CHECK ((preferred_contact_method = ANY (ARRAY['email'::text, 'phone'::text, 'sms'::text]))) |
| clients_organization_id_fkey           | FOREIGN KEY | FOREIGN KEY (organization_id) REFERENCES organizations(id)                                  |
| clients_preferred_staff_id_fkey        | FOREIGN KEY | FOREIGN KEY (preferred_staff_id) REFERENCES staff(id)                                       |
| clients_pkey                           | PRIMARY KEY | PRIMARY KEY (id)                                                                            |

## Indexes

| Name              | Definition                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| clients_pkey      | CREATE UNIQUE INDEX clients_pkey ON public.clients USING btree (id)                                  |
| clients_org_name  | CREATE INDEX clients_org_name ON public.clients USING btree (organization_id, last_name, first_name) |
| clients_org_email | CREATE INDEX clients_org_email ON public.clients USING btree (organization_id, lower(email))         |

## Triggers

| Name              | Definition                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| trg_clients_touch | CREATE TRIGGER trg_clients_touch BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION touch_updated_at() |

## Relations

![er](public.clients.svg)

---

> Generated by [tbls](https://github.com/k1LoW/tbls)
