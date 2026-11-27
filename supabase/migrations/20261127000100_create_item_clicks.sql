begin;

create table public.item_clicks (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id uuid not null references public.content_items (id) on delete cascade,
  clicked_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index item_clicks_user_clicked_idx
  on public.item_clicks (user_id, clicked_at desc, item_id);

alter table public.item_clicks enable row level security;

revoke all on table public.item_clicks from anon, authenticated;
grant select, insert (item_id) on table public.item_clicks to authenticated;
grant all on table public.item_clicks to service_role;

create policy "Users can read their own item clicks"
  on public.item_clicks
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can record their own item clicks"
  on public.item_clicks
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create function public.record_click(p_item_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  if not exists (
    select 1
    from public.content_items as item
    where item.id = p_item_id
  ) then
    raise exception 'Item is not readable' using errcode = '22023';
  end if;

  insert into public.item_clicks (item_id)
  values (p_item_id)
  on conflict (user_id, item_id) do nothing;
end;
$$;

revoke all on function public.record_click(uuid) from public, anon;
grant execute on function public.record_click(uuid) to authenticated;

commit;
