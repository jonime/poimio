-- Spec 022: hide shared sources per user.
begin;

create table public.hidden_sources (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, source_id)
);

create index hidden_sources_source_id_idx on public.hidden_sources (source_id);

alter table public.hidden_sources enable row level security;

revoke all on table public.hidden_sources from anon, authenticated;
grant select, insert, delete on table public.hidden_sources to authenticated;
grant all on table public.hidden_sources to service_role;

create policy "Users can read their own hidden sources"
  on public.hidden_sources
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can insert their own hidden sources"
  on public.hidden_sources
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own hidden sources"
  on public.hidden_sources
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);

create function public.hide_source_of_item(p_item_id uuid)
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

  insert into public.hidden_sources (source_id)
  values (found_source_id)
  on conflict (user_id, source_id) do nothing;

  return query select found_source_id, found_source_name;
end;
$$;

revoke all on function public.hide_source_of_item(uuid) from public, anon, service_role;
grant execute on function public.hide_source_of_item(uuid) to authenticated;

drop function public.get_feed(integer, uuid[]);

create function public.get_feed(
  p_limit integer default 30,
  p_exclude uuid[] default '{}'::uuid[]
)
returns table (
  id uuid,
  url text,
  title text,
  summary text,
  summary_origin text,
  type text,
  language text,
  thumbnail_url text,
  published_at timestamptz,
  source_name text,
  score double precision,
  reason text,
  because_item_id uuid,
  because_title text,
  because_preference_id uuid,
  source_id uuid
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  requested_limit integer := greatest(1, least(coalesce(p_limit, 30), 100));
  excluded_ids uuid[] := coalesce(p_exclude[1:1000], '{}'::uuid[]);
  active_model constant text := 'text-embedding-3-small@512';
  candidate_ids uuid[];
  liked_ids uuid[];
  disliked_ids uuid[];
  more_preference_ids uuid[];
  less_preference_ids uuid[];
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select coalesce(array_agg(ci.id), '{}'::uuid[])
  into candidate_ids
  from public.content_items as ci
  where ci.published_at >= now() - case
      when ci.type = 'video' then interval '30 days'
      else interval '7 days'
    end
    and not (ci.id = any(excluded_ids))
    and not exists (
      select 1
      from public.feedback as rated
      where rated.user_id = caller_id
        and rated.item_id = ci.id
    )
    and not exists (
      select 1
      from public.hidden_sources as hidden
      where hidden.user_id = caller_id
        and hidden.source_id = ci.source_id
    );

  select coalesce(array_agg(feedback.item_id order by feedback.updated_at desc, feedback.item_id), '{}'::uuid[])
  into liked_ids
  from (
    select f.item_id, f.updated_at
    from public.feedback as f
    join public.content_items as ci on ci.id = f.item_id
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where f.user_id = caller_id
      and f.kind = 'like'
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
    order by f.updated_at desc, f.item_id
    limit 200
  ) as feedback;

  select coalesce(array_agg(feedback.item_id order by feedback.updated_at desc, feedback.item_id), '{}'::uuid[])
  into disliked_ids
  from (
    select f.item_id, f.updated_at
    from public.feedback as f
    join public.content_items as ci on ci.id = f.item_id
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where f.user_id = caller_id
      and f.kind = 'not_interested'
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
    order by f.updated_at desc, f.item_id
    limit 200
  ) as feedback;

  select coalesce(array_agg(pref.id), '{}'::uuid[])
  into more_preference_ids
  from public.feed_preferences as pref
  where pref.user_id = caller_id
    and pref.direction = 'more';

  select coalesce(array_agg(pref.id), '{}'::uuid[])
  into less_preference_ids
  from public.feed_preferences as pref
  where pref.user_id = caller_id
    and pref.direction = 'less';

  return query
  select
    ranked.item_id,
    ci.url,
    ci.title,
    ci.summary,
    ci.summary_origin,
    ci.type,
    ci.language,
    ci.thumbnail_url,
    ci.published_at,
    source.name,
    ranked.score,
    case
      when ranked.exploration then 'exploring'
      when ranked.because_preference_id is not null then 'preference'
      when ranked.because_item_id is not null then 'similar'
      else 'recent'
    end,
    ranked.because_item_id,
    case
      when ranked.because_preference_id is not null then preference.label
      else liked.title
    end,
    ranked.because_preference_id,
    ci.source_id
  from ranking_private.rank_items(
    candidate_ids,
    liked_ids,
    disliked_ids,
    now(),
    'blend',
    '{"diversity": 0, "exploration": true}'::jsonb,
    0,
    requested_limit,
    more_preference_ids,
    less_preference_ids
  ) with ordinality as ranked(
    item_id,
    score,
    because_item_id,
    exploration,
    because_preference_id,
    rank_position
  )
  join public.content_items as ci on ci.id = ranked.item_id
  join public.sources as source on source.id = ci.source_id
  left join public.content_items as liked on liked.id = ranked.because_item_id
  left join public.feed_preferences as preference on preference.id = ranked.because_preference_id
  order by ranked.rank_position;
end;
$$;

revoke all on function public.get_feed(integer, uuid[]) from public, anon;
grant execute on function public.get_feed(integer, uuid[]) to authenticated;

commit;
