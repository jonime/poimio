-- Spec 021: per-user feed preferences and the daily LLM-call limit.
begin;

create table public.feed_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 40),
  direction text not null check (direction in ('more', 'less')),
  description_fi text not null check (char_length(btrim(description_fi)) between 1 and 200),
  description_en text not null check (char_length(btrim(description_en)) between 1 and 200),
  embedding_fi extensions.vector(512) not null,
  embedding_en extensions.vector(512) not null,
  embedding_model text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index feed_preferences_user_id_idx on public.feed_preferences (user_id);

create function public.update_feed_preference_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

revoke all on function public.update_feed_preference_updated_at() from public, anon, authenticated;

create trigger feed_preferences_updated_at
  before update on public.feed_preferences
  for each row execute function public.update_feed_preference_updated_at();

create function public.enforce_feed_preference_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  existing_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('feed_preferences:' || new.user_id::text, 0)
  );

  select count(*)
  into existing_count
  from public.feed_preferences
  where user_id = new.user_id;

  if existing_count >= 20 then
    raise exception 'A user can have at most 20 active preferences'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_feed_preference_cap() from public, anon, authenticated;
grant execute on function public.enforce_feed_preference_cap() to service_role;

create trigger feed_preferences_cap
  before insert on public.feed_preferences
  for each row execute function public.enforce_feed_preference_cap();

alter table public.feed_preferences enable row level security;

revoke all on table public.feed_preferences from anon, authenticated;
grant select, delete on table public.feed_preferences to authenticated;
grant update (direction) on table public.feed_preferences to authenticated;
grant all on table public.feed_preferences to service_role;

create policy "Users can read their own feed preferences"
  on public.feed_preferences
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can update their own feed preferences"
  on public.feed_preferences
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own feed preferences"
  on public.feed_preferences
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create table public.llm_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('preferences')),
  created_at timestamptz not null default now()
);

create index llm_usage_user_kind_created_idx
  on public.llm_usage (user_id, kind, created_at);

alter table public.llm_usage enable row level security;

revoke all on table public.llm_usage from anon, authenticated;
grant select on table public.llm_usage to authenticated;
grant insert (kind) on table public.llm_usage to authenticated;
grant all on table public.llm_usage to service_role;

create policy "Users can read their own LLM usage"
  on public.llm_usage
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own LLM usage"
  on public.llm_usage
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create function public.reserve_llm_call(p_kind text)
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
