-- Migration: archive budget periods
-- Created: 2026-11-12T22:17:13.062Z
--
-- A period with transactions can't be deleted any more; a member archives it instead, which
-- hides it from the period pickers and keeps its transactions and budget. archived_at is the
-- instant it was archived, NULL while it is shown.

ALTER TABLE public.budget_period ADD COLUMN archived_at timestamp with time zone;

COMMENT ON COLUMN public.budget_period.archived_at IS 'When a member archived the period, which hides it from the period pickers and keeps its transactions and budget; NULL while it is shown.';

-- === DOWN ===

ALTER TABLE public.budget_period DROP COLUMN archived_at;
