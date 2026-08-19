-- One-off correction for round-trip rows that stored the combined fare as each leg's baseline.
-- Run AFTER 20260819143000_add_round_trip_fare_fields.sql.
-- Do not apply to one-way bookings (e.g. JNNVYI).
--
-- Confirmed affected rows (2026-08-19):
--   SMEIVY AS227 JFK→PSP 2026-12-11  price_paid_per_person = 476.80
--   SMEIVY AS20  PSP→JFK 2026-12-13  price_paid_per_person = 476.80
-- No other active two-leg reciprocal confirmations existed at that time.

update public.watched_flights
set
  is_round_trip = true,
  total_fare_paid = 476.80,
  price_paid_per_person = 238.40
where id in (
  '015ce930-40da-492c-9f1f-54c5c46d8518',
  '3da57cba-933f-4709-89ba-5ed34bc6abe7'
)
  and price_paid_per_person = 476.80;
