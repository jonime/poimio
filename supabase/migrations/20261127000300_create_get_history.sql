begin;

drop function if exists public.get_history(integer, timestamptz, uuid);

create function public.get_history(
  p_limit integer default 20,
  p_before_at timestamptz default null,
  p_before_id uuid default null
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
  source_id uuid,
  event_at timestamptz,
  opened boolean,
  seen boolean,
  feedback_kind text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with events as (
    select
      click.item_id,
      click.clicked_at as event_at,
      true as opened,
      false as seen
    from public.item_clicks as click
    where click.user_id = (select auth.uid())

    union all

    select
      feedback.item_id,
      feedback.updated_at as event_at,
      false as opened,
      true as seen
    from public.feedback as feedback
    where feedback.user_id = (select auth.uid())
      and feedback.kind = 'seen'
  ),
  history_events as (
    select
      event.item_id,
      max(event.event_at) as event_at,
      bool_or(event.opened) as opened,
      bool_or(event.seen) as seen
    from events as event
    group by event.item_id
  ),
  rows_after_cursor as (
    select history.*
    from history_events as history
    where p_before_at is null
      or (history.event_at, history.item_id) < (p_before_at, p_before_id)
  )
  select
    item.id,
    item.url,
    item.title,
    item.summary,
    item.summary_origin,
    item.type,
    item.language,
    item.thumbnail_url,
    item.published_at,
    source.name as source_name,
    item.source_id,
    history.event_at,
    history.opened,
    history.seen,
    feedback.kind as feedback_kind
  from rows_after_cursor as history
  join public.content_items as item on item.id = history.item_id
  join public.sources as source on source.id = item.source_id
  left join public.feedback as feedback
    on feedback.user_id = (select auth.uid())
    and feedback.item_id = history.item_id
  where (select auth.uid()) is not null
    and ((p_before_at is null) = (p_before_id is null))
  order by history.event_at desc, history.item_id desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

revoke all on function public.get_history(integer, timestamptz, uuid) from public, anon;
grant execute on function public.get_history(integer, timestamptz, uuid) to authenticated;

commit;
