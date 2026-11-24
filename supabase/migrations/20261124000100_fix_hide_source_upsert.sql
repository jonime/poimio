-- Avoid PL/pgSQL output-variable ambiguity in the idempotent hide insert.
begin;

create or replace function public.hide_source_of_item(p_item_id uuid)
returns table (source_id uuid, source_name text)
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  found_source_id uuid;
  found_source_name text;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select ci.source_id, source.name
  into found_source_id, found_source_name
  from public.content_items as ci
  join public.sources as source on source.id = ci.source_id
  where ci.id = p_item_id;

  if not found then
    raise exception 'Could not hide source' using errcode = 'P0002';
  end if;

  insert into public.hidden_sources as hidden (source_id)
  values (found_source_id)
  on conflict on constraint hidden_sources_pkey do nothing;

  return query select found_source_id, found_source_name;
end;
$$;

revoke all on function public.hide_source_of_item(uuid) from public, anon, service_role;
grant execute on function public.hide_source_of_item(uuid) to authenticated;

commit;
