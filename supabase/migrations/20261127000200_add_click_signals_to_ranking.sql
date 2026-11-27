-- Spec 026: clicks in ranking and feed.
begin;

drop function public.get_feed(integer, uuid[]);
drop function public.rank_items(uuid[], uuid[], uuid[], timestamptz, text, jsonb, integer, integer, uuid[], uuid[]);
drop function ranking_private.rank_items(uuid[], uuid[], uuid[], timestamptz, text, jsonb, integer, integer, uuid[], uuid[]);

CREATE FUNCTION ranking_private.rank_items(p_candidate_ids uuid[], p_liked_ids uuid[], p_disliked_ids uuid[], p_as_of timestamp with time zone, p_method text DEFAULT 'blend'::text, p_params jsonb DEFAULT '{}'::jsonb, p_seed integer DEFAULT 0, p_limit integer DEFAULT 30, p_more_preference_ids uuid[] DEFAULT '{}'::uuid[], p_less_preference_ids uuid[] DEFAULT '{}'::uuid[], p_click_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS TABLE(item_id uuid, score double precision, because_item_id uuid, exploration boolean, because_preference_id uuid)
 LANGUAGE plpgsql
 STABLE
 SECURITY INVOKER
 SET search_path TO ''
AS $function$
declare
  active_model constant text := 'text-embedding-3-small@512';
  parameters jsonb := coalesce(p_params, '{}'::jsonb);
  unknown_parameter text;
  lambda_value double precision := 0.5;
  recency_weight_value double precision := 0;
  dislike_threshold_value double precision := 0.4;
  article_half_life_hours double precision := 24;
  video_half_life_hours double precision := 168;
  centered_value boolean := true;
  top_m_value integer := 3;
  blend_alpha_value double precision := 0.5;
  diversity_value double precision := 0;
  exploration_value boolean := false;
begin
  if p_method not in (
    'nearest_liked', 'average_vector', 'top_m_mean', 'blend', 'newest_first', 'random'
  ) then
    raise exception 'Unknown ranking method: %', p_method;
  end if;

  if jsonb_typeof(parameters) <> 'object' then
    raise exception 'Ranking parameters must be a JSON object';
  end if;

  select key
  into unknown_parameter
  from jsonb_object_keys(parameters) as parameter_keys(key)
  where key not in (
    'lambda',
    'recency_weight',
    'dislike_threshold',
    'article_half_life_hours',
    'video_half_life_hours',
    'centered',
    'top_m',
    'blend_alpha',
    'diversity',
    'exploration'
  )
  limit 1;
  if unknown_parameter is not null then
    raise exception 'Unknown ranking parameter: %', unknown_parameter;
  end if;

  if parameters ? 'top_m' then
    if jsonb_typeof(parameters -> 'top_m') <> 'number'
      or (parameters ->> 'top_m')::numeric <> trunc((parameters ->> 'top_m')::numeric)
      or (parameters ->> 'top_m')::numeric not between 1 and 10
    then
      raise exception 'Ranking parameter top_m must be an integer from 1 to 10';
    end if;
    top_m_value := (parameters ->> 'top_m')::integer;
  end if;

  if parameters ? 'blend_alpha' then
    if jsonb_typeof(parameters -> 'blend_alpha') <> 'number'
      or (parameters ->> 'blend_alpha')::numeric not between 0 and 1
    then
      raise exception 'Ranking parameter blend_alpha must be a number from 0 to 1';
    end if;
    blend_alpha_value := (parameters ->> 'blend_alpha')::double precision;
  end if;

  if parameters ? 'diversity' then
    if jsonb_typeof(parameters -> 'diversity') <> 'number'
      or (parameters ->> 'diversity')::numeric not between 0 and 1
    then
      raise exception 'Ranking parameter diversity must be a number from 0 to 1';
    end if;
    diversity_value := (parameters ->> 'diversity')::double precision;
  end if;

  if parameters ? 'exploration' then
    if jsonb_typeof(parameters -> 'exploration') <> 'boolean' then
      raise exception 'Ranking parameter exploration must be a boolean';
    end if;
    exploration_value := (parameters ->> 'exploration')::boolean;
  end if;

  lambda_value := coalesce((parameters ->> 'lambda')::double precision, lambda_value);
  recency_weight_value := coalesce((parameters ->> 'recency_weight')::double precision, recency_weight_value);
  dislike_threshold_value := coalesce((parameters ->> 'dislike_threshold')::double precision, dislike_threshold_value);
  article_half_life_hours := coalesce((parameters ->> 'article_half_life_hours')::double precision, article_half_life_hours);
  video_half_life_hours := coalesce((parameters ->> 'video_half_life_hours')::double precision, video_half_life_hours);
  centered_value := coalesce((parameters ->> 'centered')::boolean, centered_value);

  if article_half_life_hours <= 0 or video_half_life_hours <= 0 then
    raise exception 'Ranking half-lives must be positive';
  end if;
  if exists (
    select more_id
    from unnest(coalesce(p_more_preference_ids, '{}'::uuid[])) as more_id
    intersect
    select less_id
    from unnest(coalesce(p_less_preference_ids, '{}'::uuid[])) as less_id
  ) then
    raise exception 'A preference cannot be both more and less' using errcode = '22023';
  end if;
  if exists (
    select click_id
    from unnest(coalesce(p_click_ids, '{}'::uuid[])) as click_id
    intersect
    select signal_id
    from (
      select unnest(coalesce(p_liked_ids, '{}'::uuid[])) as signal_id
      union
      select unnest(coalesce(p_disliked_ids, '{}'::uuid[]))
    ) as explicit_signals
  ) then
    raise exception 'A clicked item cannot also be liked or disliked' using errcode = '22023';
  end if;


  return query
  with recursive eligible_items as (
    select ci.id, ci.source_id, ci.type, ci.published_at, ci.embedding, means.mean
    from public.content_items as ci
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where ci.id = any(coalesce(p_candidate_ids, '{}'::uuid[]))
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
  ),
  likes as (
    select ci.id, ci.source_id, ci.embedding, means.mean
    from public.content_items as ci
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where ci.id = any(coalesce(p_liked_ids, '{}'::uuid[]))
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
  ),
  dislikes as (
    select ci.id, ci.embedding, means.mean
    from public.content_items as ci
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where ci.id = any(coalesce(p_disliked_ids, '{}'::uuid[]))
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
  ),
  clicks as (
    select ci.id, ci.embedding, means.mean
    from public.content_items as ci
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where ci.id = any(coalesce(p_click_ids, '{}'::uuid[]))
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
  ),

  eligible_more as (
    select
      pref.id,
      pref.embedding_fi,
      pref.embedding_en,
      means_fi.mean as mean_fi,
      means_en.mean as mean_en,
      (means_fi.mean is not null) as fi_ok,
      (means_en.mean is not null) as en_ok
    from public.feed_preferences as pref
    left join public.embedding_language_means as means_fi
      on means_fi.embedding_model = pref.embedding_model
      and means_fi.language = 'fi'
    left join public.embedding_language_means as means_en
      on means_en.embedding_model = pref.embedding_model
      and means_en.language = 'en'
    where pref.id = any(coalesce(p_more_preference_ids, '{}'::uuid[]))
      and pref.embedding_model = active_model
      and (means_fi.mean is not null or means_en.mean is not null)
  ),
  eligible_less as (
    select
      pref.id,
      pref.embedding_fi,
      pref.embedding_en,
      means_fi.mean as mean_fi,
      means_en.mean as mean_en,
      (means_fi.mean is not null) as fi_ok,
      (means_en.mean is not null) as en_ok
    from public.feed_preferences as pref
    left join public.embedding_language_means as means_fi
      on means_fi.embedding_model = pref.embedding_model
      and means_fi.language = 'fi'
    left join public.embedding_language_means as means_en
      on means_en.embedding_model = pref.embedding_model
      and means_en.language = 'en'
    where pref.id = any(coalesce(p_less_preference_ids, '{}'::uuid[]))
      and pref.embedding_model = active_model
      and (means_fi.mean is not null or means_en.mean is not null)
  ),
  profile as (
    select
      exists (select 1 from likes) as has_likes,
      exists (select 1 from likes) or exists (select 1 from eligible_more) as has_positive
  ),
  positive_vectors as (
    select
      case when centered_value
        then liked.embedding OPERATOR(extensions.-) liked.mean
        else liked.embedding
      end as vector
    from likes as liked
    union all
    select preference_vector.vector
    from eligible_more as pref
    cross join lateral (
      select extensions.avg(language_vector.vector) as vector
      from (
        select
          case when centered_value
            then pref.embedding_fi OPERATOR(extensions.-) pref.mean_fi
            else pref.embedding_fi
          end as vector
        where pref.fi_ok
        union all
        select
          case when centered_value
            then pref.embedding_en OPERATOR(extensions.-) pref.mean_en
            else pref.embedding_en
          end as vector
        where pref.en_ok
      ) as language_vector
    ) as preference_vector
  ),
  average_signal as (
    select extensions.avg(weighted_signal.vector) as vector
    from (
      select signal.vector
      from positive_vectors as signal
      where not exists (select 1 from clicks)
      union all
      select
        signal.vector
      from positive_vectors as signal
      cross join generate_series(1, 10)
      where exists (select 1 from clicks)
      union all
      select
        case when centered_value
          then clicked.embedding OPERATOR(extensions.-) clicked.mean
          else clicked.embedding
        end as vector
      from clicks as clicked
      cross join generate_series(1, 3)
      where exists (select 1 from positive_vectors)
    ) as weighted_signal
  ),
  candidate_scores as (
    select
      candidate.*,
      profile.has_likes,
      profile.has_positive,
      closest_like.id as like_because_item_id,
      greatest(
        case
        when closest_more.similarity is null then closest_like.similarity
        when closest_like.similarity is null then closest_more.similarity
        else greatest(closest_like.similarity, closest_more.similarity)
        end,
        closest_click.similarity
      ) as liked_similarity,
      case
        when exists (select 1 from clicks) then positive_top_m.similarity
        when not exists (select 1 from eligible_more) then closest_like.top_m_similarity
        else positive_top_m.similarity
      end as top_m_similarity,
      explanation.because_item_id,
      explanation.because_preference_id,
      case
        when closest_less.similarity is null then coalesce(closest_dislike.similarity, 0)
        when closest_dislike.similarity is null then closest_less.similarity
        else greatest(closest_dislike.similarity, closest_less.similarity)
      end as disliked_similarity,
      average_score.similarity as average_similarity
    from eligible_items as candidate
    cross join profile
    cross join average_signal
    left join lateral (
      select
        (array_agg(ranked_like.id) filter (where ranked_like.like_rank = 1))[1] as id,
        max(ranked_like.similarity) as similarity,
        avg(ranked_like.similarity) filter (where ranked_like.like_rank <= top_m_value)
          as top_m_similarity
      from (
        select
          scored_like.id,
          scored_like.similarity,
          row_number() over (
            order by scored_like.similarity desc, scored_like.id
          ) as like_rank
        from (
          select
            liked.id,
            case
              when centered_value then public.centered_similarity(
                candidate.embedding,
                candidate.mean,
                liked.embedding,
                liked.mean
              )
              when extensions.vector_norm(candidate.embedding) = 0
                or extensions.vector_norm(liked.embedding) = 0
                then 0::double precision
              else 1::double precision
                - (candidate.embedding OPERATOR(extensions.<=>) liked.embedding)
            end as similarity
          from likes as liked
        ) as scored_like
      ) as ranked_like
    ) as closest_like on true
    left join lateral (
      select max(clicked_score.value) as similarity
      from (
        select
          0.3::double precision * click_similarity.similarity as value
        from clicks as clicked
        cross join lateral (
          select case
            when centered_value then public.centered_similarity(
              candidate.embedding,
              candidate.mean,
              clicked.embedding,
              clicked.mean
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(clicked.embedding) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) clicked.embedding)
          end as similarity
        ) as click_similarity
        where click_similarity.similarity > 0
      ) as clicked_score
    ) as closest_click on true
    left join lateral (
      select max(case
        when centered_value then public.centered_similarity(
          candidate.embedding,
          candidate.mean,
          disliked.embedding,
          disliked.mean
        )
        when extensions.vector_norm(candidate.embedding) = 0
          or extensions.vector_norm(disliked.embedding) = 0
          then 0::double precision
        else 1::double precision
          - (candidate.embedding OPERATOR(extensions.<=>) disliked.embedding)
      end) as similarity
      from dislikes as disliked
    ) as closest_dislike on true

    left join lateral (
      select max(preference_score.similarity) as similarity
      from eligible_more as pref
      cross join lateral (
        
        select max(language_score.similarity) as similarity
        from (
          select case
            when not pref.fi_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_fi, pref.mean_fi
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_fi) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_fi)
          end as similarity
          union all
          select case
            when not pref.en_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_en, pref.mean_en
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_en) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_en)
          end as similarity
        ) as language_score
      ) as preference_score
    ) as closest_more on true
    left join lateral (
      select max(preference_score.similarity) as similarity
      from eligible_less as pref
      cross join lateral (
        
        select max(language_score.similarity) as similarity
        from (
          select case
            when not pref.fi_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_fi, pref.mean_fi
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_fi) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_fi)
          end as similarity
          union all
          select case
            when not pref.en_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_en, pref.mean_en
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_en) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_en)
          end as similarity
        ) as language_score
      ) as preference_score
    ) as closest_less on true
    left join lateral (
      select avg(signal.similarity) filter (where signal.signal_rank <= top_m_value) as similarity
      from (
        select
          scored.similarity,
          row_number() over (
            order by scored.similarity desc, scored.signal_kind desc, scored.signal_id
          ) as signal_rank
        from (
          select
            liked.id as signal_id,
            2 as signal_kind,
            case
              when centered_value then public.centered_similarity(
                candidate.embedding, candidate.mean, liked.embedding, liked.mean
              )
              when extensions.vector_norm(candidate.embedding) = 0
                or extensions.vector_norm(liked.embedding) = 0
                then 0::double precision
              else 1::double precision
                - (candidate.embedding OPERATOR(extensions.<=>) liked.embedding)
            end as similarity
          from likes as liked
          union all
          select pref.id, 1, preference_score.similarity
          from eligible_more as pref
          cross join lateral (
            
        select max(language_score.similarity) as similarity
        from (
          select case
            when not pref.fi_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_fi, pref.mean_fi
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_fi) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_fi)
          end as similarity
          union all
          select case
            when not pref.en_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_en, pref.mean_en
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_en) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_en)
          end as similarity
        ) as language_score
          ) as preference_score
          union all
          select
            clicked.id,
            0,
            0.3::double precision * click_similarity.similarity
          from clicks as clicked
          cross join lateral (
            select case
              when centered_value then public.centered_similarity(
                candidate.embedding,
                candidate.mean,
                clicked.embedding,
                clicked.mean
              )
              when extensions.vector_norm(candidate.embedding) = 0
                or extensions.vector_norm(clicked.embedding) = 0
                then 0::double precision
              else 1::double precision
                - (candidate.embedding OPERATOR(extensions.<=>) clicked.embedding)
            end as similarity
          ) as click_similarity
          where click_similarity.similarity > 0
        ) as scored
      ) as signal
    ) as positive_top_m on true
    left join lateral (
      select
        case when winner.signal_kind in (2, 0) then winner.signal_id
          else null::uuid
        end as because_item_id,
        case when winner.signal_kind = 1 then winner.signal_id
          else null::uuid
        end as because_preference_id
      from (
        select scored.signal_id, scored.signal_kind
        from (
          select
            liked.id as signal_id,
            2 as signal_kind,
            case
              when centered_value then public.centered_similarity(
                candidate.embedding, candidate.mean, liked.embedding, liked.mean
              )
              when extensions.vector_norm(candidate.embedding) = 0
                or extensions.vector_norm(liked.embedding) = 0
                then 0::double precision
              else 1::double precision
                - (candidate.embedding OPERATOR(extensions.<=>) liked.embedding)
            end as similarity
          from likes as liked
          union all
          select pref.id, 1, preference_score.similarity
          from eligible_more as pref
          cross join lateral (
            
        select max(language_score.similarity) as similarity
        from (
          select case
            when not pref.fi_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_fi, pref.mean_fi
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_fi) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_fi)
          end as similarity
          union all
          select case
            when not pref.en_ok then null::double precision
            when centered_value then public.centered_similarity(
              candidate.embedding, candidate.mean, pref.embedding_en, pref.mean_en
            )
            when extensions.vector_norm(candidate.embedding) = 0
              or extensions.vector_norm(pref.embedding_en) = 0
              then 0::double precision
            else 1::double precision
              - (candidate.embedding OPERATOR(extensions.<=>) pref.embedding_en)
          end as similarity
        ) as language_score
          ) as preference_score
          union all
          select
            clicked.id,
            0,
            0.3::double precision * click_similarity.similarity
          from clicks as clicked
          cross join lateral (
            select case
              when centered_value then public.centered_similarity(
                candidate.embedding,
                candidate.mean,
                clicked.embedding,
                clicked.mean
              )
              when extensions.vector_norm(candidate.embedding) = 0
                or extensions.vector_norm(clicked.embedding) = 0
                then 0::double precision
              else 1::double precision
                - (candidate.embedding OPERATOR(extensions.<=>) clicked.embedding)
            end as similarity
          ) as click_similarity
          where click_similarity.similarity > 0
        ) as scored
        order by scored.similarity desc, scored.signal_kind desc, scored.signal_id
        limit 1
      ) as winner
    ) as explanation on true
    left join lateral (
      select case
        when average_signal.vector is null then null::double precision
        when centered_value and (
          extensions.vector_norm(candidate.embedding OPERATOR(extensions.-) candidate.mean) = 0
          or extensions.vector_norm(average_signal.vector) = 0
        ) then 0::double precision
        when not centered_value and (
          extensions.vector_norm(candidate.embedding) = 0
          or extensions.vector_norm(average_signal.vector) = 0
        ) then 0::double precision
        when centered_value then 1::double precision
          - ((candidate.embedding OPERATOR(extensions.-) candidate.mean)
            OPERATOR(extensions.<=>) average_signal.vector)
        else 1::double precision
          - (candidate.embedding OPERATOR(extensions.<=>) average_signal.vector)
      end as similarity
    ) as average_score on true
  ),
  ranked_candidates as (
    select
      candidate_scores.*,
      case
        when candidate_scores.has_positive then
          case p_method
            when 'average_vector'
              then coalesce(candidate_scores.average_similarity, 0)
            when 'top_m_mean'
              then coalesce(candidate_scores.top_m_similarity, 0)
            when 'blend'
              then blend_alpha_value * coalesce(candidate_scores.liked_similarity, 0)
                + (1 - blend_alpha_value) * coalesce(candidate_scores.average_similarity, 0)
            else coalesce(candidate_scores.liked_similarity, 0)
          end
          - lambda_value * candidate_scores.disliked_similarity
          + recency_weight_value * power(
            0.5::double precision,
            greatest(extract(epoch from (p_as_of - candidate_scores.published_at)), 0)
            / case when candidate_scores.type = 'video'
                then video_half_life_hours * 3600
              else article_half_life_hours * 3600
            end
          )
        else power(
          0.5::double precision,
          greatest(extract(epoch from (p_as_of - candidate_scores.published_at)), 0)
          / case when candidate_scores.type = 'video'
              then video_half_life_hours * 3600
            else article_half_life_hours * 3600
          end
        )
      end as final_score,
      case
        when not candidate_scores.has_positive
          and candidate_scores.disliked_similarity >= dislike_threshold_value
          then 1
        else 0
      end as cold_start_dislike_order,
      row_number() over (
        partition by candidate_scores.source_id,
          case
            when not candidate_scores.has_positive
              and candidate_scores.disliked_similarity >= dislike_threshold_value
              then 1
            else 0
          end
        order by candidate_scores.published_at desc, candidate_scores.id
      ) as source_position
    from candidate_scores
  ),
  score_order as (
    select
      ranked_candidates.*,
      row_number() over (
        order by
          case when p_method = 'random'
            then md5(ranked_candidates.id::text || coalesce(p_seed, 0)::text)
          end,
          case when p_method = 'newest_first' then ranked_candidates.published_at end desc,
          case when p_method = 'newest_first' then ranked_candidates.id end,
          case when p_method not in ('newest_first', 'random')
              and ranked_candidates.has_positive
            then ranked_candidates.final_score
          end desc nulls last,
          case when p_method not in ('newest_first', 'random')
              and not ranked_candidates.has_positive
            then ranked_candidates.cold_start_dislike_order
          end,
          case when p_method not in ('newest_first', 'random')
              and not ranked_candidates.has_positive
            then ranked_candidates.source_position
          end,
          case when p_method not in ('newest_first', 'random')
              and not ranked_candidates.has_positive
            then ranked_candidates.source_id
          end,
          ranked_candidates.published_at desc,
          ranked_candidates.id
      )::integer as score_rank
    from ranked_candidates
  ),
  mmr_picks(picked_ids, item_id, pick_position) as (
    select array[first.id], first.id, 1
    from score_order as first
    cross join profile
    where first.score_rank = 1
      and diversity_value > 0
      and profile.has_likes
      and p_method in ('nearest_liked', 'average_vector', 'top_m_mean', 'blend')

    union all

    select
      mmr_picks.picked_ids || next_candidate.id,
      next_candidate.id,
      mmr_picks.pick_position + 1
    from mmr_picks
    cross join lateral (
      select candidate.id
      from score_order as candidate
      where candidate.score_rank <= 100
        and not (candidate.id = any(mmr_picks.picked_ids))
      order by
        (1 - diversity_value) * candidate.final_score
          - diversity_value * (
            select max(case
              when centered_value then public.centered_similarity(
                candidate.embedding,
                candidate.mean,
                selected.embedding,
                selected.mean
              )
              when extensions.vector_norm(candidate.embedding) = 0
                or extensions.vector_norm(selected.embedding) = 0
                then 0::double precision
              else 1::double precision
                - (candidate.embedding OPERATOR(extensions.<=>) selected.embedding)
            end)
            from score_order as selected
            where selected.id = any(mmr_picks.picked_ids)
          ) desc,
        candidate.final_score desc,
        candidate.published_at desc,
        candidate.id
      limit 1
    ) as next_candidate
    where mmr_picks.pick_position < 30
  ),
  mmr_pool_size as (
    select count(*)::integer as pick_count from mmr_picks
  ),
  mmr_top as (
    select
      score_order.*,
      mmr_picks.pick_position as sequence_position
    from mmr_picks
    join score_order on score_order.id = mmr_picks.item_id

    union all

    select
      score_order.*,
      mmr_pool_size.pick_count + row_number() over (
        order by score_order.final_score desc, score_order.published_at desc, score_order.id
      ) as sequence_position
    from score_order
    cross join mmr_pool_size
    where score_order.score_rank <= 100
      and not exists (
        select 1 from mmr_picks where mmr_picks.item_id = score_order.id
      )
  ),
  mmr_sequence as (
    select mmr_top.*
    from mmr_top
    union all
    select score_order.*, score_order.score_rank::integer as sequence_position
    from score_order
    where score_order.score_rank > 100
  ),
  main_sequence as (
    select
      ordered.*,
      row_number() over (order by ordered.sequence_position)::integer as main_position_final
    from (
      select
        score_order.*,
        score_order.score_rank::integer as sequence_position
      from score_order
      where diversity_value = 0
        or not score_order.has_likes
        or p_method not in ('nearest_liked', 'average_vector', 'top_m_mean', 'blend')

      union all

      select mmr_sequence.*
      from mmr_sequence
      where diversity_value > 0
        and exists (select 1 from profile where profile.has_likes)
        and p_method in ('nearest_liked', 'average_vector', 'top_m_mean', 'blend')
    ) as ordered
  ),
  liked_sources as (
    select distinct source_id from likes
  ),
  output_rows(output_position, item_id, placed_ids, is_exploration) as (
    select 0, null::uuid, '{}'::uuid[], false
    where greatest(coalesce(p_limit, 30), 0) > 0

    union all

    select
      output_rows.output_position + 1,
      selected.item_id,
      output_rows.placed_ids || selected.item_id,
      selected.is_exploration
    from output_rows
    cross join lateral (
      select choice.item_id, choice.is_exploration
      from (
        select
          main_sequence.id as item_id,
          true as is_exploration,
          0 as choice_priority,
          main_sequence.final_score as choice_score,
          main_sequence.published_at,
          main_sequence.main_position_final
        from main_sequence
        where exploration_value
          and main_sequence.has_likes
          and p_method in ('nearest_liked', 'average_vector', 'top_m_mean', 'blend')
          and output_rows.output_position + 1 in (5, 15, 25)
          and not (main_sequence.source_id in (select source_id from liked_sources))
          and not (main_sequence.id = any(output_rows.placed_ids))

        union all

        select
          main_sequence.id,
          false,
          1,
          main_sequence.final_score,
          main_sequence.published_at,
          main_sequence.main_position_final
        from main_sequence
        where not (main_sequence.id = any(output_rows.placed_ids))
      ) as choice
      order by
        choice.choice_priority,
        case when choice.choice_priority = 0 then choice.choice_score end desc,
        case when choice.choice_priority = 0 then choice.published_at end desc,
        choice.main_position_final,
        choice.item_id
      limit 1
    ) as selected
    where output_rows.output_position < greatest(coalesce(p_limit, 30), 0)
      and output_rows.output_position < (select count(*) from main_sequence)
  )
  select
    output_rows.item_id,
    case when p_method in ('newest_first', 'random') then null::double precision
      else main_sequence.final_score
    end,
    case
      when p_method in ('newest_first', 'random') then
        case when main_sequence.has_likes then main_sequence.like_because_item_id
          else null::uuid
        end
      when main_sequence.has_positive then main_sequence.because_item_id
      else null::uuid
    end,
    output_rows.is_exploration,
    case
      when p_method in ('newest_first', 'random') or not main_sequence.has_positive
        then null::uuid
      else main_sequence.because_preference_id
    end
  from output_rows
  join main_sequence on main_sequence.id = output_rows.item_id
  order by output_rows.output_position;
