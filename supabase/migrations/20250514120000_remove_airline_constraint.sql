-- Allow any airline identifier (IATA code or short name), not only US majors.
alter table public.watched_flights drop constraint if exists watched_flights_airline_check;
