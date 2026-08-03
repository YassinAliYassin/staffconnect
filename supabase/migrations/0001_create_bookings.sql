-- StaffConnect bookings table (Supabase Postgres)
-- Run in the Supabase SQL editor: supabase/migrations or dashboard SQL.

create table if not exists public.bookings (
  id bigserial primary key,
  ref text unique not null,
  role text not null,
  event_date text not null,
  start_time text not null default '',
  end_time text not null default '',
  headcount integer not null,
  venue text not null,
  name text not null,
  phone text not null,
  email text,
  notes text,
  status text not null default 'new',
  whatsapp_text text,
  created_at timestamptz not null default now()
);

alter table public.bookings enable row level security;

-- Anyone (public insert) may create a booking.
create policy "public insert bookings" on public.bookings
  for insert to anon, authenticated
  with check (true);

-- Reads and updates are admin-only. The server uses the secret key which
-- bypasses RLS (service role), so admin reads go through the API.
create policy "no public read" on public.bookings
  for select to anon
  using (false);

create index if not exists bookings_created_idx on public.bookings (created_at desc);
