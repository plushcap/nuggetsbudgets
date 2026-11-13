-- Migration: backup runs
-- Created: 2026-11-13T21:40:28.875Z
--
-- A record of every backup run, failures included (control plane): when it started and
-- ended, what started it and how it went, a message written for people, the file it made
-- (name, size, SHA-256) and the fingerprints of the keys it was encrypted to, and when it
-- was last verified, by whom, and how that went. The Backup page shows it, and the backup
-- health check reads the last scheduled run from it after a restart. A restore keeps the
-- running server's rows. The daily retention job deletes rows over a year old whose file
-- is gone.

CREATE TABLE public.backup_runs (
    id serial PRIMARY KEY,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone NOT NULL,
    trigger text NOT NULL,
    outcome text NOT NULL,
    message text,
    file_name text,
    file_size bigint,
    sha256 text,
    recipients text[] DEFAULT '{}'::text[] NOT NULL,
    started_by integer,
    verified_at timestamp with time zone,
    verified_by integer,
    verify_outcome text,
    verify_message text,
    CONSTRAINT backup_runs_uuid_key UNIQUE (uuid),
    CONSTRAINT backup_runs_trigger_check CHECK (trigger IN ('manual', 'scheduled', 'before-deletion')),
    CONSTRAINT backup_runs_outcome_check CHECK (outcome IN ('succeeded', 'failed')),
    CONSTRAINT backup_runs_file_check CHECK (outcome = 'failed' OR file_name IS NOT NULL),
    CONSTRAINT backup_runs_verify_outcome_check CHECK (verify_outcome IN ('passed', 'failed')),
    CONSTRAINT backup_runs_verified_check CHECK ((verified_at IS NULL) = (verify_outcome IS NULL)),
    CONSTRAINT backup_runs_message_check CHECK (length(message) <= 2000 AND length(verify_message) <= 2000),
    CONSTRAINT backup_runs_started_by_fkey FOREIGN KEY (started_by) REFERENCES public.users(id) ON DELETE SET NULL,
    CONSTRAINT backup_runs_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX backup_runs_file_name_key ON public.backup_runs USING btree (file_name) WHERE file_name IS NOT NULL;
CREATE INDEX idx_backup_runs_started_at ON public.backup_runs USING btree (started_at);
CREATE INDEX idx_backup_runs_started_by ON public.backup_runs USING btree (started_by);
CREATE INDEX idx_backup_runs_verified_by ON public.backup_runs USING btree (verified_by);

COMMENT ON TABLE public.backup_runs IS 'Every backup run, failures included (control plane): what the Backup page''s history shows, and the backup health check''s last scheduled run after a restart.';
COMMENT ON COLUMN public.backup_runs.trigger IS 'What started it: manual (the Backup page), scheduled, or before-deletion (Data Management''s "Back up first").';
COMMENT ON COLUMN public.backup_runs.message IS 'Why it failed, written for people (never an internal error''s text); NULL when it succeeded.';
COMMENT ON COLUMN public.backup_runs.recipients IS 'The fingerprints of the backup keys an age backup was encrypted to; empty for an .enc one.';
COMMENT ON COLUMN public.backup_runs.verified_at IS 'When the backup was last verified (restored into a scratch database and checked), in the web app or with the restore command.';

-- === DOWN ===

DROP TABLE public.backup_runs;
