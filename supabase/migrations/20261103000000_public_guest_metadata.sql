-- Public card metadata only. Keep authenticated grants/policies unchanged.
revoke all on table public.sources, public.content_items from anon;

grant select (id, name) on public.sources to anon;
grant select (
  id, source_id, url, title, summary, summary_origin,
  type, language, thumbnail_url, published_at
) on public.content_items to anon;

create policy "Guests can read active source metadata"
  on public.sources for select to anon
  using (is_active = true);

create policy "Guests can read recent completed content metadata"
  on public.content_items for select to anon
  using (
    enrichment_status = 'completed'
    and nullif(btrim(summary), '') is not null
    and url ~* '^https?://[^[:space:]]+'
    and published_at <= now()
    and published_at >= now() - case
      when type = 'video' then interval '30 days'
      else interval '7 days'
    end
    and source_id in (select id from public.sources)
  );
