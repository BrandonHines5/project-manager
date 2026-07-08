-- Per-user Quo (OpenPhone) numbers.
--
-- Goal: track texts & calls per team member. When a staffer sends an
-- automated text (bid invite, PO release, assignment notice, manual text,
-- hub reply, AI apply), it goes out from THEIR Quo number instead of the one
-- shared business number, so the sub's reply — and any follow-up call — comes
-- back to that person. The Quo webhook then attributes native texts/calls
-- (typed/dialed directly in the Quo mobile app) back to the owner of the
-- number they were sent from.
--
-- quo_phone_number_id  the OpenPhone phone-number id ("PN..."), used as the
--                      `from` on API sends (stable across number re-labeling).
-- quo_phone_number     the same number in E.164, used for display and for the
--                      webhook's reverse lookup (business-side number -> owner)
--                      when a provider event omits phoneNumberId.
--
-- Both nullable: a staffer with no number assigned falls back to
-- QUO_FROM_NUMBER, so this ships safely before every seat has its own number.
alter table public.profiles
  add column if not exists quo_phone_number_id text,
  add column if not exists quo_phone_number    text;

-- The two columns are one logical assignment — keep them set/unset together so
-- the id (send `from`) and E.164 (display + webhook reverse-lookup) can't drift
-- apart. The Team update action always writes both; this is the DB backstop.
do $$ begin
  alter table public.profiles
    add constraint profiles_quo_number_pair_check
    check ((quo_phone_number_id is null) = (quo_phone_number is null));
exception when duplicate_object then null; end $$;

-- A Quo number belongs to at most one person (tracking is 1:1). Partial so
-- the many unassigned staff (null) never collide with each other.
create unique index if not exists idx_profiles_quo_phone_number_id
  on public.profiles(quo_phone_number_id)
  where quo_phone_number_id is not null;

create unique index if not exists idx_profiles_quo_phone_number
  on public.profiles(quo_phone_number)
  where quo_phone_number is not null;

comment on column public.profiles.quo_phone_number_id is
  'OpenPhone/Quo phone-number id ("PN...") this person sends from; null = use the shared QUO_FROM_NUMBER.';
comment on column public.profiles.quo_phone_number is
  'E.164 of this person''s Quo number; used for display and webhook reverse-attribution.';
