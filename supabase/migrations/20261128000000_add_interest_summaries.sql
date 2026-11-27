-- Spec 026 tasks 5.1 and 5.2: per-user interest summaries and a separate LLM quota kind.
begin;

create function public.valid_interest_summary_topics(p_topics text[])
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(
    pg_catalog.bool_and(pg_catalog.char_length(pg_catalog.btrim(topic)) between 1 and 40),
    true
  )
  from pg_catalog.unnest(p_topics) as t(topic)
$$;

revoke all on function public.valid_interest_summary_topics(text[]) from public, anon, authenticated;
grant execute on function public.valid_interest_summary_topics(text[]) to service_role;

create table public.interest_summaries (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  summary text not null check (char_length(btrim(summary)) between 1 and 400),
  topics text[] not null check (
    cardinality(topics) <= 8
    and array_position(topics, null) is null
    and public.valid_interest_summary_topics(topics)
  ),
  like_count integer not null check (like_count >= 0),
  generated_at timestamptz not null default now()
);

alter table public.interest_summaries enable row level security;

revoke all on table public.interest_summaries from public, anon, authenticated;
grant select, delete on table public.interest_summaries to authenticated;
grant all on table public.interest_summaries to service_role;

create policy "Users can read their own interest summary"
  on public.interest_summaries
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can delete their own interest summary"
  on public.interest_summaries
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

alter table public.llm_usage
  drop constraint llm_usage_kind_check,
  add constraint llm_usage_kind_check
    check (kind in ('preferences', 'interest_summary'));

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

  if p_kind is distinct from 'preferences'
    and p_kind is distinct from 'interest_summary'
  then
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
