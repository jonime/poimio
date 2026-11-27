begin;

drop table public.interest_summaries;
drop function public.valid_interest_summary_topics(text[]);

delete from public.llm_usage
where kind = 'interest_summary';

alter table public.llm_usage
  drop constraint llm_usage_kind_check,
  add constraint llm_usage_kind_check
    check (kind in ('preferences'));

create or replace function public.reserve_llm_call(p_kind text)
returns boolean
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  recent_count integer;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if p_kind is distinct from 'preferences' then
    raise exception 'Unknown LLM usage kind' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('llm_usage:' || caller_id::text, 0)
  );

  select count(*)
  into recent_count
  from public.llm_usage
  where user_id = caller_id
    and kind = p_kind
    and created_at >= pg_catalog.now() - interval '24 hours';

  if recent_count >= 10 then
    return false;
  end if;

  insert into public.llm_usage (kind)
  values (p_kind);

  return true;
end;
$$;

revoke all on function public.reserve_llm_call(text) from public, anon, service_role;
grant execute on function public.reserve_llm_call(text) to authenticated;

commit;
