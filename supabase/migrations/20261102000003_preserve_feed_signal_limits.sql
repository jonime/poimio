create or replace function public.get_feed(
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
  because_title text
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
    case when ranked.because_item_id is not null then 'similar' else 'recent' end,
    ranked.because_item_id,
    liked.title
  from public.rank_items(
    candidate_ids,
    liked_ids,
    disliked_ids,
    now(),
    'nearest_liked',
    '{}'::jsonb,
    0,
    requested_limit
  ) with ordinality as ranked(item_id, score, because_item_id, rank_position)
  join public.content_items as ci on ci.id = ranked.item_id
  join public.sources as source on source.id = ci.source_id
  left join public.content_items as liked on liked.id = ranked.because_item_id
  order by ranked.rank_position;
end;
$$;

revoke all on function public.get_feed(integer, uuid[]) from public, anon;
grant execute on function public.get_feed(integer, uuid[]) to authenticated;