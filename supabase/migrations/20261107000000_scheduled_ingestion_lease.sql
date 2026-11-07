create table public.scheduled_ingestion_lease (
  singleton boolean primary key default true check (singleton),
  lease_id uuid,
  expires_at timestamptz not null default '-infinity'
);

alter table public.scheduled_ingestion_lease enable row level security;
revoke all on table public.scheduled_ingestion_lease from public, anon, authenticated;
grant select, update on table public.scheduled_ingestion_lease to service_role;

insert into public.scheduled_ingestion_lease default values;

create function public.claim_scheduled_ingestion(lease_id uuid)
returns boolean
language sql
security invoker
set search_path = ''
as $$
  with claimed as (
    update public.scheduled_ingestion_lease
    -- Keep the lease for longer than the 300-second function limit.
    set lease_id = $1, expires_at = now() + interval '6 minutes'
    where singleton and expires_at <= now()
    returning 1
  )
  select exists (select 1 from claimed);
$$;

revoke execute on function public.claim_scheduled_ingestion(uuid) from public, anon, authenticated;
grant execute on function public.claim_scheduled_ingestion(uuid) to service_role;
