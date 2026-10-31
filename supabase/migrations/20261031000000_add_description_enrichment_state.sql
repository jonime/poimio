alter table public.content_items
  add column summary_origin text,
  add column enrichment_status text not null default 'pending',
  add column enrichment_attempt_count integer not null default 0,
  add column enrichment_last_attempt_at timestamptz,
  add column enrichment_next_attempt_at timestamptz,
  add column enrichment_error text;

update public.content_items
set summary_origin = case
      when nullif(btrim(summary), '') is not null then 'feed'
      else null
    end,
    enrichment_status = case
      when nullif(btrim(summary), '') is not null then 'completed'
      else 'pending'
    end;

alter table public.content_items
  add constraint content_items_summary_origin_check
    check (summary_origin is null or summary_origin in ('feed', 'page_metadata', 'ai_generated')),
  add constraint content_items_enrichment_status_check
    check (enrichment_status in ('pending', 'completed', 'exhausted')),
  add constraint content_items_enrichment_attempt_count_check
    check (enrichment_attempt_count >= 0),
  add constraint content_items_enrichment_error_length_check
    check (enrichment_error is null or char_length(enrichment_error) <= 500),
  add constraint content_items_enrichment_state_check
    check (
      (
        enrichment_status = 'completed'
        and summary_origin is not null
        and nullif(btrim(summary), '') is not null
        and enrichment_next_attempt_at is null
        and enrichment_error is null
      )
      or (
        enrichment_status = 'pending'
        and summary_origin is null
        and nullif(btrim(summary), '') is null
        and (
          (enrichment_attempt_count = 0
            and enrichment_last_attempt_at is null
            and enrichment_next_attempt_at is null
            and enrichment_error is null)
          or (enrichment_attempt_count > 0
            and enrichment_last_attempt_at is not null
            and enrichment_next_attempt_at is not null
            and enrichment_error is not null
            and char_length(enrichment_error) > 0)
        )
      )
      or (
        enrichment_status = 'exhausted'
        and summary_origin is null
        and nullif(btrim(summary), '') is null
        and enrichment_attempt_count > 0
        and enrichment_last_attempt_at is not null
        and enrichment_next_attempt_at is null
        and enrichment_error is not null
        and char_length(enrichment_error) > 0
      )
    );

create index content_items_enrichment_due_idx
  on public.content_items (enrichment_next_attempt_at, created_at)
  where enrichment_status = 'pending';

create index content_items_missing_embedding_idx
  on public.content_items (created_at)
  where enrichment_status = 'completed' and embedding is null;
