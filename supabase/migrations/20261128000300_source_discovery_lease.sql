begin;

create unique index source_candidates_catalog_source_unique
  on public.source_candidates (source_id)
  where origin = 'catalog';

create function public.start_source_discovery_run(p_kind text)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  run_id uuid;
begin
  if p_kind is null or p_kind not in ('catalog', 'web_search') then
    raise exception 'Invalid source discovery run kind' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('source_discovery_lease', 0)
  );

  update public.source_discovery_runs
  set status = 'failed', finished_at = pg_catalog.now()
  where status = 'running'
    and lease_expires_at <= pg_catalog.now();

  if exists (
    select 1
    from public.source_discovery_runs
    where status = 'running'
      and lease_expires_at > pg_catalog.now()
  ) then
    return null;
  end if;

  insert into public.source_discovery_runs (kind, lease_expires_at)
  values (p_kind, pg_catalog.now() + interval '330 seconds')
  returning id into run_id;
  return run_id;
end;
$$;

revoke all on function public.start_source_discovery_run(text) from public, anon, authenticated;
grant execute on function public.start_source_discovery_run(text) to service_role;

commit;
