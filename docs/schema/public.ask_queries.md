# public.ask_queries

## Description

Append-only record of every Ask The Reserve question: the text asked, the SQL that ran, and what came back. No update/delete policies — a query log that can be edited is not a query log. Written by the /api/ask route; readable with ask.query. Rows with a non-null error are failed generations, which is the signal for prompt work.

## Columns

| Name            | Type                     | Default           | Nullable | Children | Parents                                         | Comment                                                                                                                                                                    |
| --------------- | ------------------------ | ----------------- | -------- | -------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id              | uuid                     | gen_random_uuid() | false    |          |                                                 |                                                                                                                                                                            |
| organization_id | uuid                     |                   | false    |          | [public.organizations](public.organizations.md) |                                                                                                                                                                            |
| staff_id        | uuid                     |                   | false    |          | [public.staff](public.staff.md)                 |                                                                                                                                                                            |
| source          | text                     |                   | false    |          |                                                 |                                                                                                                                                                            |
| preset_id       | text                     |                   | true     |          |                                                 |                                                                                                                                                                            |
| question        | text                     |                   | true     |          |                                                 |                                                                                                                                                                            |
| generated_sql   | text                     |                   | true     |          |                                                 | The exact statement handed to ask_execute_sql, model-written or preset. Shown to the admin behind the "show the query" affordance and kept here for after-the-fact review. |
| row_count       | integer                  |                   | true     |          |                                                 |                                                                                                                                                                            |
| duration_ms     | integer                  |                   | true     |          |                                                 |                                                                                                                                                                            |
| error           | text                     |                   | true     |          |                                                 |                                                                                                                                                                            |
| created_at      | timestamp with time zone | now()             | false    |          |                                                 |                                                                                                                                                                            |

## Constraints

| Name                             | Type        | Definition                                                    |
| -------------------------------- | ----------- | ------------------------------------------------------------- |
| ask_queries_check                | CHECK       | CHECK (((source = 'preset'::text) = (preset_id IS NOT NULL))) |
| ask_queries_source_check         | CHECK       | CHECK ((source = ANY (ARRAY['preset'::text, 'llm'::text])))   |
| ask_queries_organization_id_fkey | FOREIGN KEY | FOREIGN KEY (organization_id) REFERENCES organizations(id)    |
| ask_queries_staff_id_fkey        | FOREIGN KEY | FOREIGN KEY (staff_id) REFERENCES staff(id)                   |
| ask_queries_pkey                 | PRIMARY KEY | PRIMARY KEY (id)                                              |

## Indexes

| Name                | Definition                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| ask_queries_pkey    | CREATE UNIQUE INDEX ask_queries_pkey ON public.ask_queries USING btree (id)                           |
| ask_queries_org_day | CREATE INDEX ask_queries_org_day ON public.ask_queries USING btree (organization_id, created_at DESC) |
| ask_queries_staff   | CREATE INDEX ask_queries_staff ON public.ask_queries USING btree (staff_id, created_at DESC)          |

## Relations

![er](public.ask_queries.svg)

---

> Generated by [tbls](https://github.com/k1LoW/tbls)
