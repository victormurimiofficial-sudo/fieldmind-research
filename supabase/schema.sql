create extension if not exists pgcrypto;

create table if not exists public.fieldmind_records (
  id uuid primary key default gen_random_uuid(),
  collection text not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fieldmind_records_collection_idx on public.fieldmind_records (collection);
create index if not exists fieldmind_records_record_id_idx on public.fieldmind_records ((record->>'id'));
alter table public.fieldmind_records enable row level security;
revoke all on public.fieldmind_records from anon, authenticated;
grant all on public.fieldmind_records to service_role;