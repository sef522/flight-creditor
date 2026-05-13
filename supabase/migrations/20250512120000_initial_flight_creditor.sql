-- flight-creditor: watched flights and price check history

create table if not exists public.watched_flights (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  confirmation_code text not null,
  airline text not null check (airline in ('DELTA', 'UNITED', 'AMERICAN', 'JETBLUE')),
  flight_number text not null,
  origin text not null,
  destination text not null,
  flight_date date not null,
  cabin_class text not null check (
    cabin_class in (
      'BASIC_ECONOMY',
      'MAIN_CABIN',
      'COMFORT_PLUS',
      'FIRST',
      'BUSINESS'
    )
  ),
  passengers integer not null check (passengers > 0),
  price_paid_per_person numeric(10, 2) not null,
  active boolean not null default true,
  added_by_telegram_user_id text
);

create index if not exists watched_flights_active_date_idx
  on public.watched_flights (active, flight_date)
  where active = true;

create index if not exists watched_flights_confirmation_idx
  on public.watched_flights (confirmation_code);

create table if not exists public.price_checks (
  id uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default now(),
  flight_id uuid not null references public.watched_flights (id) on delete cascade,
  current_price_per_person numeric(10, 2) not null,
  delta_per_person numeric(10, 2) not null,
  total_savings numeric(10, 2) not null,
  alert_sent boolean not null default false
);

create index if not exists price_checks_flight_checked_idx
  on public.price_checks (flight_id, checked_at desc);

-- Lock down direct Data API access for anon/authenticated; service_role bypasses RLS.
alter table public.watched_flights enable row level security;
alter table public.price_checks enable row level security;
