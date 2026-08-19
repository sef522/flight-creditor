-- Audit fields so round-trip fare splits can be reconstructed from the original total.
alter table public.watched_flights
  add column if not exists is_round_trip boolean not null default false;

alter table public.watched_flights
  add column if not exists total_fare_paid numeric(10, 2);

update public.watched_flights
  set total_fare_paid = price_paid_per_person
  where total_fare_paid is null;
