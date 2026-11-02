create or replace function public.rank_items(
  p_candidate_ids uuid[],
  p_liked_ids uuid[],
  p_disliked_ids uuid[],
  p_as_of timestamptz,
  p_method text default 'nearest_liked',
  p_params jsonb default '{}',
  p_seed integer default 0,
  p_limit integer default 30
)
returns table (
  item_id uuid,
  score double precision,
  because_item_id uuid
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  active_model constant text := 'text-embedding-3-small@512';
  parameters jsonb := coalesce(p_params, '{}'::jsonb);
  unknown_parameter text;
  lambda_value double precision := 0.5;
  recency_weight_value double precision := 0.1;
  dislike_threshold_value double precision := 0.4;
  article_half_life_hours double precision := 24;
  video_half_life_hours double precision := 168;
  centered_value boolean := true;
begin
  if p_method not in ('nearest_liked', 'average_vector', 'newest_first', 'random') then
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
    'centered'
  )
  limit 1;
  if unknown_parameter is not null then
    raise exception 'Unknown ranking parameter: %', unknown_parameter;
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

  return query
  with eligible_items as (
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
    select ci.id, ci.embedding, means.mean
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
  profile as (
    select exists (select 1 from likes) as has_likes
  ),
  average_signal as (
    select extensions.avg(
      case when centered_value
        then liked.embedding OPERATOR(extensions.-) liked.mean
        else liked.embedding
      end
    ) as vector
    from likes as liked
  ),
  candidate_scores as (
    select
      candidate.*,
      profile.has_likes,
      closest_like.id as because_item_id,
      closest_like.similarity as liked_similarity,
      coalesce(closest_dislike.similarity, 0) as disliked_similarity,
      average_score.similarity as average_similarity
    from eligible_items as candidate
    join public.sources as source on source.id = candidate.source_id
    cross join profile
    cross join average_signal
    left join lateral (
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
      order by similarity desc, liked.id
      limit 1
    ) as closest_like on true
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
        when candidate_scores.has_likes then
          case when p_method = 'average_vector'
            then coalesce(candidate_scores.average_similarity, 0)
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
        when not candidate_scores.has_likes
          and candidate_scores.disliked_similarity >= dislike_threshold_value
          then 1
        else 0
      end as cold_start_dislike_order,
      row_number() over (
        partition by candidate_scores.source_id,
          case
            when not candidate_scores.has_likes
              and candidate_scores.disliked_similarity >= dislike_threshold_value
              then 1
            else 0
          end
        order by candidate_scores.published_at desc, candidate_scores.id
      ) as source_position
    from candidate_scores
  )
  select
    ranked_candidates.id,
    case when p_method in ('newest_first', 'random') then null::double precision
      else ranked_candidates.final_score
    end,
    case when ranked_candidates.has_likes then ranked_candidates.because_item_id
      else null::uuid
    end
  from ranked_candidates
  order by
    case when p_method = 'random'
      then md5(ranked_candidates.id::text || coalesce(p_seed, 0)::text)
    end,
    case when p_method = 'newest_first' then ranked_candidates.published_at end desc,
    case when p_method = 'newest_first' then ranked_candidates.id end,
    case when p_method in ('nearest_liked', 'average_vector')
        and ranked_candidates.has_likes
      then ranked_candidates.final_score
    end desc nulls last,
    case when p_method in ('nearest_liked', 'average_vector')
        and not ranked_candidates.has_likes
      then ranked_candidates.cold_start_dislike_order
    end,
    case when p_method in ('nearest_liked', 'average_vector')
        and not ranked_candidates.has_likes
      then ranked_candidates.source_position
    end,
    case when p_method in ('nearest_liked', 'average_vector')
        and not ranked_candidates.has_likes
      then ranked_candidates.source_id
    end,
    ranked_candidates.published_at desc,
    ranked_candidates.id
  limit greatest(coalesce(p_limit, 30), 0);
end;
$$;