-- Minimal shim recreating what Supabase's platform normally provides
-- (auth.users, auth.uid(), auth.role(), the anon/authenticated/service_role
-- roles), same approach as Phase 1's Gate 1 verification (see
-- docs/DECISIONS.md D1.4), extended here with a real PostgREST
-- `authenticator` role so the Gate 3 e2e suite runs against a genuine
-- PostgREST HTTP API instead of calling Postgres directly — see D3.1.
--
-- Applied once per ephemeral test database by
-- apps/api/test/e2e/global-setup.ts, before the real
-- supabase/migrations/*.sql files (applied unmodified).

create schema if not exists auth;
create schema if not exists extensions;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'role', '')
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'authenticator';
  end if;
end
$$;

grant anon to authenticator;
grant authenticated to authenticator;
grant service_role to authenticator;
grant anon to postgres;
grant authenticated to postgres;
grant service_role to postgres;

grant usage on schema auth to anon, authenticated, service_role, authenticator;
grant select on auth.users to anon, authenticated, service_role, authenticator;
grant usage on schema public to authenticator;
