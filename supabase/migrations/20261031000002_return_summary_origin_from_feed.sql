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
  dislike_penalty constant double precision := 0.5;
  recency_weight constant double precision := 0.1;
  dislike_threshold constant double precision := 0.4;
  article_window constant interval := interval '7 days';
  video_window constant interval := interval '30 days';
  article_half_life constant interval := interval '24 hours';
  video_half_life constant interval := interval '7 days';
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  return query
  with eligible_items as (
    select
      ci.id,
      ci.url,
      ci.title,
      ci.summary,
      ci.summary_origin,
      ci.type,
      ci.language,
      ci.thumbnail_url,
      ci.published_at,
      ci.source_id,
      ci.embedding,
      means.mean
    from public.content_items as ci
    join public.embedding_language_means as means
      on means.embedding_model = ci.embedding_model
      and means.language = ci.language
    where ci.embedding_model = active_model
      and ci.embedding is not null
      and ci.enrichment_status = 'completed'
      and nullif(btrim(ci.summary), '') is not null
  ),
  liked_items as (
    select
      eligible.*,
      feedback.updated_at
    from public.feedback as feedback
    join eligible_items as eligible on eligible.id = feedback.item_id
    where feedback.user_id = caller_id
      and feedback.kind = 'like'
    order by feedback.updated_at desc, eligible.id
    limit 200
  ),
  disliked_items as (
    select
      eligible.*,
      feedback.updated_at
    from public.feedback as feedback
    join eligible_items as eligible on eligible.id = feedback.item_id
    where feedback.user_id = caller_id
      and feedback.kind = 'not_interested'
    order by feedback.updated_at desc, eligible.id
    limit 200
  ),
  profile as (
    select exists (select 1 from liked_items) as has_likes
  ),
  candidates as (
    select
      eligible.*,
      source.name as source_name,
      profile.has_likes,
      closest_dislike.similarity as disliked_similarity,
      row_number() over (
        partition by eligible.source_id,
          case
            when not profile.has_likes
              and coalesce(closest_dislike.similarity, 0) >= dislike_threshold
              then 1
            else 0
          end
        order by eligible.published_at desc, eligible.id
      ) as source_position
    from eligible_items as eligible
    join public.sources as source on source.id = eligible.source_id
    cross join profile
    left join lateral (
      select max(public.centered_similarity(
        eligible.embedding,
        eligible.mean,
        disliked.embedding,
        disliked.mean
      )) as similarity
      from disliked_items as disliked
    ) as closest_dislike on true
    where eligible.published_at >= now() - case
        when eligible.type = 'video' then video_window
        else article_window
      end
      and not (eligible.id = any(excluded_ids))
      and not exists (
        select 1
        from public.feedback as rated
        where rated.user_id = caller_id
          and rated.item_id = eligible.id
      )
  ),
  scored as (
    select
      candidate.*,
      closest_like.because_item_id,
      closest_like.because_title,
      closest_like.similarity as liked_similarity
    from candidates as candidate
    left join lateral (
      select
        liked.id as because_item_id,
        liked.title as because_title,
        public.centered_similarity(
          candidate.embedding,
          candidate.mean,
          liked.embedding,
          liked.mean
        ) as similarity
      from liked_items as liked
      order by similarity desc, liked.updated_at desc, liked.id
      limit 1
    ) as closest_like on true
  ),
  ranked as (
    select
      scored.*,
      case
        when scored.has_likes then
          coalesce(scored.liked_similarity, 0)
          - dislike_penalty * coalesce(scored.disliked_similarity, 0)
          + recency_weight * power(
            0.5::double precision,
            greatest(extract(epoch from (now() - scored.published_at)), 0)
            / extract(epoch from case
                when scored.type = 'video' then video_half_life
                else article_half_life
              end)
          )
        else power(
          0.5::double precision,
          greatest(extract(epoch from (now() - scored.published_at)), 0)
          / extract(epoch from case
              when scored.type = 'video' then video_half_life
              else article_half_life
            end)
        )
      end as final_score,
      case
        when not scored.has_likes
          and coalesce(scored.disliked_similarity, 0) >= dislike_threshold
          then 1
        else 0
      end as cold_start_dislike_order
    from scored
  )
  select
    ranked.id,
    ranked.url,
    ranked.title,
    ranked.summary,
    ranked.summary_origin,
    ranked.type,
    ranked.language,
    ranked.thumbnail_url,
    ranked.published_at,
    ranked.source_name,
    ranked.final_score,
    case when ranked.has_likes then 'similar' else 'recent' end,
    case when ranked.has_likes then ranked.because_item_id else null end,
    case when ranked.has_likes then ranked.because_title else null end
  from ranked
  order by
    case when ranked.has_likes then ranked.final_score end desc nulls last,
    case when not ranked.has_likes then ranked.cold_start_dislike_order end,
    case when not ranked.has_likes then ranked.source_position end,
    case when not ranked.has_likes then ranked.source_id end,
    case when not ranked.has_likes then ranked.published_at end desc,
    case when ranked.has_likes then ranked.published_at end desc,
    ranked.id
  limit requested_limit;
end;
$$;

revoke all on function public.get_feed(integer, uuid[]) from public, anon;
grant execute on function public.get_feed(integer, uuid[]) to authenticated;
