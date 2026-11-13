-- Migration: backup recipients
-- Created: 2026-11-13T22:18:00.000Z
--
-- Backups are encrypted with age to the owner's public keys ("recipients"); the private
-- keys that open them never reach the server. This control-plane table holds the public
-- keys, up to five, all of one kind (classic or post-quantum). A post-quantum key is 1,959
-- characters, more than system_settings.setting_value (varchar(500)) holds.

CREATE TABLE public.backup_recipients (
    id serial PRIMARY KEY,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    recipient text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    checked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    CONSTRAINT backup_recipients_uuid_key UNIQUE (uuid),
    CONSTRAINT backup_recipients_recipient_key UNIQUE (recipient),
    CONSTRAINT backup_recipients_kind_check CHECK (kind IN ('classic', 'post-quantum')),
    CONSTRAINT backup_recipients_recipient_check CHECK (recipient LIKE 'age1%' AND length(recipient) <= 4000),
    CONSTRAINT backup_recipients_label_check CHECK (length(btrim(label)) > 0 AND length(label) <= 100),
    CONSTRAINT backup_recipients_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_backup_recipients_created_by ON public.backup_recipients USING btree (created_by);

COMMENT ON TABLE public.backup_recipients IS 'The age public keys backups are encrypted to (control plane). The private keys stay with the owner; the server cannot open the backups it makes.';
COMMENT ON COLUMN public.backup_recipients.recipient IS 'The age public key (age1…, age1pq1…, or a hardware key''s age1tag1…/age1tagpq1… form).';
COMMENT ON COLUMN public.backup_recipients.kind IS 'classic (X25519) or post-quantum (ML-KEM-768 + X25519); a server''s keys are all of one kind.';
COMMENT ON COLUMN public.backup_recipients.checked_at IS 'When the owner showed the browser the private key file and it matched this public key (made on the Backup page, or Check a key); NULL for a pasted key not checked yet.';

-- === DOWN ===

DROP TABLE public.backup_recipients;
