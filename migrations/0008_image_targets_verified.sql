-- 0008_image_targets_verified.sql
--
-- One column: how thoroughly a cached target set has been examined.
--
-- Until v6 nothing ever checked a bounding box. The model drew one, the route
-- range-checked its numbers, and that was the whole audit: a box could point at
-- the pavement beside the parking sign and pass, because 0.4 is a perfectly
-- valid number. The fifth playtest filmed the result, twice in one session.
--
-- v6 cuts each box out of the picture and shows it to the vision model ON ITS
-- OWN, with nothing else in frame to be reminded by. That check costs a call,
-- so its result has to be remembered, and remembered separately from `v`:
--
--   `v`        is the SHAPE of a row. Bumping it discards the row entirely and
--              re-bills a full generation for every picture anyone has played.
--   `verified` is how far the row has been AUDITED. A row can be perfectly
--              well-shaped and still have never been looked at.
--
-- Keeping them apart is what lets every existing row be crop-checked once, on
-- its next read, and then written back, rather than thrown away. Null means
-- "never examined", which is exactly what every row written before today is.

alter table public.image_targets
  add column if not exists verified integer;

comment on column public.image_targets.verified is
  'Audit level of this row''s boxes. NULL = never crop-checked. 2 = every box was cut out and confirmed by the vision model on its own, with failures re-localized once and then dropped. Distinct from v, which is the row SHAPE: bumping v discards the row, bumping this re-examines it in place.';
