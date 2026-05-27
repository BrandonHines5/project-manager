-- Project geo coordinates for the onsite check-in feature.
-- Browser geolocation on the /onsite page compares the PM's position to these
-- values; when within ~200m of the recorded point, schedule prompts unlock.
-- Coordinates are entered manually on the project edit form (paste from
-- Google Maps). No auto-geocoding service is wired in.

alter table public.projects
  add column if not exists latitude numeric(9,6),
  add column if not exists longitude numeric(9,6);

alter table public.projects
  drop constraint if exists projects_lat_range,
  drop constraint if exists projects_lng_range;

alter table public.projects
  add constraint projects_lat_range
    check (latitude is null or (latitude between -90 and 90)),
  add constraint projects_lng_range
    check (longitude is null or (longitude between -180 and 180));

comment on column public.projects.latitude is
  'Jobsite latitude (decimal degrees). Used by the onsite check-in geofence. Manually entered.';
comment on column public.projects.longitude is
  'Jobsite longitude (decimal degrees). Used by the onsite check-in geofence. Manually entered.';
