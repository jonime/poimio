-- Spec 025: same-story covered-story filter and per-page grouping in get_feed.
begin;

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
  source_id uuid,
  duplicate_of uuid
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
  same_lang_threshold constant double precision := 0.74;
  cross_lang_threshold constant double precision := null;
  max_group_size constant integer := 5;
  candidate_ids uuid[];
  liked_ids uuid[];
  disliked_ids uuid[];
  more_preference_ids uuid[];
  less_preference_ids uuid[];
  rep_ids uuid[] := '{}'::uuid[];
  rep_languages text[] := '{}'::text[];
  rep_vectors extensions.vector[] := '{}'::extensions.vector[];
  rep_sizes integer[] := '{}'::integer[];
  row_rec record;
  rep_count integer;
  rep_idx integer;
  pair_threshold double precision;
  pair_sim double precision;
  matched_rep uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  with story_refs as materialized (
    select
      (ci.embedding OPERATOR(extensions.-) means.mean) as centered
    from public.feedback as f
    join public.content_items as ci on ci.id = f.item_id
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where f.user_id = caller_id
      and ci.published_at >= now() - interval '30 days'
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
      and extensions.vector_norm(ci.embedding OPERATOR(extensions.-) means.mean) > 0
    order by f.updated_at desc, f.item_id
    limit 300
  ),
  base_candidates as materialized (
    select
      ci.id,
      case
        when ci.embedding_model = active_model
          and ci.embedding is not null
          and cand_means.mean is not null
          and ci.enrichment_status = 'completed'
          and nullif(btrim(ci.summary), '') is not null
          and extensions.vector_norm(ci.embedding OPERATOR(extensions.-) cand_means.mean) > 0
          then (ci.embedding OPERATOR(extensions.-) cand_means.mean)
        else null::extensions.vector
      end as centered
    from public.content_items as ci
    left join public.embedding_language_means as cand_means
      on cand_means.embedding_model = ci.embedding_model
      and cand_means.language = ci.language
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
      )
  )
  select coalesce(array_agg(cand.id), '{}'::uuid[])
  into candidate_ids
  from base_candidates as cand
  where cand.centered is null
    or not exists (
      select 1
      from story_refs as ref
      where (cand.centered OPERATOR(extensions.<=>) ref.centered)
        <= (1::double precision - same_lang_threshold)
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

  for row_rec in
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
      source.name as source_name,
      ranked.score,
      case
        when ranked.exploration then 'exploring'
        when ranked.because_preference_id is not null then 'preference'
        when ranked.because_item_id is not null then 'similar'
        else 'recent'
      end as reason,
      ranked.because_item_id,
      case
        when ranked.because_preference_id is not null then preference.label
        else liked.title
      end as because_title,
      ranked.because_preference_id,
      ci.source_id,
      ranked.exploration,
      (
        ci.embedding_model = active_model
        and ci.embedding is not null
        and means.mean is not null
        and ci.enrichment_status = 'completed'
        and nullif(btrim(ci.summary), '') is not null
        and extensions.vector_norm(ci.embedding OPERATOR(extensions.-) means.mean) > 0
      ) as is_eligible,
      case
        when ci.embedding is not null and means.mean is not null
          then (ci.embedding OPERATOR(extensions.-) means.mean)
        else null::extensions.vector
      end as centered
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
    left join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    left join public.content_items as liked on liked.id = ranked.because_item_id
    left join public.feed_preferences as preference on preference.id = ranked.because_preference_id
    order by ranked.rank_position
  loop
    matched_rep := null;

    if not row_rec.exploration and row_rec.is_eligible then
      rep_count := coalesce(array_length(rep_ids, 1), 0);
      for rep_idx in 1..rep_count loop
        if rep_sizes[rep_idx] >= max_group_size then
          continue;
        end if;

        if row_rec.language = rep_languages[rep_idx] then
          pair_threshold := same_lang_threshold;
        elsif cross_lang_threshold is not null and (
          (row_rec.language = 'fi' and rep_languages[rep_idx] = 'en')
          or (row_rec.language = 'en' and rep_languages[rep_idx] = 'fi')
        ) then
          pair_threshold := cross_lang_threshold;
        else
          pair_threshold := null;
        end if;

        if pair_threshold is not null then
          pair_sim := 1::double precision - (row_rec.centered OPERATOR(extensions.<=>) rep_vectors[rep_idx]);
          if pair_sim >= pair_threshold then
            matched_rep := rep_ids[rep_idx];
            rep_sizes[rep_idx] := rep_sizes[rep_idx] + 1;
            exit;
          end if;
        end if;
      end loop;

      if matched_rep is null then
        rep_ids := array_append(rep_ids, row_rec.item_id);
        rep_languages := array_append(rep_languages, row_rec.language);
        rep_vectors := array_append(rep_vectors, row_rec.centered);
        rep_sizes := array_append(rep_sizes, 1);
      end if;
    end if;

    id := row_rec.item_id;
    url := row_rec.url;
    title := row_rec.title;
    summary := row_rec.summary;
    summary_origin := row_rec.summary_origin;
    type := row_rec.type;
    language := row_rec.language;
    thumbnail_url := row_rec.thumbnail_url;
    published_at := row_rec.published_at;
    source_name := row_rec.source_name;
    score := row_rec.score;
    reason := row_rec.reason;
    because_item_id := row_rec.because_item_id;
    because_title := row_rec.because_title;
    because_preference_id := row_rec.because_preference_id;
    source_id := row_rec.source_id;
    duplicate_of := matched_rep;
    return next;
  end loop;
end;
$$;

revoke all on function public.get_feed(integer, uuid[]) from public, anon;
grant execute on function public.get_feed(integer, uuid[]) to authenticated;

commit;
