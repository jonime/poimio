update public.content_items
set embedding = null,
    embedding_model = null
where enrichment_status <> 'completed'
  and (embedding is not null or embedding_model is not null);

alter table public.content_items
  add constraint content_items_unresolved_embedding_check
    check (
      enrichment_status = 'completed'
      or (embedding is null and embedding_model is null)
    );
