begin;

create function public.find_existing_content_item_urls(p_urls text[])
returns table (url text)
language sql
stable
security invoker
set search_path = ''
as $$
  select content_items.url
  from public.content_items
  where content_items.url = any (p_urls);
$$;

revoke all on function public.find_existing_content_item_urls(text[]) from public, anon, authenticated;
grant execute on function public.find_existing_content_item_urls(text[]) to service_role;

commit;
