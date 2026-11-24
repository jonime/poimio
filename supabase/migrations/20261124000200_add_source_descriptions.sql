alter table public.sources
  add column description text,
  add column description_generated_at timestamptz,
  add constraint sources_description_check
    check (description is null or (char_length(btrim(description)) > 0 and char_length(description) <= 300));