end;
$function$;
create function public.rank_items(
  p_candidate_ids uuid[],
  p_liked_ids uuid[],
  p_disliked_ids uuid[],
  p_as_of timestamptz,
  p_method text default 'blend',
  p_params jsonb default '{}'::jsonb,
  p_seed integer default 0,
  p_limit integer default 30,
  p_more_preference_ids uuid[] default '{}',
  p_less_preference_ids uuid[] default '{}',
  p_click_ids uuid[] default '{}'
)
returns table (
  item_id uuid,
  score double precision,
  because_item_id uuid,
  exploration boolean,
  because_preference_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    ranked.item_id,
    ranked.score,
    ranked.because_item_id,
    ranked.exploration,
    ranked.because_preference_id
  from ranking_private.rank_items(
    p_candidate_ids,
    p_liked_ids,
    p_disliked_ids,
    p_as_of,
    p_method,
    p_params,
    p_seed,
    p_limit,
    p_more_preference_ids,
    p_less_preference_ids,
    p_click_ids
  ) with ordinality as ranked(
    item_id,
    score,
    because_item_id,
    exploration,
    because_preference_id,
    rank_position
  )
  order by ranked.rank_position;
$$;
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
stable
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
  click_ids uuid[];
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

  with story_events as materialized (
    select
      event.item_id,
      max(event.event_at) as event_at
    from (
      select f.item_id, f.updated_at as event_at
      from public.feedback as f
      where f.user_id = caller_id
      union all
      select click.item_id, click.clicked_at
      from public.item_clicks as click
      where click.user_id = caller_id
    ) as event
    group by event.item_id
  ),
  story_refs as materialized (
    select
      (ci.embedding OPERATOR(extensions.-) means.mean) as centered
    from story_events as event
    join public.content_items as ci on ci.id = event.item_id
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where ci.published_at >= now() - interval '30 days'
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
      and extensions.vector_norm(ci.embedding OPERATOR(extensions.-) means.mean) > 0
    order by event.event_at desc, event.item_id
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
        from public.item_clicks as opened
        where opened.user_id = caller_id
          and opened.item_id = ci.id
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

  select coalesce(array_agg(opened.item_id order by opened.clicked_at desc, opened.item_id), '{}'::uuid[])
  into click_ids
  from (
    select click.item_id, click.clicked_at
    from public.item_clicks as click
    join public.content_items as ci on ci.id = click.item_id
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where click.user_id = caller_id
      and not exists (
        select 1
        from public.feedback as f
        where f.user_id = caller_id
          and f.item_id = click.item_id
      )
      and ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
    order by click.clicked_at desc, click.item_id
    limit 200
  ) as opened;

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
        when ranked.because_item_id = any(click_ids) then 'opened'
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
      less_preference_ids,
      click_ids
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

revoke all on function ranking_private.rank_items(
  uuid[], uuid[], uuid[], timestamptz, text, jsonb, integer, integer, uuid[], uuid[], uuid[]
) from public, anon;
grant execute on function ranking_private.rank_items(
  uuid[], uuid[], uuid[], timestamptz, text, jsonb, integer, integer, uuid[], uuid[], uuid[]
) to authenticated, service_role;

revoke all on function public.rank_items(
  uuid[], uuid[], uuid[], timestamptz, text, jsonb, integer, integer, uuid[], uuid[], uuid[]
) from public, anon, authenticated;
grant execute on function public.rank_items(
  uuid[], uuid[], uuid[], timestamptz, text, jsonb, integer, integer, uuid[], uuid[], uuid[]
) to service_role;

revoke all on function public.get_feed(integer, uuid[]) from public, anon;
grant execute on function public.get_feed(integer, uuid[]) to authenticated;

commit;
