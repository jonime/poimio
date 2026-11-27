begin;

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
revoke all on table public.admins from public, anon, authenticated;
grant select on table public.admins to authenticated;
grant all on table public.admins to service_role;

create policy "Users can read their own admin membership"
  on public.admins
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.admins
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create table public.source_candidates (
  id uuid primary key default gen_random_uuid(),
  origin text not null check (origin in ('catalog', 'web_search')),
  source_id uuid references public.sources (id) on delete cascade,
  name text not null check (char_length(btrim(name)) > 0),
  feed_url text not null unique check (char_length(btrim(feed_url)) > 0),
  site_url text,
  kind text not null check (kind in ('rss', 'youtube')),
  language text not null check (language in ('fi', 'en')),
  status text not null default 'pending'
    check (status in ('pending', 'failed', 'approved', 'rejected')),
  failure text check (failure is null or char_length(failure) <= 64),
  item_count integer check (item_count is null or item_count >= 0),
  items_per_day numeric check (items_per_day is null or items_per_day >= 0),
  relevance text not null default 'not_scored'
    check (relevance in ('high', 'medium', 'low', 'not_scored')),
  relevance_basis text check (relevance_basis in ('all_users', 'admin')),
  mean_match_share numeric check (mean_match_share is null or mean_match_share between 0 and 1),
  duplicate_share numeric check (duplicate_share is null or duplicate_share between 0 and 1),
  sample_titles text[] not null default '{}'
    check (cardinality(sample_titles) <= 5),
  scanned_at timestamptz,
  decided_at timestamptz,
  check ((origin = 'catalog' and source_id is not null) or origin = 'web_search'),
  check (
    (relevance = 'not_scored' and relevance_basis is null and mean_match_share is null)
    or (relevance <> 'not_scored' and relevance_basis is not null and mean_match_share is not null)
  ),
  check ((status in ('approved', 'rejected')) = (decided_at is not null))
);

create index source_candidates_status_idx on public.source_candidates (status);
create index source_candidates_source_id_idx on public.source_candidates (source_id);

alter table public.source_candidates enable row level security;
revoke all on table public.source_candidates from public, anon, authenticated;
grant select on table public.source_candidates to authenticated;
grant all on table public.source_candidates to service_role;

create policy "Admins can read source candidates"
  on public.source_candidates
  for select
  to authenticated
  using ((select public.is_admin()));

create table public.source_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('catalog', 'web_search')),
  started_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz,
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed')),
  failures jsonb not null default '[]'::jsonb
    check (jsonb_typeof(failures) = 'array' and jsonb_array_length(failures) <= 10)
);

create index source_discovery_runs_started_idx on public.source_discovery_runs (started_at desc);
create index source_discovery_runs_lease_idx
  on public.source_discovery_runs (lease_expires_at)
  where status = 'running';

alter table public.source_discovery_runs enable row level security;
revoke all on table public.source_discovery_runs from public, anon, authenticated;
grant select on table public.source_discovery_runs to authenticated;
grant all on table public.source_discovery_runs to service_role;

create policy "Admins can read source discovery runs"
  on public.source_discovery_runs
  for select
  to authenticated
  using ((select public.is_admin()));

create function public.normalize_source_feed_url(p_feed_url text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  parts text[];
  scheme text;
  authority text;
  host text;
  port text;
  suffix text;
begin
  parts := pg_catalog.regexp_match(
    pg_catalog.btrim(p_feed_url),
    '^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^#]*)(?:#.*)?$'
  );
  if parts is null then
    return null;
  end if;

  scheme := pg_catalog.lower(parts[1]);
  authority := parts[2];
  suffix := parts[3];
  if scheme not in ('http', 'https') or authority = '' or pg_catalog.strpos(authority, '@') > 0 then
    return null;
  end if;

  if authority ~ '^\[[0-9A-Fa-f:.]+\](?::[0-9]+)?$' then
    host := pg_catalog.lower(substring(authority from '^\[([0-9A-Fa-f:.]+)\]'));
    port := substring(authority from '^\[[^]]+\]:([0-9]+)$');
    host := '[' || host || ']';
  elsif authority ~ '^[^:]+(?::[0-9]+)?$' then
    host := pg_catalog.lower(pg_catalog.regexp_replace(authority, ':[0-9]+$', ''));
    port := substring(authority from ':([0-9]+)$');
  else
    return null;
  end if;

  if host = '' or (port is not null and port::integer not between 1 and 65535) then
    return null;
  end if;
  if (scheme = 'http' and port = '80') or (scheme = 'https' and port = '443') then
    port := null;
  end if;

  return scheme || '://' || host || coalesce(':' || port, '') || suffix;
end;
$$;

revoke all on function public.normalize_source_feed_url(text) from public, anon, authenticated;
grant execute on function public.normalize_source_feed_url(text) to service_role;

create function public.decide_source_candidate(p_candidate_id uuid, p_decision text)
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  candidate public.source_candidates%rowtype;
  source_feed_url text;
  updated_count integer;
begin
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'Invalid source candidate decision' using errcode = '22023';
  end if;

  select *
  into candidate
  from public.source_candidates
  where id = p_candidate_id
  for update;

  if not found then
    return 'not_found';
  end if;
  if candidate.status <> 'pending' then
    if (p_decision = 'approve' and candidate.status = 'approved')
      or (p_decision = 'reject' and candidate.status = 'rejected') then
      return 'unchanged';
    end if;
    return 'already_decided';
  end if;
  if candidate.origin <> 'catalog' then
    return 'unsupported';
  end if;

  if p_decision = 'reject' then
    update public.source_candidates
    set status = 'rejected', decided_at = pg_catalog.now()
    where id = candidate.id;
    return 'rejected';
  end if;

  select feed_url
  into source_feed_url
  from public.sources
  where id = candidate.source_id
  for update;

  if not found or public.normalize_source_feed_url(source_feed_url)
    is distinct from candidate.feed_url then
    return 'stale';
  end if;

  update public.sources
  set is_active = true
  where id = candidate.source_id;

  update public.source_candidates
  set status = 'approved', decided_at = pg_catalog.now()
  where id = candidate.id;
  get diagnostics updated_count = row_count;

  if updated_count <> 1 then
    raise exception 'Could not decide source candidate';
  end if;
  return 'approved';
end;
$$;

revoke all on function public.decide_source_candidate(uuid, text) from public, anon, authenticated;
grant execute on function public.decide_source_candidate(uuid, text) to service_role;

commit;
