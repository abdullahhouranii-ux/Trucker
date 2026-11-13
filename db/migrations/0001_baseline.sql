-- 0001_baseline
-- Establishes the migration history and the application schema. No business tables:
-- those are added only after their gating decisions are recorded (docs/specs).

CREATE SCHEMA IF NOT EXISTS trucker;

COMMENT ON SCHEMA trucker IS
  'Trucker application objects. Empty in the foundation slice.';
