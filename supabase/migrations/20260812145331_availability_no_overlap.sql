-- Range type over TIME (idempotent: the type already exists in the DB
-- from this migration's earlier half-applied run)
do $$ begin
  create type timerange as range (subtype = time);
exception when duplicate_object then null;
end $$;

-- Same staff member, same weekday: hour ranges must not overlap.
-- (btree_gist is already installed from migration 3.)
alter table availability_rules add constraint no_overlapping_hours
  exclude using gist (
    staff_id with =,
    day_of_week with =,
    timerange(start_time, end_time) with &&
  );
