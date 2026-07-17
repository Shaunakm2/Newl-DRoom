-- ============================================================
-- Room Booking App — Supabase schema
-- Run this in Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. BOOKINGS TABLE ------------------------------------------------
create table if not exists public.bookings (
  booking_id        text primary key,
  room              text not null check (room in (
                      'brihaspati','vedvyas','conf2f','parashurama','pingala',
                      'chanakya','bhardwaja','vishwamitra','vasistha','sharada'
                    )),
  booked_by         text not null check (char_length(booked_by) <= 80),
  purpose           text check (char_length(purpose) <= 100),
  booking_date      date not null,
  start_time        time not null,
  end_time          time not null,
  attendees         integer check (attendees between 1 and 500),
  status            text not null default 'Confirmed'
                      check (status in ('Confirmed','Pending','Cancelled','Rejected')),
  end_date          date,
  conflict_resolved boolean not null default false,
  conflict_note     text,
  created_at        timestamptz not null default now()
);

create index if not exists idx_bookings_date on public.bookings (booking_date);
create index if not exists idx_bookings_room_date on public.bookings (room, booking_date);
create index if not exists idx_bookings_status on public.bookings (status);

-- 2. ROW LEVEL SECURITY --------------------------------------------
alter table public.bookings enable row level security;

-- Anyone (anon key, i.e. the public status board) can read all bookings.
create policy "Public can view bookings"
  on public.bookings for select
  using (true);

-- Anyone can create a booking REQUEST, but it must land as Pending.
-- (Confirmed bookings are only ever created by a logged-in admin.)
create policy "Public can create pending requests"
  on public.bookings for insert
  with check (status = 'Pending');

-- Only logged-in admins (Supabase Auth session) can insert Confirmed bookings,
-- update anything, or delete anything.
create policy "Admins can insert any booking"
  on public.bookings for insert
  to authenticated
  with check (true);

create policy "Admins can update bookings"
  on public.bookings for update
  to authenticated
  using (true)
  with check (true);

create policy "Admins can delete bookings"
  on public.bookings for delete
  to authenticated
  using (true);

-- 3. SELF-SERVICE CANCELLATION (secure RPC) -------------------------
-- The public "Cancel My Booking" flow lets a non-admin cancel their own
-- booking by typing their name. We do NOT trust the client to verify the
-- name match (that used to happen only in JS) — this function re-checks
-- it server-side with SECURITY DEFINER, bypassing RLS safely, and is the
-- ONLY way an anonymous caller can change a row's status.
create or replace function public.cancel_own_booking(p_booking_id text, p_booker_name text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.bookings;
begin
  select * into v_row from public.bookings where booking_id = p_booking_id;

  if v_row is null then
    return json_build_object('ok', false, 'error', 'Not found: ' || p_booking_id);
  end if;

  if lower(trim(v_row.booked_by)) <> lower(trim(p_booker_name)) then
    return json_build_object('ok', false, 'error', 'Name does not match booking.');
  end if;

  if v_row.status = 'Cancelled' then
    return json_build_object('ok', false, 'error', 'Booking already cancelled.');
  end if;

  update public.bookings set status = 'Cancelled' where booking_id = p_booking_id;

  return json_build_object('ok', true, 'action', 'cancelled', 'BookingID', p_booking_id);
end;
$$;

-- Allow anon + authenticated to call the RPC (the function itself does the
-- real authorization check above — this grant just lets the call through).
grant execute on function public.cancel_own_booking(text, text) to anon, authenticated;

-- 4. ARCHIVE TABLE (optional, mirrors the old Google Sheet "Archive" tab) --
create table if not exists public.bookings_archive (like public.bookings including all);

-- Moves bookings older than N days (default 90) to the archive table.
-- Call manually, or schedule with pg_cron (see README).
create or replace function public.archive_old_bookings(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with moved as (
    delete from public.bookings
    where booking_date < (current_date - p_days)
      and status <> 'Pending'
    returning *
  )
  insert into public.bookings_archive select * from moved;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 5. REALTIME (optional but recommended) -----------------------------
-- Lets the frontend subscribe to live changes instead of polling.
alter publication supabase_realtime add table public.bookings;
