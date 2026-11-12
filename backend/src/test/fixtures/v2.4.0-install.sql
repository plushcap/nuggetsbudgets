-- ============================================================================
-- Test fixture: a Nuggets v2.4.0 install
--
-- What a fresh v2.4.0 install's database holds: its schema with its privileges, the
-- serving role, the database's settings, the rows a fresh install starts with, and
-- schema_migrations with v2.4.0's 161 migrations (db/v240Migrations.ts). Load it into an
-- empty database as the schema's owner (psql -f, or one query); the migration runner then
-- cuts it over to the baseline (upgrade/from-v2.4.0.sql).
--
-- Made once, with v2.4.0's backend/scripts/regen-init-sql.sh (v2.4.0's init.sql plus its
-- migrations, dumped), and not edited since but for one thing: each issue number in a
-- comment or a function body is written [issue]. The cutover re-asserts every comment and
-- function body, so their old text can't change its result; that the result is the
-- baseline's all the same is what backend/scripts/check-migrations.sh upgrade (CI) and
-- the migration runner's tests check.
-- ============================================================================

-- The unprivileged role the app serves as (ADR 0001 §5.1). Row-level security applies to
-- it; the migration runner gives it LOGIN and its password (app_db_password).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuggets_app') THEN
    CREATE ROLE nuggets_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- The database's own settings. Skipped, with a notice, when the role loading this
-- doesn't own the database.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET %s TO %L', current_database(), 'TimeZone', 'UTC');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Not the owner of database %, so its TimeZone setting is unchanged', current_database();
END
$$;

--
-- PostgreSQL database dump
--

-- Dumped from database version 18.6 (Debian 18.6-1.pgdg13+2)
-- Dumped by pg_dump version 18.6 (Debian 18.6-1.pgdg13+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

CREATE FUNCTION public.account_balances_as_of(p_account_ids integer[], p_dates date[]) RETURNS TABLE(account_id integer, as_of date, balance numeric)
    LANGUAGE sql STABLE
    AS $$
    WITH accounts AS (
        SELECT DISTINCT a.account_id FROM unnest(p_account_ids) AS a(account_id) WHERE a.account_id IS NOT NULL
    ), dates AS (
        SELECT DISTINCT d.as_of FROM unnest(p_dates) AS d(as_of) WHERE d.as_of IS NOT NULL
    ), entries AS (
        -- Each account's transactions, as calculate_account_balance_as_of counts
        -- them, a day at a time ...
        SELECT t.account_id, t.transaction_date AS day, SUM(t.amount) AS amount, false AS is_date
          FROM public.transactions t
         WHERE t.account_id IN (SELECT accounts.account_id FROM accounts)
           AND t.parent_transaction_id IS NULL
           AND t.transaction_date <= (SELECT max(dates.as_of) FROM dates)
         GROUP BY t.account_id, t.transaction_date
        UNION ALL
        -- ... and, for each account, a row at each date asked for, which adds nothing.
        SELECT accounts.account_id, dates.as_of, NULL::numeric, true FROM accounts CROSS JOIN dates
    ), running AS (
        -- The default RANGE frame takes a date's row with every transaction dated that day.
        SELECT e.account_id, e.day, e.is_date,
               SUM(e.amount) OVER (PARTITION BY e.account_id ORDER BY e.day) AS balance
          FROM entries e
    )
    SELECT r.account_id, r.day, COALESCE(r.balance, 0)
      FROM running r
     WHERE r.is_date
$$;

COMMENT ON FUNCTION public.account_balances_as_of(p_account_ids integer[], p_dates date[]) IS 'calculate_account_balance_as_of(account, date) for each of the accounts at each of the dates, in one pass over their transactions ([issue]). The same balance definition ([issue]), for a series.';

CREATE FUNCTION public.aggregate_net_worth_snapshots(p_source_level character varying, p_target_level character varying, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    aggregated_count INTEGER := 0;
    date_trunc_format VARCHAR(20);
BEGIN
    -- Determine date truncation format
    CASE p_target_level
        WHEN 'weekly' THEN date_trunc_format := 'week';
        WHEN 'monthly' THEN date_trunc_format := 'month';
        WHEN 'yearly' THEN date_trunc_format := 'year';
        ELSE RAISE EXCEPTION 'Invalid target aggregation level: %', p_target_level;
    END CASE;

    -- Set default date range if not provided
    p_start_date := COALESCE(p_start_date, app_today() - INTERVAL '1 year');
    p_end_date := COALESCE(p_end_date, app_today() - INTERVAL '1 day');

    -- Perform aggregation with upsert
    INSERT INTO net_worth_snapshots (
        uuid,
        snapshot_date,
        total_assets,
        total_liabilities,
        net_worth,
        account_count,
        active_account_count,
        snapshot_trigger,
        aggregation_level,
        source_snapshot_count,
        calculation_method
    )
    SELECT
        uuidv7(),
        DATE_TRUNC(date_trunc_format, snapshot_date)::DATE,
        AVG(total_assets),
        AVG(total_liabilities),
        AVG(net_worth),
        MAX(account_count), -- Use max as account count shouldn't vary much
        MAX(active_account_count),
        'aggregation',
        p_target_level,
        COUNT(*),
        'aggregated'
    FROM net_worth_snapshots
    WHERE aggregation_level = p_source_level
        AND snapshot_date >= p_start_date
        AND snapshot_date <= p_end_date
    GROUP BY DATE_TRUNC(date_trunc_format, snapshot_date)
    ON CONFLICT (tenant_id, snapshot_date, aggregation_level)
    DO UPDATE SET
        total_assets = EXCLUDED.total_assets,
        total_liabilities = EXCLUDED.total_liabilities,
        net_worth = EXCLUDED.net_worth,
        account_count = EXCLUDED.account_count,
        active_account_count = EXCLUDED.active_account_count,
        source_snapshot_count = EXCLUDED.source_snapshot_count,
        updated_at = CURRENT_TIMESTAMP;

    GET DIAGNOSTICS aggregated_count = ROW_COUNT;
    RETURN aggregated_count;
END;
$$;

CREATE FUNCTION public.app_timezone() RETURNS text
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    zone text;
    tenant text := NULLIF(current_setting('app.current_tenant_id', true), '');
BEGIN
    IF tenant IS NOT NULL THEN
        SELECT NULLIF(btrim(setting_value), '') INTO zone
          FROM public.tenant_settings
         WHERE tenant_id = tenant::integer
           AND setting_key = 'application_timezone';
    END IF;
    IF zone IS NULL THEN
        SELECT NULLIF(btrim(setting_value), '') INTO zone
          FROM public.system_settings
         WHERE setting_key = 'application_timezone';
    END IF;
    -- A zone name, not an offset: Postgres reads '+05:00' as POSIX (UTC-5) where
    -- JavaScript reads UTC+5, so the two would disagree on the day.
    IF zone IS NULL OR zone !~ '^[A-Za-z][A-Za-z0-9_+/-]*$' THEN
        RETURN 'UTC';
    END IF;
    -- Raises 22023 for a zone Postgres doesn't know.
    PERFORM now() AT TIME ZONE zone;
    RETURN zone;
EXCEPTION WHEN invalid_parameter_value THEN
    RETURN 'UTC';
END;
$_$;

COMMENT ON FUNCTION public.app_timezone() IS 'The current ledger''s application_timezone (tenant_settings), else the deployment''s (system_settings), or UTC when that is unset or not a time zone ([issue], [issue]).';

CREATE FUNCTION public.app_today() RETURNS date
    LANGUAGE sql STABLE
    AS $$
    SELECT (now() AT TIME ZONE public.app_timezone())::date
$$;

COMMENT ON FUNCTION public.app_today() IS 'Today in the application time zone: use it, not CURRENT_DATE, for the user''s today ([issue]).';

CREATE FUNCTION public.apply_transaction_auto_tag(p_transaction_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM apply_transaction_auto_tags(ARRAY[p_transaction_id]);
END;
$$;

COMMENT ON FUNCTION public.apply_transaction_auto_tag(p_transaction_id integer) IS 'Applies auto-tag to transaction based on budget_item and merchant rules. Merchant rule overrides budget_item rule.';

CREATE FUNCTION public.apply_transaction_auto_tags(p_transaction_ids integer[]) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- The transactions first, in id order, as a tag on them locks them ([issue]); one deleted
  -- meanwhile isn't locked, and gets no tag below.
  PERFORM 1 FROM transactions WHERE id = ANY (p_transaction_ids) ORDER BY id FOR KEY SHARE;

  -- First, remove the transactions' existing auto-type tags
  DELETE FROM taggings
  WHERE taggable_type = 'transaction'
    AND taggable_id = ANY (p_transaction_ids)
    AND type = 'auto';

  -- Each transaction's merchant auto tag, else its budget item's
  INSERT INTO taggings (tag_id, taggable_type, taggable_id, type, user_id)
  SELECT COALESCE(m.transaction_auto_tag_id, bi.transaction_auto_tag_id), 'transaction', t.id, 'auto', NULL
    FROM transactions t
    LEFT JOIN merchants m ON m.id = t.merchant_id
    LEFT JOIN budget_items bi ON bi.id = t.budget_item_id
   WHERE t.id = ANY (p_transaction_ids)
     AND COALESCE(m.transaction_auto_tag_id, bi.transaction_auto_tag_id) IS NOT NULL
  ON CONFLICT (tenant_id, tag_id, taggable_type, taggable_id) DO NOTHING;

  RETURN (SELECT count(DISTINCT id) FROM unnest(p_transaction_ids) AS ids(id) WHERE id IS NOT NULL);
END;
$$;

COMMENT ON FUNCTION public.apply_transaction_auto_tags(p_transaction_ids integer[]) IS 'Replace the auto tag of each given transaction: its merchant''s transaction_auto_tag_id, else its budget item''s. Returns how many transaction ids it was given ([issue]).';

CREATE FUNCTION public.assert_transaction_split_balanced(p_transaction_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent record;
    split_count integer;
    split_total numeric;
BEGIN
    IF p_transaction_id IS NULL THEN
        RETURN;
    END IF;
    SELECT t.uuid, t.amount, t.is_split_parent INTO parent FROM public.transactions t WHERE t.id = p_transaction_id;
    IF NOT FOUND THEN
        RETURN; -- deleted with its splits
    END IF;
    SELECT count(*), COALESCE(sum(c.amount), 0) INTO split_count, split_total
      FROM public.transactions c
     WHERE c.parent_transaction_id = p_transaction_id;
    IF split_count > 0 AND NOT parent.is_split_parent THEN
        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = format('transaction %s has splits but is not marked split', parent.uuid);
    END IF;
    IF parent.is_split_parent AND (split_count = 0 OR split_total IS DISTINCT FROM parent.amount) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = format('the splits of transaction %s add up to %s, not its amount %s', parent.uuid, split_total, parent.amount);
    END IF;
END;
$$;

CREATE FUNCTION public.assert_transaction_transfer_paired(p_transaction_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    side record;
    other record;
BEGIN
    IF p_transaction_id IS NULL THEN
        RETURN;
    END IF;
    SELECT t.uuid, t.amount, t.transfer_transaction_id INTO side FROM public.transactions t WHERE t.id = p_transaction_id;
    IF NOT FOUND OR side.transfer_transaction_id IS NULL THEN
        RETURN;
    END IF;
    SELECT t.uuid, t.amount, t.transfer_transaction_id INTO other FROM public.transactions t WHERE t.id = side.transfer_transaction_id;
    IF other.transfer_transaction_id IS DISTINCT FROM p_transaction_id THEN
        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = format('transaction %s is one side of a transfer whose other side, %s, does not name it back', side.uuid, other.uuid);
    END IF;
    IF other.amount IS DISTINCT FROM -side.amount THEN
        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = format('the two sides of transfer %s / %s are %s and %s, not equal and opposite', side.uuid, other.uuid, side.amount, other.amount);
    END IF;
END;
$$;

CREATE FUNCTION public.bulk_create_budget_items(p_budget_items jsonb, p_user_id integer DEFAULT NULL::integer) RETURNS TABLE(budget_item_id integer, success boolean, error_message text)
    LANGUAGE plpgsql
    AS $$
DECLARE
    batch_id UUID;
    item JSONB;
    new_budget_item_id INTEGER;
    period_record RECORD;
    period_item_id INTEGER;
    starting_period_item_id INTEGER;
    v_today DATE := app_today();
BEGIN
    batch_id := uuidv7();

    -- Process each budget item
    FOR item IN SELECT * FROM jsonb_array_elements(p_budget_items)
    LOOP
        BEGIN
            -- Insert budget item
            INSERT INTO budget_items (
                name, expense_type, description, priority, type, subtype,
                rollover, isbill, recurring_payment, default_budget_amount,
                rollover_target_amount, rollover_starting_balance,
                rollover_starting_balance_date, color, icon, category_id
            ) VALUES (
                item->>'name',
                COALESCE(item->>'expense_type', 'Expense'),
                item->>'description',
                COALESCE(item->>'priority', 'Optional'),
                COALESCE(item->>'type', 'Monthly'),
                COALESCE(item->>'subtype', 'Fixed'),
                COALESCE((item->>'rollover')::BOOLEAN, false),
                COALESCE((item->>'isbill')::BOOLEAN, false),
                COALESCE((item->>'recurring_payment')::BOOLEAN, false),
                COALESCE((item->>'default_budget_amount')::DECIMAL(12,2), 0.00),
                COALESCE((item->>'rollover_target_amount')::DECIMAL(12,2), 0.00),
                COALESCE((item->>'rollover_starting_balance')::DECIMAL(12,2), 0.00),
                COALESCE((item->>'rollover_starting_balance_date')::DATE, NULL),
                COALESCE(item->>'color', '#3B82F6'),
                COALESCE(item->>'icon', 'CreditCard'),
                COALESCE((item->>'category_id')::INTEGER, NULL)
            ) RETURNING id INTO new_budget_item_id;

            -- Create budget_period_items for periods from the earlier of current date or starting balance date
            FOR period_record IN
                SELECT id, start_date FROM budget_period
                WHERE end_date >= LEAST(
                    v_today,
                    COALESCE((item->>'rollover_starting_balance_date')::DATE, v_today)
                )
                ORDER BY start_date
            LOOP
                INSERT INTO budget_period_items (
                    budget_period_id, budget_item_id, starting
                ) VALUES (
                    period_record.id, new_budget_item_id, 0.00
                ) RETURNING id INTO period_item_id;

                -- Record initial budget if specified
                IF COALESCE((item->>'default_budget_amount')::DECIMAL(12,2), 0.00) > 0 THEN
                    PERFORM record_budget_change_event(
                        period_item_id,
                        new_budget_item_id,
                        (item->>'default_budget_amount')::DECIMAL(12,2),
                        NULL,
                        format('Bulk import: Initial budget for %s', item->>'name'),
                        p_user_id,
                        batch_id,
                        'budget_update'  -- transaction_type
                    );
                END IF;
            END LOOP;

            -- An envelope's starting balance, all of it (a negative one too), in
            -- the period its date falls in, as creating the envelope in the app does
            IF COALESCE((item->>'rollover')::BOOLEAN, false)
               AND COALESCE((item->>'rollover_starting_balance')::DECIMAL(12,2), 0.00) <> 0 THEN
                starting_period_item_id := starting_balance_period_item(
                    new_budget_item_id, (item->>'rollover_starting_balance_date')::DATE);
                IF starting_period_item_id IS NOT NULL THEN
                    PERFORM record_budget_change_event(
                        starting_period_item_id,
                        new_budget_item_id,
                        (item->>'rollover_starting_balance')::DECIMAL(12,2),
                        0.00,
                        format('Bulk import: Starting balance for %s', item->>'name'),
                        p_user_id,
                        batch_id,
                        'starting_balance'
                    );
                END IF;
            END IF;

            -- Return success
            RETURN QUERY SELECT new_budget_item_id, true, NULL::TEXT;

        EXCEPTION WHEN OTHERS THEN
            -- Return error
            RETURN QUERY SELECT NULL::INTEGER, false, SQLERRM;
        END;
    END LOOP;
END;
$$;

CREATE FUNCTION public.calculate_account_balance(p_account_id integer) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT public.calculate_account_balance_as_of(p_account_id, public.app_today())
$$;

COMMENT ON FUNCTION public.calculate_account_balance(p_account_id integer) IS 'Current account balance: calculate_account_balance_as_of(account, app_today()), so a transaction dated after today counts from its date. The only balance definition ([issue], [issue]).';

CREATE FUNCTION public.calculate_account_balance_as_of(p_account_id integer, p_as_of date) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(SUM(t.amount), 0)
      FROM public.transactions t
     WHERE t.account_id = p_account_id
       AND t.parent_transaction_id IS NULL
       AND (p_as_of IS NULL OR t.transaction_date <= p_as_of)
$$;

COMMENT ON FUNCTION public.calculate_account_balance_as_of(p_account_id integer, p_as_of date) IS 'Account balance at the end of p_as_of (NULL = all time): SUM(amount) of the account''s non-child transactions. The only balance definition ([issue]).';

CREATE FUNCTION public.calculate_actual_for_period_item(p_budget_period_item_id integer) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    actual_amount DECIMAL(12, 2) := 0.00;
    target_budget_item_id INTEGER;
    target_budget_period_id INTEGER;
    is_rollover_item BOOLEAN := false;
    first_budget_period_start_date DATE;
BEGIN
    -- Get the budget item ID, period ID, and rollover flag for this budget period item
    SELECT bpi.budget_item_id, bpi.budget_period_id, bi.rollover
    INTO target_budget_item_id, target_budget_period_id, is_rollover_item
    FROM budget_period_items bpi
    JOIN budget_items bi ON bpi.budget_item_id = bi.id
    WHERE bpi.id = p_budget_period_item_id;

    -- Get the first budget period start date 
    SELECT MIN(start_date) INTO first_budget_period_start_date FROM budget_period;

    -- For ALL items (envelope and monthly), show period-specific actual amounts only
    -- EXCLUDE split parent transactions (is_split_parent = true) to avoid double-counting
    -- Include child transactions (parent_transaction_id IS NOT NULL) in the sum
    SELECT COALESCE(SUM(amount), 0.00) INTO actual_amount
    FROM transactions
    WHERE budget_item_id = target_budget_item_id
      AND budget_period_id = target_budget_period_id  -- Period-specific
      AND type IN ('expense', 'income')
      AND transaction_date >= first_budget_period_start_date  -- Only transactions after envelope system started
      AND (is_split_parent IS NULL OR is_split_parent = false);  -- Exclude split parents

    RETURN actual_amount;
END;
$$;

CREATE FUNCTION public.calculate_budget_for_period_item(p_budget_period_item_id integer) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    budget_amount DECIMAL(12, 2) := 0.00;
    target_budget_item_id INTEGER;
    target_budget_period_id INTEGER;
    is_rollover_item BOOLEAN := false;
BEGIN
    -- Get the budget item ID, period ID, and rollover flag for this budget period item
    SELECT bpi.budget_item_id, bpi.budget_period_id, bi.rollover
    INTO target_budget_item_id, target_budget_period_id, is_rollover_item
    FROM budget_period_items bpi
    JOIN budget_items bi ON bpi.budget_item_id = bi.id
    WHERE bpi.id = p_budget_period_item_id;

    -- Calculate budget amount from budget_update AND transfer events
    -- Includes: add, remove (for budget_update) and move_in, move_out (for transfers)
    SELECT COALESCE(SUM(
        CASE
            WHEN transaction_type IN ('add', 'move_in') THEN amount
            WHEN transaction_type IN ('remove', 'move_out') THEN -amount
            ELSE 0
        END
    ), 0.00) INTO budget_amount
    FROM budget_period_transactions bpt
    WHERE bpt.budget_period_item_id = p_budget_period_item_id
      AND bpt.type IN ('budget_update', 'transfer');  -- Include both budget updates and transfers

    RETURN budget_amount;
END;
$$;

CREATE FUNCTION public.calculate_descendant_tag_levels() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    tag_level INTEGER;
    under_itself BOOLEAN;
    height INTEGER;
BEGIN
    -- One move at a time in a ledger: a move another transaction holds this lock for is
    -- committed or rolled back before the walks below, each a statement of its own, read
    -- the tags (READ COMMITTED). TagService takes the lock first (TAG_TREE_LOCK_CLASS,
    -- 0x54414753), before its own checks. Released when the transaction ends.
    PERFORM pg_advisory_xact_lock(1413564243, NEW.tenant_id);

    -- A move or a new tag, checked after the statement, with every row it wrote there, so a
    -- statement that moves or adds several tags is checked as it leaves them, in whatever
    -- order its rows were written ([issue]). Up from the new parent: reaching the tag is a
    -- loop, and the top must be at most three tags up (the walk stops there), or the tag
    -- would be past level 3.
    IF NEW.parent_id IS NULL THEN
        tag_level := 0;
    ELSE
        WITH RECURSIVE up(id, parent_id, steps) AS (
            SELECT t.id, t.parent_id, 0 FROM public.tags t WHERE t.id = NEW.parent_id
            UNION ALL
            SELECT t.id, t.parent_id, up.steps + 1 FROM public.tags t JOIN up ON t.id = up.parent_id
             WHERE up.id <> NEW.id AND up.steps < 3
        )
        SELECT COALESCE(bool_or(id = NEW.id), false), max(steps) FILTER (WHERE parent_id IS NULL) + 1
          INTO under_itself, tag_level
          FROM up;
        IF under_itself THEN
            RAISE EXCEPTION 'Cannot move tag: would create circular reference';
        END IF;
    END IF;
    -- Down from the tag: the levels of tags it takes along. The walk leaves out the tag
    -- itself and stops four levels down, which is too deep wherever the tag goes.
    WITH RECURSIVE below(id, depth) AS (
        SELECT t.id, 1 FROM public.tags t WHERE t.parent_id = NEW.id AND t.id <> NEW.id
        UNION ALL
        SELECT t.id, b.depth + 1 FROM public.tags t JOIN below b ON t.parent_id = b.id WHERE b.depth < 4 AND t.id <> NEW.id
    )
    SELECT COALESCE(MAX(depth), 0) INTO height FROM below;
    IF tag_level IS NULL OR tag_level + height > 3 THEN
        RAISE EXCEPTION 'Cannot move tag: maximum hierarchy depth of 4 levels exceeded';
    END IF;

    -- The tag (calculate_tag_level kept the level it had), and each tag below it one level
    -- below its parent. Only `level` is set, so neither tag trigger on UPDATE OF parent_id
    -- fires again; each value is the one the statement leaves, so chk_tags_max_level never
    -- sees one on the way.
    UPDATE public.tags SET level = tag_level WHERE id = NEW.id AND level IS DISTINCT FROM tag_level;
    WITH RECURSIVE below(id, depth) AS (
        SELECT t.id, 1 FROM public.tags t WHERE t.parent_id = NEW.id AND t.id <> NEW.id
        UNION ALL
        SELECT t.id, b.depth + 1 FROM public.tags t JOIN below b ON t.parent_id = b.id WHERE b.depth < 4 AND t.id <> NEW.id
    )
    UPDATE public.tags t
       SET level = tag_level + b.depth
      FROM below b
     WHERE t.id = b.id
       AND t.level IS DISTINCT FROM tag_level + b.depth;
    RETURN NULL;
END;
$$;

CREATE FUNCTION public.calculate_remaining_for_period_item(p_budget_period_item_id integer) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    budget_amount DECIMAL(12, 2) := 0.00;
    actual_amount DECIMAL(12, 2) := 0.00;
    remaining_amount DECIMAL(12, 2) := 0.00;
    target_budget_item_id INTEGER;
    target_start_date DATE;
    is_rollover_item BOOLEAN := false;
    is_income_item BOOLEAN := false;
    item_expense_type VARCHAR(50);
    first_budget_period_start_date DATE;
BEGIN
    -- Get the budget item, the period's first day, rollover flag, and expense_type for this budget period item
    SELECT bpi.budget_item_id, bp.start_date, bi.rollover, bi.expense_type
    INTO target_budget_item_id, target_start_date, is_rollover_item, item_expense_type
    FROM budget_period_items bpi
    JOIN budget_items bi ON bpi.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON bp.id = bpi.budget_period_id
    WHERE bpi.id = p_budget_period_item_id;

    -- Determine if this is an income item based on budget item expense_type
    is_income_item := (item_expense_type = 'Income');

    -- Get the first budget period start date
    SELECT MIN(start_date) INTO first_budget_period_start_date FROM budget_period;

    IF is_rollover_item THEN
        -- For envelope items, calculate cumulative remaining:
        -- Sum all budget events (including starting_balance AND transfers) of the
        -- periods that start no later than this one (by date: ids follow creation order).
        -- An event's period is its period item's. The envelope's own period items
        -- give it for (nearly) every event; any other is looked up ([issue]).
        WITH own_period_items AS (
            SELECT bpi.id, bp.start_date
              FROM budget_period_items bpi
              JOIN budget_period bp ON bp.id = bpi.budget_period_id
             WHERE bpi.budget_item_id = target_budget_item_id
        )
        SELECT COALESCE(SUM(
            CASE
                WHEN bpt.transaction_type IN ('add', 'move_in') THEN bpt.amount
                WHEN bpt.transaction_type IN ('remove', 'move_out') THEN -bpt.amount
                ELSE 0
            END
        ), 0.00) INTO budget_amount
        FROM budget_period_transactions bpt
        LEFT JOIN own_period_items own ON own.id = bpt.budget_period_item_id
        WHERE bpt.budget_item_id = target_budget_item_id
          AND bpt.type IN ('budget_update', 'starting_balance', 'transfer')  -- Include transfers
          AND COALESCE(own.start_date,
                       (SELECT bp.start_date
                          FROM budget_period_items bpi
                          JOIN budget_period bp ON bp.id = bpi.budget_period_id
                         WHERE bpi.id = bpt.budget_period_item_id)) <= target_start_date;

        -- For envelope items, sum all actual spending of the same periods
        SELECT COALESCE(SUM(t.amount), 0.00) INTO actual_amount
        FROM transactions t
        WHERE t.budget_item_id = target_budget_item_id
          AND t.type IN ('expense', 'income')
          AND t.transaction_date >= first_budget_period_start_date
          AND t.budget_period_id = ANY (ARRAY(
                SELECT bp.id FROM budget_period bp WHERE bp.start_date <= target_start_date));
    ELSE
        -- For monthly items, use period-specific amounts
        -- calculate_budget_for_period_item already includes transfers after migration 20251227184500
        budget_amount := calculate_budget_for_period_item(p_budget_period_item_id);
        actual_amount := calculate_actual_for_period_item(p_budget_period_item_id);
    END IF;

    -- Calculate remaining based on item type
    -- NOTE: We do NOT add transfers_amount separately because:
    -- - For monthly items: calculate_budget_for_period_item already includes transfers
    -- - For rollover items: budget_amount query above already includes transfers
    IF is_income_item THEN
        -- For income items: remaining = actual income - budgeted income
        remaining_amount := actual_amount - budget_amount;
    ELSE
        -- For expense items: remaining = budgeted amount + actual spending (negative)
        remaining_amount := budget_amount + actual_amount;
    END IF;

    RETURN remaining_amount;
END;
$$;

CREATE FUNCTION public.calculate_remaining_for_period_items(p_budget_period_item_ids integer[]) RETURNS TABLE(budget_period_item_id integer, remaining numeric)
    LANGUAGE sql STABLE
    AS $$
    WITH targets AS MATERIALIZED (
        -- Each period item asked for: its item, its period's first day, and the item's kind.
        SELECT bpi.id, bpi.budget_item_id, bp.start_date, bi.rollover, bi.expense_type = 'Income' AS income
          FROM public.budget_period_items bpi
          JOIN public.budget_items bi ON bi.id = bpi.budget_item_id
          LEFT JOIN public.budget_period bp ON bp.id = bpi.budget_period_id
         WHERE bpi.id = ANY (p_budget_period_item_ids)
    ), envelopes AS MATERIALIZED (
        SELECT DISTINCT t.budget_item_id, t.income FROM targets t WHERE t.rollover
    ), event_sums AS MATERIALIZED (
        -- The envelopes' budget events, summed per period item they are filed under: one
        -- pass over their events, whatever the plan of what follows.
        SELECT bpt.budget_item_id, bpt.budget_period_item_id,
               SUM(CASE WHEN bpt.transaction_type IN ('add', 'move_in') THEN bpt.amount
                        WHEN bpt.transaction_type IN ('remove', 'move_out') THEN -bpt.amount
                        ELSE 0 END) AS amount
          FROM public.budget_period_transactions bpt
         WHERE bpt.budget_item_id = ANY (ARRAY(SELECT e.budget_item_id FROM envelopes e))
           AND bpt.type IN ('budget_update', 'starting_balance', 'transfer')
         GROUP BY bpt.budget_item_id, bpt.budget_period_item_id
    ), spending_sums AS MATERIALIZED (
        -- Their spending, summed per budget period, from the first period's start on: one
        -- pass over their transactions.
        SELECT t.budget_item_id, t.budget_period_id, SUM(t.amount) AS amount
          FROM public.transactions t
         WHERE t.budget_item_id = ANY (ARRAY(SELECT e.budget_item_id FROM envelopes e))
           AND t.type IN ('expense', 'income')
           AND t.transaction_date >= (SELECT min(fp.start_date) FROM public.budget_period fp)
         GROUP BY t.budget_item_id, t.budget_period_id
    ), entries AS (
        -- Each envelope's events by their period's first day (an event's period is its
        -- period item's), signed as they count toward its remaining ...
        SELECT es.budget_item_id, bp.start_date AS day,
               es.amount * CASE WHEN e.income THEN -1 ELSE 1 END AS amount,
               false AS is_target
          FROM event_sums es
          JOIN envelopes e ON e.budget_item_id = es.budget_item_id
          JOIN public.budget_period_items event_item ON event_item.id = es.budget_period_item_id
          JOIN public.budget_period bp ON bp.id = event_item.budget_period_id
        UNION ALL
        -- ... its spending by its period's first day ...
        SELECT ss.budget_item_id, bp.start_date, ss.amount, false
          FROM spending_sums ss
          JOIN public.budget_period bp ON bp.id = ss.budget_period_id
        UNION ALL
        -- ... and a row at each period item asked for, which adds nothing.
        SELECT t.budget_item_id, t.start_date, NULL, true
          FROM targets t
         WHERE t.rollover AND t.start_date IS NOT NULL
    ), running AS (
        -- The default RANGE frame takes a period item's row with every entry of its
        -- period's start day: everything of the periods starting no later than its own.
        SELECT DISTINCT e.budget_item_id, e.day,
               SUM(e.amount) OVER (PARTITION BY e.budget_item_id ORDER BY e.day) AS remaining,
               e.is_target
          FROM entries e
    )
    SELECT t.id,
           (CASE WHEN t.rollover IS NOT TRUE THEN public.calculate_remaining_for_period_item(t.id)
                 ELSE COALESCE(r.remaining, 0) END)::numeric(12, 2)
      FROM targets t
      LEFT JOIN running r ON r.is_target AND r.budget_item_id = t.budget_item_id AND r.day = t.start_date
$$;

COMMENT ON FUNCTION public.calculate_remaining_for_period_items(p_budget_period_item_ids integer[]) IS 'calculate_remaining_for_period_item(id) for each of the period items, an envelope''s in one pass over its budget events and spending ([issue]). The same remaining, for a series.';

CREATE FUNCTION public.calculate_tag_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent_level INTEGER;
BEGIN
    -- An update keeps the level the tag has. In a statement that moves several tags a
    -- parent's stored level may not be final yet, and chk_tags_max_level would check a
    -- level worked out from it ([issue]): trg_calculate_descendant_tag_levels checks a move,
    -- and sets the moved tag's level and those below it, once the statement's rows are all
    -- written. A write that leaves the parent alone (a rename: PUT /api/tags/:uuid writes
    -- parent_id back unchanged) keeps the tag where it is, deeper too, as an older install
    -- may hold one: a row may keep what it has (as in 20261102110000).
    IF TG_OP = 'UPDATE' THEN
        NEW.level := OLD.level;
        RETURN NEW;
    END IF;

    -- A new tag: level 0 at the top, else one below its parent. Tags go four levels deep,
    -- 0 to 3, so none goes under a level-3 tag. A parent the statement adds after this row
    -- isn't there yet, and the level is none for now: trg_calculate_inserted_tag_levels
    -- checks every new tag with a parent, and sets its level, once the statement's rows are
    -- written.
    IF NEW.parent_id IS NULL THEN
        NEW.level := 0;
    ELSE
        SELECT level INTO parent_level FROM public.tags WHERE id = NEW.parent_id;
        IF parent_level >= 3 THEN
            RAISE EXCEPTION 'Cannot create tag: maximum hierarchy depth of 4 levels exceeded';
        END IF;
        NEW.level := parent_level + 1;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION public.calculate_transfers_for_period_item(p_budget_period_item_id integer) RETURNS numeric
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    total_transfers DECIMAL(12,2) := 0.00;
BEGIN
    -- Sum all transfer events for this budget period item (both in and out)
    SELECT COALESCE(SUM(
        CASE 
            WHEN transaction_type = 'move_in' THEN amount
            WHEN transaction_type = 'move_out' THEN -amount
            ELSE 0
        END
    ), 0.00) INTO total_transfers
    FROM budget_period_transactions
    WHERE budget_period_item_id = p_budget_period_item_id
      AND type = 'transfer';
      
    RETURN COALESCE(total_transfers, 0.00);
END;
$$;

CREATE FUNCTION public.check_account_simplefin_connection() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.simplefin_connection_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM public.organization_simplefin_connections c
          JOIN public.tenants t ON t.organization_id = c.organization_id
         WHERE c.id = NEW.simplefin_connection_id
           AND t.id = NEW.tenant_id
    ) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'foreign_key_violation',
            MESSAGE = 'accounts.simplefin_connection_id must name a SimpleFin connection of the tenant''s organization';
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.check_known_or_unchanged() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    col text := TG_ARGV[0];
    allowed text[] := TG_ARGV[1:];
    new_value text := to_jsonb(NEW) ->> col;
BEGIN
    IF new_value IS NULL OR new_value = ANY (allowed) THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND new_value IS NOT DISTINCT FROM (to_jsonb(OLD) ->> col) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = format('%s.%s must be one of: %s (not %L)', TG_TABLE_NAME, col, array_to_string(allowed, ', '), new_value);
END;
$$;

CREATE FUNCTION public.check_transaction_income_sign() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.type = 'income' AND NEW.amount < 0 AND NEW.parent_transaction_id IS NULL
       AND (TG_OP = 'INSERT'
            OR OLD.type IS DISTINCT FROM NEW.type
            OR OLD.amount IS DISTINCT FROM NEW.amount
            OR OLD.parent_transaction_id IS DISTINCT FROM NEW.parent_transaction_id) THEN
        RAISE EXCEPTION USING
            ERRCODE = 'check_violation',
            MESSAGE = format('an income can''t be negative (transaction %s, amount %s)', NEW.uuid, NEW.amount);
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.check_transaction_splits_and_transfers() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP <> 'DELETE' THEN
        PERFORM public.assert_transaction_split_balanced(NEW.id);
        PERFORM public.assert_transaction_split_balanced(NEW.parent_transaction_id);
        PERFORM public.assert_transaction_transfer_paired(NEW.id);
    END IF;
    IF TG_OP <> 'INSERT' THEN
        PERFORM public.assert_transaction_split_balanced(OLD.parent_transaction_id);
        PERFORM public.assert_transaction_transfer_paired(OLD.transfer_transaction_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION public.check_transaction_type_for_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    account_type_value VARCHAR(50);
BEGIN
    -- Only an income is refused for its account's type.
    IF NEW.type IS DISTINCT FROM 'income' THEN
        RETURN NEW;
    END IF;

    -- The account's type, locked: an account becoming a liability holds its row FOR
    -- UPDATE until it commits, and this waits for it ([issue]).
    SELECT type INTO account_type_value
    FROM accounts
    WHERE id = NEW.account_id
    FOR KEY SHARE;

    -- Prevent income transactions on liability accounts
    IF account_type_value = 'Liability' THEN
        RAISE EXCEPTION 'Income transactions are not allowed on liability accounts. Account type: %, Transaction type: %', account_type_value, NEW.type;
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION public.create_budget_period_with_items(p_year integer, p_month integer, p_user_id integer DEFAULT NULL::integer, p_auto_rollover boolean DEFAULT true) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    period_id INTEGER;
    period_name VARCHAR(100);
    month_name VARCHAR(50);
    start_date DATE;
    end_date DATE;
    budget_item_record RECORD;
    period_item_id INTEGER;
    rollover_amount DECIMAL(12,2);
BEGIN
    -- Calculate period details
    start_date := make_date(p_year, p_month, 1);
    end_date := (start_date + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    SELECT to_char(start_date, 'Month') INTO month_name;
    month_name := TRIM(month_name);
    period_name := month_name || ' ' || p_year;

    -- Create the budget period. The ledger has one per month
    -- (budget_period_tenant_month_key): when it already has this one, made before
    -- or by a concurrent call that committed first, nothing is created.
    INSERT INTO budget_period (
        name, month, year, month_number, start_date, end_date, status
    ) VALUES (
        period_name, month_name, p_year, p_month, start_date, end_date,
        CASE WHEN start_date <= app_today() AND end_date >= app_today()
             THEN 'active' ELSE 'upcoming' END
    )
    ON CONFLICT (tenant_id, year, month_number) DO NOTHING
    RETURNING id INTO period_id;

    IF period_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- Create budget_period_items for every budget item that isn't archived
    FOR budget_item_record IN
        SELECT id, name, default_budget_amount, rollover
        FROM budget_items
        WHERE COALESCE(status, 'active') <> 'archived'
          -- RLS scopes this already; naming the tenant keeps a role that
          -- bypasses RLS from giving one tenant's period another's items.
          AND tenant_id = current_setting('app.current_tenant_id', true)::int
        ORDER BY id
    LOOP
        -- Calculate rollover if enabled
        IF p_auto_rollover AND budget_item_record.rollover THEN
            rollover_amount := 0.00; -- Simplified for now
        ELSE
            rollover_amount := 0.00;
        END IF;

        -- Create budget_period_item (only insert existing columns)
        INSERT INTO budget_period_items (
            budget_period_id,
            budget_item_id,
            starting
        ) VALUES (
            period_id,
            budget_item_record.id,
            rollover_amount
        ) RETURNING id INTO period_item_id;

        -- Record initial budget amount if set (using budget_period_transactions table)
        IF budget_item_record.default_budget_amount IS NOT NULL
           AND budget_item_record.default_budget_amount > 0 THEN
            INSERT INTO budget_period_transactions (
                budget_period_item_id, transaction_type, type, amount,
                previous_amount, budget_item_id, description, user_id,
                event_type, source_system
            ) VALUES (
                period_item_id, 'add', 'budget_update',
                budget_item_record.default_budget_amount,
                0.00, budget_item_record.id,
                format('Initial budget for %s', budget_item_record.name),
                p_user_id, 'budget_update', 'system'
            );
        END IF;
    END LOOP;

    RETURN period_id;
END;
$$;

CREATE FUNCTION public.create_net_worth_snapshot(p_snapshot_date date DEFAULT NULL::date, p_snapshot_trigger character varying DEFAULT 'transaction'::character varying, p_aggregation_level character varying DEFAULT 'daily'::character varying) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    snapshot_uuid UUID;
    target_date DATE;
    total_assets_val DECIMAL(12,2) := 0;
    total_liabilities_val DECIMAL(12,2) := 0;
    calculated_net_worth DECIMAL(12,2) := 0;
    account_count_val INTEGER := 0;
    active_account_count_val INTEGER := 0;
    existing_snapshot_id INTEGER;
BEGIN
    -- Set target date, default to today
    target_date := COALESCE(p_snapshot_date, app_today());

    -- Net worth at the end of target_date, from the one definition ([issue]).
    SELECT nw.total_assets, nw.total_liabilities, nw.net_worth, nw.account_count, nw.active_account_count
      INTO total_assets_val, total_liabilities_val, calculated_net_worth, account_count_val, active_account_count_val
      FROM net_worth_as_of(target_date) nw;

    -- Check if snapshot already exists for this date and level
    SELECT id INTO existing_snapshot_id
    FROM net_worth_snapshots
    WHERE snapshot_date = target_date AND aggregation_level = p_aggregation_level;

    IF existing_snapshot_id IS NOT NULL THEN
        -- Update existing snapshot
        UPDATE net_worth_snapshots
        SET
            total_assets = total_assets_val,
            total_liabilities = total_liabilities_val,
            net_worth = calculated_net_worth,
            account_count = account_count_val,
            active_account_count = active_account_count_val,
            snapshot_trigger = p_snapshot_trigger,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = existing_snapshot_id
        RETURNING uuid INTO snapshot_uuid;

        RETURN snapshot_uuid;
    ELSE
        -- Create new snapshot
        snapshot_uuid := uuidv7();

        INSERT INTO net_worth_snapshots (
            uuid,
            snapshot_date,
            total_assets,
            total_liabilities,
            net_worth,
            account_count,
            active_account_count,
            snapshot_trigger,
            aggregation_level,
            calculation_method
        ) VALUES (
            snapshot_uuid,
            target_date,
            total_assets_val,
            total_liabilities_val,
            calculated_net_worth,
            account_count_val,
            active_account_count_val,
            p_snapshot_trigger,
            p_aggregation_level,
            'event_driven'
        );

        RETURN snapshot_uuid;
    END IF;
END;
$$;

CREATE FUNCTION public.current_organization_id() RETURNS integer
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT COALESCE(NULLIF(current_setting('app.current_organization_id', true), '')::integer, public.organization_context_missing())
$$;

COMMENT ON FUNCTION public.current_organization_id() IS 'The organization of the current transaction (app.current_organization_id); raises when none is set. Used by every organization policy and organization_id default.';

CREATE FUNCTION public.current_tenant_id() RETURNS integer
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT COALESCE(NULLIF(current_setting('app.current_tenant_id', true), '')::integer, public.tenant_context_missing())
$$;

COMMENT ON FUNCTION public.current_tenant_id() IS 'The tenant of the current transaction (app.current_tenant_id); raises when none is set. Used by every tenant policy and tenant_id default.';

CREATE FUNCTION public.delete_polymorphic_references() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM public.taggings tg
     USING deleted_rows d
     WHERE tg.taggable_type = TG_ARGV[0] AND tg.taggable_id = d.id AND tg.tenant_id = d.tenant_id;
    DELETE FROM public.annotations an
     USING deleted_rows d
     WHERE an.subject_type = TG_ARGV[0] AND an.subject_id = d.id AND an.tenant_id = d.tenant_id;
    RETURN NULL;
END;
$$;

CREATE FUNCTION public.generate_safe_filename() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
BEGIN
    -- Generate safe filename with UUID prefix if not already set
    IF NEW.safe_filename IS NULL OR NEW.safe_filename = '' THEN
        -- Extract file extension from original filename
        NEW.file_extension := LOWER(substring(NEW.original_filename from '\.([^.]+)$'));
        
        -- Create safe filename: uuid_originalname.ext
        NEW.safe_filename := NEW.uuid || '_' || 
                             regexp_replace(
                                 regexp_replace(NEW.original_filename, '[^a-zA-Z0-9._-]', '_', 'g'),
                                 '_+', '_', 'g'
                             );
        
        -- Set legacy file_name field for backward compatibility
        IF NEW.file_name IS NULL OR NEW.file_name = '' THEN
            NEW.file_name := NEW.safe_filename;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$_$;

CREATE FUNCTION public.get_account_id_by_uuid(account_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM accounts WHERE uuid = account_uuid);
END;
$$;

CREATE FUNCTION public.get_budget_period_summary(p_period_id integer) RETURNS TABLE(budget_item_id integer, budget_item_name character varying, starting_amount numeric, budget_amount numeric, actual_amount numeric, transfers_amount numeric, remaining_amount numeric, rollover_enabled boolean)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        bi.id,
        bi.name,
        COALESCE(bpi.starting, 0.00),
        calculate_budget_for_period_item(bpi.id),
        calculate_actual_for_period_item(bpi.id),
        calculate_transfers_for_period_item(bpi.id),
        calculate_remaining_for_period_item(bpi.id),
        bi.rollover
    FROM budget_items bi
    JOIN budget_period_items bpi ON bi.id = bpi.budget_item_id
    WHERE bpi.budget_period_id = p_period_id
    ORDER BY bi.name;
END;
$$;

CREATE FUNCTION public.get_child_tag_ids(parent_tag_id integer) RETURNS TABLE(tag_id integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tag_tree AS (
        -- Base case: start with the given parent
        SELECT id FROM tags WHERE id = parent_tag_id
        UNION
        -- Recursive case: find all children
        SELECT t.id
        FROM tags t
        INNER JOIN tag_tree tt ON t.parent_id = tt.id
    )
    SELECT id FROM tag_tree;
END;
$$;

CREATE FUNCTION public.get_merchant_id_by_uuid(merchant_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM merchants WHERE uuid = merchant_uuid);
END;
$$;

CREATE FUNCTION public.get_merchant_rule_id_by_uuid(rule_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM merchant_matching_rules WHERE uuid = rule_uuid);
END;
$$;

CREATE FUNCTION public.get_net_worth_history(p_period character varying DEFAULT 'month'::character varying, p_limit integer DEFAULT 30, p_fill_gaps boolean DEFAULT true) RETURNS TABLE(snapshot_date date, total_assets numeric, total_liabilities numeric, net_worth numeric, account_count integer, is_interpolated boolean)
    LANGUAGE plpgsql
    AS $$
DECLARE
    period_unit TEXT;
BEGIN
    CASE p_period
        WHEN 'week' THEN period_unit := 'week';
        WHEN 'month' THEN period_unit := 'month';
        WHEN 'year' THEN period_unit := 'year';
        ELSE period_unit := 'day';
    END CASE;

    RETURN QUERY
    WITH periods AS (
        -- Each period that has daily snapshots: their average, and its last one.
        SELECT
            DATE_TRUNC(period_unit, nws.snapshot_date::TIMESTAMP)::DATE AS period_start,
            ROUND(AVG(nws.total_assets), 2) AS total_assets,
            ROUND(AVG(nws.total_liabilities), 2) AS total_liabilities,
            ROUND(AVG(nws.net_worth), 2) AS net_worth,
            MAX(nws.account_count) AS account_count,
            (ARRAY_AGG(nws.total_assets ORDER BY nws.snapshot_date DESC))[1] AS last_total_assets,
            (ARRAY_AGG(nws.total_liabilities ORDER BY nws.snapshot_date DESC))[1] AS last_total_liabilities,
            (ARRAY_AGG(nws.net_worth ORDER BY nws.snapshot_date DESC))[1] AS last_net_worth,
            (ARRAY_AGG(nws.account_count ORDER BY nws.snapshot_date DESC))[1] AS last_account_count
        FROM net_worth_snapshots nws
        WHERE nws.aggregation_level = 'daily'
        GROUP BY 1
    ),
    series AS (
        -- Every period from the first snapshot's through today's (or a later snapshot's).
        SELECT generate_series(
            MIN(p.period_start)::TIMESTAMP,
            GREATEST(MAX(p.period_start)::TIMESTAMP, DATE_TRUNC(period_unit, app_today()::TIMESTAMP)),
            ('1 ' || period_unit)::INTERVAL
        )::DATE AS period_start
        FROM periods p
    ),
    numbered AS (
        SELECT
            s.period_start,
            p.total_assets,
            p.total_liabilities,
            p.net_worth,
            p.account_count,
            p.last_total_assets,
            p.last_total_liabilities,
            p.last_net_worth,
            p.last_account_count,
            p.period_start IS NULL AS is_interpolated,
            -- A period without snapshots shares the number of the last one with them.
            COUNT(p.period_start) OVER (ORDER BY s.period_start) AS filled_from
        FROM series s
        LEFT JOIN periods p ON p.period_start = s.period_start
    )
    SELECT
        n.period_start,
        CASE WHEN n.is_interpolated THEN FIRST_VALUE(n.last_total_assets) OVER w ELSE n.total_assets END,
        CASE WHEN n.is_interpolated THEN FIRST_VALUE(n.last_total_liabilities) OVER w ELSE n.total_liabilities END,
        CASE WHEN n.is_interpolated THEN FIRST_VALUE(n.last_net_worth) OVER w ELSE n.net_worth END,
        CASE WHEN n.is_interpolated THEN FIRST_VALUE(n.last_account_count) OVER w ELSE n.account_count END,
        n.is_interpolated
    FROM numbered n
    WHERE p_fill_gaps OR NOT n.is_interpolated
    WINDOW w AS (PARTITION BY n.filled_from ORDER BY n.period_start)
    ORDER BY n.period_start DESC
    LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.get_tag_hierarchy_path(tag_id integer) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
    tag_path TEXT := '';
    current_id INTEGER := tag_id;
    current_name VARCHAR(100);
    parent_id_val INTEGER;
    loop_counter INTEGER := 0;
BEGIN
    LOOP
        -- Safety check to prevent infinite loops
        loop_counter := loop_counter + 1;
        IF loop_counter > 10 THEN
            RAISE EXCEPTION 'Circular reference detected in tag hierarchy';
        END IF;
        
        -- Get current tag name and parent
        SELECT name, parent_id INTO current_name, parent_id_val
        FROM tags
        WHERE id = current_id;
        
        -- Exit if tag not found
        IF current_name IS NULL THEN
            EXIT;
        END IF;
        
        -- Prepend current tag name to path
        IF tag_path = '' THEN
            tag_path := current_name;
        ELSE
            tag_path := current_name || ' → ' || tag_path;
        END IF;
        
        -- Move to parent
        current_id := parent_id_val;
        
        -- Exit if no parent
        IF current_id IS NULL THEN
            EXIT;
        END IF;
    END LOOP;
    
    RETURN tag_path;
END;
$$;

CREATE FUNCTION public.get_tag_id_by_uuid(tag_uuid_param uuid) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    RETURN (SELECT id FROM tags WHERE uuid = tag_uuid_param);
END;
$$;

CREATE FUNCTION public.get_tag_report_root(p_tag_id integer) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, is_report_root
        FROM public.tags
        WHERE id = p_tag_id
        UNION
        SELECT t.id, t.parent_id, t.is_report_root
        FROM public.tags t
        INNER JOIN ancestors a ON t.id = a.parent_id
    )
    SELECT id FROM ancestors WHERE is_report_root = true LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_tag_report_root(p_tag_id integer) IS 'Walks ancestors of the given tag and returns the id of the first tag with is_report_root = true, or NULL if none.';

CREATE FUNCTION public.get_tag_transaction_summary(tag_uuid_param uuid, start_date_param date DEFAULT NULL::date, end_date_param date DEFAULT NULL::date) RETURNS TABLE(tag_id integer, tag_name character varying, tag_uuid uuid, hierarchy_path text, transaction_count bigint, total_amount numeric, income_amount numeric, expense_amount numeric)
    LANGUAGE plpgsql
    AS $$
DECLARE
    target_tag_id INTEGER;
    child_tag_ids INTEGER[];
BEGIN
    SELECT tags.id INTO target_tag_id FROM tags WHERE tags.uuid = tag_uuid_param;

    IF target_tag_id IS NULL THEN
        RAISE EXCEPTION 'Tag not found';
    END IF;

    SELECT ARRAY(SELECT get_child_tag_ids.tag_id FROM get_child_tag_ids(target_tag_id)) INTO child_tag_ids;

    RETURN QUERY
    SELECT
        t.id,
        t.name,
        t.uuid,
        get_tag_hierarchy_path(t.id),
        COUNT(tr.id)::BIGINT as transaction_count,
        COALESCE(SUM(tr.amount), 0)::NUMERIC(12,2) as total_amount,
        COALESCE(SUM(CASE WHEN tr.amount > 0 THEN tr.amount ELSE 0 END), 0)::NUMERIC(12,2) as income_amount,
        COALESCE(SUM(CASE WHEN tr.amount < 0 THEN tr.amount ELSE 0 END), 0)::NUMERIC(12,2) as expense_amount
    FROM tags t
    -- Each in-scope transaction once, however many of the scope's tags it carries.
    LEFT JOIN (
        SELECT DISTINCT tx.id, tx.amount
        FROM taggings tg
        JOIN transactions tx ON tx.id = tg.taggable_id AND tg.taggable_type = 'transaction'
        WHERE tg.tag_id = ANY(child_tag_ids)
          AND (start_date_param IS NULL OR tx.transaction_date >= start_date_param)
          AND (end_date_param IS NULL OR tx.transaction_date <= end_date_param)
          AND tx.is_split_parent = false
    ) tr ON true
    WHERE t.id = target_tag_id
    GROUP BY t.id, t.name, t.uuid;
END;
$$;

CREATE FUNCTION public.get_transaction_id_by_uuid(transaction_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM transactions WHERE uuid = transaction_uuid);
END;
$$;

CREATE FUNCTION public.get_user_id_by_uuid(user_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM users WHERE uuid = user_uuid);
END;
$$;

CREATE FUNCTION public.goal_waits_for_day_range_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.budget_item_accounts WHERE budget_item_id = NEW.id)
       AND NOT EXISTS (SELECT 1 FROM public.goal_budget_items WHERE goal_id = NEW.id) THEN
        PERFORM pg_advisory_xact_lock_shared(1145133394, NEW.tenant_id);
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.goal_waits_for_day_range_change() IS 'A budget item becoming a goal waits for a change of its ledger''s time zone under way, which then locks it with the goals ([issue]).';

CREATE FUNCTION public.grant_deployment_admin(p_user_id integer, p_granted_by integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    v_deployment_id integer;
    v_granter_is_admin boolean;
BEGIN
    SELECT d.id INTO v_deployment_id FROM public.deployment d ORDER BY d.id LIMIT 1;
    IF v_deployment_id IS NULL THEN
        RAISE EXCEPTION 'The deployment row is missing' USING ERRCODE = 'no_data_found';
    END IF;
    -- Step 2 of the lock order: the two accounts, as the foreign keys would at the insert.
    PERFORM 1 FROM public.users u WHERE u.id IN (p_user_id, p_granted_by) ORDER BY u.id FOR KEY SHARE;
    -- Step 5: their deployment rows, in id order, in one statement; then the granter's role
    -- as it stands once locked.
    SELECT coalesce(bool_or(l.user_id = p_granted_by AND l.role = 'admin'), false)
      INTO v_granter_is_admin
      FROM (SELECT du.user_id, du.role
              FROM public.deployment_users du
             WHERE du.deployment_id = v_deployment_id
               AND du.user_id IN (p_user_id, p_granted_by)
             ORDER BY du.id
               FOR UPDATE) l;
    IF NOT v_granter_is_admin
       AND NOT (p_user_id = p_granted_by
                AND NOT EXISTS (SELECT 1 FROM public.deployment_users du
                                 WHERE du.deployment_id = v_deployment_id AND du.role = 'admin')) THEN
        RAISE EXCEPTION 'Deployment admin required'
            USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'deployment_admin_required';
    END IF;
    INSERT INTO public.deployment_users (user_id, deployment_id, role, created_by)
    VALUES (p_user_id, v_deployment_id, 'admin', p_granted_by)
    ON CONFLICT (user_id, deployment_id) DO UPDATE SET role = 'admin';
END;
$$;

COMMENT ON FUNCTION public.grant_deployment_admin(p_user_id integer, p_granted_by integer) IS 'Makes a user a deployment admin, if the granter still is one (or, at first-run setup, the deployment has none and they grant themselves). The only way the app role adds a deployment_users row ([issue], [issue]).';

CREATE FUNCTION public.lock_deployment_admin(p_user_id integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
    PERFORM 1
       FROM public.deployment_users du
      WHERE du.user_id = p_user_id AND du.role = 'admin'
        FOR SHARE;
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION public.lock_deployment_admin(p_user_id integer) IS 'Share-locks a deployment admin''s row and says whether there is one, for the app role, which has no UPDATE on the table ([issue]).';

CREATE FUNCTION public.lock_deployment_users_of(p_user_id integer, p_actor_id integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    v_deployment_id integer;
    v_actor_is_admin boolean;
BEGIN
    SELECT d.id INTO v_deployment_id FROM public.deployment d ORDER BY d.id LIMIT 1;
    SELECT coalesce(bool_or(l.user_id = p_actor_id AND l.role = 'admin' AND l.deployment_id = v_deployment_id), false)
      INTO v_actor_is_admin
      FROM (SELECT du.user_id, du.role, du.deployment_id
              FROM public.deployment_users du
             WHERE du.user_id IN (p_user_id, p_actor_id) OR du.created_by = p_user_id
             ORDER BY du.id
               FOR UPDATE) l;
    RETURN v_actor_is_admin;
END;
$$;

COMMENT ON FUNCTION public.lock_deployment_users_of(p_user_id integer, p_actor_id integer) IS 'Locks the deployment_users rows deleting a user changes and the deleting admin''s, and says whether they are still an admin, for the app role, which has no UPDATE on the table ([issue]).';

CREATE FUNCTION public.lock_referenced_subject_on_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    new_type text := to_jsonb(NEW) ->> TG_ARGV[0];
    new_id integer := (to_jsonb(NEW) ->> TG_ARGV[1])::integer;
    subject_table text;
    locked integer;
BEGIN
    subject_table := CASE new_type
        WHEN 'account' THEN 'accounts'
        WHEN 'budget_item' THEN 'budget_items'
        WHEN 'budget_period_item' THEN 'budget_period_items'
        WHEN 'category' THEN 'categories'
        WHEN 'merchant' THEN 'merchants'
        WHEN 'security' THEN 'securities'
        WHEN 'tag' THEN 'tags'
        WHEN 'transaction' THEN 'transactions'
    END;
    IF subject_table IS NULL OR new_id IS NULL THEN
        RETURN NULL;
    END IF;
    -- A row a delete holds makes this wait; one it deleted meanwhile isn't found.
    EXECUTE format('SELECT s.id FROM public.%I s WHERE s.tenant_id = $1 AND s.id = $2 FOR KEY SHARE OF s', subject_table)
       INTO locked
      USING NEW.tenant_id, new_id;
    IF locked IS NULL THEN
        RAISE EXCEPTION 'update on table "%" violates its reference to %: % % does not exist', TG_TABLE_NAME, subject_table, new_type, new_id
            USING ERRCODE = 'foreign_key_violation', TABLE = TG_TABLE_NAME,
                  HINT = 'A tag or a note is moved onto a subject while it is there ([issue]).';
    END IF;
    RETURN NULL;
END;
$_$;

COMMENT ON FUNCTION public.lock_referenced_subject_on_update() IS 'Row trigger on taggings and annotations, after an update that moves the row to another subject: locks the new subject (FOR KEY SHARE) and refuses the row if it does not exist, as a foreign key would ([issue]). lock_referenced_subjects and lock_referenced_transactions do the same as rows are inserted ([issue], [issue]).';

CREATE FUNCTION public.lock_referenced_subjects() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    type_column text := TG_ARGV[0];
    id_column text := TG_ARGV[1];
    present text[];
    subject record;
    wanted bigint;
    locked bigint;
    missing integer;
BEGIN
    EXECUTE format('SELECT array_agg(DISTINCT n.%1$I::text) FROM new_rows n', type_column) INTO present;
    -- A table at a time, in this order, each in id order. A row a delete holds makes this
    -- wait; one it deleted meanwhile isn't locked (or counted).
    FOR subject IN
        SELECT s.type_name, s.table_name
          FROM (VALUES (1, 'account', 'accounts'),
                       (2, 'budget_item', 'budget_items'),
                       (3, 'budget_period_item', 'budget_period_items'),
                       (4, 'category', 'categories'),
                       (5, 'merchant', 'merchants'),
                       (6, 'security', 'securities'),
                       (7, 'tag', 'tags')) AS s(position, type_name, table_name)
         WHERE s.type_name = ANY (present)
         ORDER BY s.position
    LOOP
        EXECUTE format(
            'SELECT count(DISTINCT (n.tenant_id, n.%2$I)) FROM new_rows n WHERE n.%1$I = %3$L',
            type_column, id_column, subject.type_name)
           INTO wanted;
        EXECUTE format(
            'SELECT count(*) FROM (SELECT 1 FROM public.%4$I s'
            ' WHERE (s.tenant_id, s.id) IN (SELECT n.tenant_id, n.%2$I FROM new_rows n WHERE n.%1$I = %3$L)'
            ' ORDER BY s.id FOR KEY SHARE OF s) AS l',
            type_column, id_column, subject.type_name, subject.table_name)
           INTO locked;
        IF locked < wanted THEN
            EXECUTE format(
                'SELECT n.%2$I FROM new_rows n WHERE n.%1$I = %3$L AND NOT EXISTS'
                ' (SELECT 1 FROM public.%4$I s WHERE s.tenant_id = n.tenant_id AND s.id = n.%2$I) LIMIT 1',
                type_column, id_column, subject.type_name, subject.table_name)
               INTO missing;
            RAISE EXCEPTION 'insert on table "%" violates its reference to %: % % does not exist', TG_TABLE_NAME, subject.table_name, subject.type_name, missing
                USING ERRCODE = 'foreign_key_violation', TABLE = TG_TABLE_NAME,
                      HINT = 'A tag or a note is written while its subject is there ([issue]).';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$_$;

COMMENT ON FUNCTION public.lock_referenced_subjects() IS 'Statement trigger on taggings and annotations: locks the rows other than transactions that the new rows point at (FOR KEY SHARE, a table at a time, in id order), and refuses a row whose subject does not exist, as a foreign key would ([issue]). lock_referenced_transactions does the same for transactions ([issue]).';

CREATE FUNCTION public.lock_referenced_transactions() RETURNS trigger
    LANGUAGE plpgsql
    AS $_$
DECLARE
    type_column text := TG_ARGV[0];
    id_column text := TG_ARGV[1];
    wanted bigint;
    locked bigint;
    missing integer;
BEGIN
    EXECUTE format(
        'SELECT count(DISTINCT (n.tenant_id, n.%2$I)) FROM new_rows n WHERE n.%1$I = %3$L',
        type_column, id_column, 'transaction')
       INTO wanted;
    IF wanted = 0 THEN
        RETURN NULL;
    END IF;
    -- In id order. A row a delete holds makes this wait; one it deleted meanwhile isn't
    -- locked (or counted).
    EXECUTE format(
        'SELECT count(*) FROM (SELECT 1 FROM public.transactions t'
        ' WHERE (t.tenant_id, t.id) IN (SELECT n.tenant_id, n.%2$I FROM new_rows n WHERE n.%1$I = %3$L)'
        ' ORDER BY t.id FOR KEY SHARE OF t) AS l',
        type_column, id_column, 'transaction')
       INTO locked;
    IF locked < wanted THEN
        EXECUTE format(
            'SELECT n.%2$I FROM new_rows n WHERE n.%1$I = %3$L AND NOT EXISTS'
            ' (SELECT 1 FROM public.transactions t WHERE t.tenant_id = n.tenant_id AND t.id = n.%2$I) LIMIT 1',
            type_column, id_column, 'transaction')
           INTO missing;
        RAISE EXCEPTION 'insert on table "%" violates its reference to transactions: transaction % does not exist', TG_TABLE_NAME, missing
            USING ERRCODE = 'foreign_key_violation', TABLE = TG_TABLE_NAME,
                  HINT = 'A tag or a note on a transaction is written while the transaction is there ([issue]).';
    END IF;
    RETURN NULL;
END;
$_$;

COMMENT ON FUNCTION public.lock_referenced_transactions() IS 'Statement trigger on taggings and annotations: locks the transactions the new rows point at (FOR KEY SHARE, in id order), and refuses a row whose transaction does not exist, as a foreign key would ([issue]).';

CREATE FUNCTION public.maintain_transaction_budget_period_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    target_budget_period_item_id INTEGER;
BEGIN
    -- A split parent's envelope lives on its children.
    IF NEW.is_split_parent THEN
        NEW.budget_item_id = NULL;
        NEW.budget_period_item_id = NULL;
        RETURN NEW;
    END IF;

    -- Only process if we have both budget_item_id and budget_period_id
    IF NEW.budget_item_id IS NOT NULL AND NEW.budget_period_id IS NOT NULL THEN

        -- Find the corresponding budget_period_items record
        SELECT id INTO target_budget_period_item_id
        FROM budget_period_items
        WHERE budget_item_id = NEW.budget_item_id
          AND budget_period_id = NEW.budget_period_id;

        -- Update the budget_period_item_id if we found a match
        IF target_budget_period_item_id IS NOT NULL THEN
            NEW.budget_period_item_id = target_budget_period_item_id;
        ELSE
            -- Clear budget_period_item_id if no matching junction record exists
            NEW.budget_period_item_id = NULL;
        END IF;

    ELSE
        -- If either budget_item_id or budget_period_id is NULL, clear budget_period_item_id
        NEW.budget_period_item_id = NULL;
    END IF;

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.maintain_transaction_budget_period_consistency() IS 'Trigger function: sets a transaction''s budget_period_item_id to the budget_period_items row of its budget_item_id and budget_period_id (NULL when there is none), and clears a split parent''s budget_item_id and budget_period_item_id, which its splits carry.';

CREATE FUNCTION public.net_worth_as_of(p_as_of date) RETURNS TABLE(total_assets numeric, total_liabilities numeric, net_worth numeric, account_count integer, active_account_count integer)
    LANGUAGE sql STABLE
    AS $$
    WITH balances AS (
        SELECT nwa.is_liability,
               nwa.is_open,
               public.calculate_account_balance_as_of(nwa.account_id, p_as_of) AS balance
          FROM public.net_worth_accounts nwa
    )
    SELECT COALESCE(SUM(b.balance) FILTER (WHERE NOT b.is_liability), 0)::numeric(12,2),
           COALESCE(-SUM(b.balance) FILTER (WHERE b.is_liability), 0)::numeric(12,2),
           COALESCE(SUM(b.balance), 0)::numeric(12,2),
           -- As the snapshot counted them: accounts with a balance, or open.
           (COUNT(*) FILTER (WHERE b.balance <> 0 OR b.is_open))::integer,
           (COUNT(*) FILTER (WHERE b.is_open))::integer
      FROM balances b
$$;

COMMENT ON FUNCTION public.net_worth_as_of(p_as_of date) IS 'Net worth at the end of p_as_of over net_worth_accounts, from calculate_account_balance_as_of. Liabilities are minus their (pre-signed) balances. The only net-worth definition ([issue]).';

CREATE FUNCTION public.organization_context_missing() RETURNS integer
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
BEGIN
  RAISE EXCEPTION 'no organization is set for this query (app.current_organization_id)'
    USING HINT = 'Run organization-scoped queries inside withOrganization (getOrgDb() in the backend), or a tenant transaction.';
END
$$;

COMMENT ON FUNCTION public.organization_context_missing() IS 'Raises: called by current_organization_id() when app.current_organization_id is unset or empty.';

CREATE FUNCTION public.populate_taggings_report_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.report_root_id := public.get_tag_report_root(NEW.tag_id);
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.record_account_hidden_range() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    today date := public.app_today();
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Created hidden: never shown, so hidden since always.
        INSERT INTO public.account_hidden_ranges (tenant_id, account_id, hidden_from)
        VALUES (NEW.tenant_id, NEW.id, NULL)
        ON CONFLICT ON CONSTRAINT account_hidden_ranges_tenant_id_account_id_hidden_from_key
        DO UPDATE SET hidden_to = NULL;
    ELSIF NEW.hide_account THEN
        -- A range is open already: nothing to record.
        IF EXISTS (SELECT 1 FROM public.account_hidden_ranges
                    WHERE tenant_id = NEW.tenant_id AND account_id = NEW.id AND hidden_to IS NULL) THEN
            RETURN NULL;
        END IF;
        -- Hidden again before the last range ended: it was shown today, or on a later
        -- day under a time zone that has since moved today back. That range goes on.
        UPDATE public.account_hidden_ranges
           SET hidden_to = NULL
         WHERE id = (SELECT id FROM public.account_hidden_ranges
                      WHERE tenant_id = NEW.tenant_id AND account_id = NEW.id AND hidden_to >= today
                      ORDER BY hidden_from DESC NULLS LAST, id DESC LIMIT 1);
        IF NOT FOUND THEN
            -- A range that starts today but ended can't be (it would cover no day), but
            -- if one is there, it goes on rather than the hide going unrecorded.
            INSERT INTO public.account_hidden_ranges (tenant_id, account_id, hidden_from)
            VALUES (NEW.tenant_id, NEW.id, today)
            ON CONFLICT ON CONSTRAINT account_hidden_ranges_tenant_id_account_id_hidden_from_key
            DO UPDATE SET hidden_to = NULL;
        END IF;
    ELSE
        -- Shown on the day it was hidden, or before (under a time zone that has since
        -- moved today back): it was hidden at the end of no day before today.
        DELETE FROM public.account_hidden_ranges
         WHERE tenant_id = NEW.tenant_id AND account_id = NEW.id AND hidden_to IS NULL AND hidden_from >= today;
        UPDATE public.account_hidden_ranges
           SET hidden_to = today
         WHERE tenant_id = NEW.tenant_id AND account_id = NEW.id AND hidden_to IS NULL;
    END IF;
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.record_account_hidden_range() IS 'Records hiding and showing an account in account_hidden_ranges, on the ledger''s today ([issue]).';

CREATE FUNCTION public.record_budget_change_event(p_budget_period_item_id integer, p_budget_item_id integer, p_amount numeric, p_previous_amount numeric DEFAULT NULL::numeric, p_description text DEFAULT NULL::text, p_user_id integer DEFAULT NULL::integer, p_batch_id uuid DEFAULT NULL::uuid, p_transaction_type character varying DEFAULT 'budget_update'::character varying) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    event_uuid UUID;
    transaction_type_calc VARCHAR(50);
    change_amount DECIMAL(12,2);
BEGIN
    -- Generate event UUID
    event_uuid := uuidv7();

    -- Determine transaction type and amount
    IF p_previous_amount IS NULL THEN
        -- Initial budget setting
        transaction_type_calc := 'add';
        change_amount := p_amount;
    ELSE
        -- Budget update
        change_amount := p_amount - p_previous_amount;
        IF change_amount > 0 THEN
            transaction_type_calc := 'add';
        ELSE
            transaction_type_calc := 'remove';
            change_amount := ABS(change_amount);
        END IF;
    END IF;

    -- Record the event, under the uuid this returns
    INSERT INTO budget_period_transactions (
        uuid,
        budget_period_item_id,
        transaction_type,
        type,
        amount,
        previous_amount,
        budget_item_id,
        description,
        user_id
    ) VALUES (
        event_uuid,
        p_budget_period_item_id,
        transaction_type_calc,
        p_transaction_type,  -- Use the parameter instead of hardcoded value
        change_amount,
        p_previous_amount,
        p_budget_item_id,
        COALESCE(p_description, format('Budget %s: %s', transaction_type_calc, change_amount)),
        p_user_id  -- Allow NULL user_id
    );

    RETURN event_uuid;
END;
$$;

CREATE FUNCTION public.record_transfer_event(p_from_budget_period_item_id integer, p_to_budget_period_item_id integer, p_amount numeric, p_description text, p_user_id integer DEFAULT NULL::integer) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    transfer_uuid UUID;
    from_budget_item_id INTEGER;
    to_budget_item_id INTEGER;
BEGIN
    -- Generate transfer UUID
    transfer_uuid := uuidv7();
    
    -- Get budget item IDs
    SELECT budget_item_id INTO from_budget_item_id 
    FROM budget_period_items WHERE id = p_from_budget_period_item_id;
    
    SELECT budget_item_id INTO to_budget_item_id 
    FROM budget_period_items WHERE id = p_to_budget_period_item_id;
    
    -- Validate sufficient funds (optional - can be done at application layer)
    -- This is just a safety check
    IF calculate_remaining_for_period_item(p_from_budget_period_item_id) < p_amount THEN
        RAISE EXCEPTION 'Insufficient funds for transfer. Available: %, Requested: %', 
            calculate_remaining_for_period_item(p_from_budget_period_item_id), 
            p_amount;
    END IF;
    
    -- Record outbound transfer
    INSERT INTO budget_period_transactions (
        uuid,
        budget_period_item_id,
        budget_item_id,
        transaction_type,
        type,
        amount,
        description,
        user_id,
        related_transaction_id,
        event_type,
        source_system,
        metadata
    ) VALUES (
        uuidv7(),
        p_from_budget_period_item_id,
        from_budget_item_id,
        'move_out',
        'transfer',
        p_amount,
        p_description,
        p_user_id,  -- Allow NULL user_id
        NULL, -- Will be updated below
        'user_transfer',
        'nuggets_app',
        json_build_object('transfer_uuid', transfer_uuid, 'to_item_id', p_to_budget_period_item_id)::jsonb
    );
    
    -- Record inbound transfer
    INSERT INTO budget_period_transactions (
        uuid,
        budget_period_item_id,
        budget_item_id,
        transaction_type,
        type,
        amount,
        description,
        user_id,
        related_transaction_id,
        event_type,
        source_system,
        metadata
    ) VALUES (
        uuidv7(),
        p_to_budget_period_item_id,
        to_budget_item_id,
        'move_in',
        'transfer',
        p_amount,
        p_description,
        p_user_id,  -- Allow NULL user_id
        NULL, -- Will be updated below
        'user_transfer',
        'nuggets_app',
        json_build_object('transfer_uuid', transfer_uuid, 'from_item_id', p_from_budget_period_item_id)::jsonb
    );
    
    RETURN transfer_uuid;
END;
$$;

CREATE FUNCTION public.refresh_descendant_taggings_on_tag_move() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.is_report_root IS DISTINCT FROM OLD.is_report_root THEN
        UPDATE public.taggings tg
        SET report_root_id = public.get_tag_report_root(tg.tag_id)
        WHERE tg.tag_id IN (
            WITH RECURSIVE descendants AS (
                SELECT NEW.id AS id
                UNION
                SELECT t.id FROM public.tags t
                INNER JOIN descendants d ON t.parent_id = d.id
            )
            SELECT id FROM descendants
        );
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.remember_cleared_budget_period() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.budget_period_id IS NOT NULL THEN
        NEW.budget_period_cleared_from := NULL;
        NEW.budget_period_cleared_start := NULL;
    ELSIF OLD.budget_period_id IS NOT NULL THEN
        NEW.budget_period_cleared_from := OLD.budget_period_id;
        NEW.budget_period_cleared_start := (SELECT start_date FROM public.budget_period WHERE id = OLD.budget_period_id);
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.remember_cleared_budget_period() IS 'Keeps transactions.budget_period_cleared_from and _start: the period an update took the row out of and its first day, null once it has one ([issue]).';

CREATE FUNCTION public.revoke_deployment_admin(p_user_id integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    v_deployment_id integer;
    v_is_admin boolean;
    v_other_admins integer;
BEGIN
    SELECT d.id INTO v_deployment_id FROM public.deployment d ORDER BY d.id LIMIT 1;
    SELECT coalesce(bool_or(l.user_id = p_user_id AND l.role = 'admin'), false),
           count(*) FILTER (WHERE l.role = 'admin' AND l.user_id <> p_user_id)
      INTO v_is_admin, v_other_admins
      FROM (SELECT du.user_id, du.role
              FROM public.deployment_users du
             WHERE du.deployment_id = v_deployment_id
               AND (du.role = 'admin' OR du.user_id = p_user_id)
             ORDER BY du.id
               FOR UPDATE) l;
    IF v_is_admin AND v_other_admins = 0 THEN
        RAISE EXCEPTION 'The deployment must keep at least one admin.'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'deployment_keeps_an_admin';
    END IF;
    DELETE FROM public.deployment_users du
     WHERE du.user_id = p_user_id AND du.deployment_id = v_deployment_id;
END;
$$;

COMMENT ON FUNCTION public.revoke_deployment_admin(p_user_id integer) IS 'Removes a user''s deployment role, keeping at least one admin. The only way the app role removes a deployment_users row ([issue]).';

CREATE FUNCTION public.set_annotation_root_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.parent_id IS NULL THEN
        NEW.root_id := NULL;  -- this row IS the root
    ELSE
        SELECT COALESCE(p.root_id, p.id) INTO NEW.root_id
        FROM public.annotations p
        WHERE p.id = NEW.parent_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.stamp_security_last_composition_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.securities SET last_composition_update_at = NOW() WHERE id = NEW.security_id;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.stamp_security_last_price_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.securities SET last_price_update_at = NOW() WHERE id = NEW.security_id;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.starting_balance_period_item(p_budget_item_id integer, p_starting_date date) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
    SELECT bpi.id
      FROM budget_period_items bpi
      JOIN budget_period bp ON bp.id = bpi.budget_period_id
     WHERE bpi.budget_item_id = p_budget_item_id
     ORDER BY bp.end_date >= COALESCE(p_starting_date, app_today()) DESC,
              CASE WHEN bp.end_date >= COALESCE(p_starting_date, app_today()) THEN bp.start_date END,
              bp.start_date DESC
     LIMIT 1
$$;

CREATE FUNCTION public.tenant_context_missing() RETURNS integer
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
BEGIN
  RAISE EXCEPTION 'no tenant is set for this query (app.current_tenant_id)'
    USING HINT = 'Run tenant-scoped queries inside withTenant (getDb() in the backend).';
END
$$;

COMMENT ON FUNCTION public.tenant_context_missing() IS 'Raises: called by current_tenant_id() when app.current_tenant_id is unset or empty.';

CREATE FUNCTION public.trigger_transaction_auto_tag() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Only apply auto-tagging if budget_item_id or merchant_id changed (or on insert)
  IF TG_OP = 'INSERT' OR
     OLD.budget_item_id IS DISTINCT FROM NEW.budget_item_id OR
     OLD.merchant_id IS DISTINCT FROM NEW.merchant_id THEN

    PERFORM apply_transaction_auto_tag(NEW.id);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trigger_transaction_auto_tag() IS 'Trigger function that applies auto-tagging when transaction budget_item_id or merchant_id changes';

CREATE FUNCTION public.trim_space(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN btrim(value, '	
                  　﻿'::text);

COMMENT ON FUNCTION public.trim_space(value text) IS 'The text without the characters JavaScript''s trim() removes around it, as the API trims a ticker or an exchange (@nuggets/shared TRIMMED_SPACE_CODE_POINTS, [issue]).';

CREATE FUNCTION public.update_tag_last_used() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public.tags
     SET last_used_at = GREATEST(public.tags.last_used_at, used.at)
    FROM (SELECT i.tag_id, MAX(COALESCE(i.created_at, CURRENT_TIMESTAMP)) AS at
            FROM inserted_taggings i
           WHERE i.taggable_type = 'transaction' AND i.tag_id IS NOT NULL
           GROUP BY i.tag_id) used
   WHERE public.tags.id = used.tag_id
     AND (public.tags.last_used_at IS NULL OR public.tags.last_used_at < used.at);
  RETURN NULL;
END;
$$;

CREATE FUNCTION public.update_tag_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF jsonb_exists(to_jsonb(NEW), 'updated_at') THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;

CREATE FUNCTION public.wait_for_day_range_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_advisory_xact_lock_shared(1145133394, NEW.tenant_id);
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.wait_for_day_range_change() IS 'A new budget item or account waits for a change of its ledger''s time zone under way, which then sees it ([issue]).';

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE public.account_currencies (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    account_id integer,
    currency_type character varying(10) DEFAULT 'standard'::character varying NOT NULL,
    currency_code character varying(10),
    currency_url character varying(500),
    currency_name character varying(255),
    currency_abbr character varying(50),
    last_fetched timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.account_currencies FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.account_currencies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.account_currencies_id_seq OWNED BY public.account_currencies.id;

CREATE TABLE public.account_hidden_ranges (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    account_id integer NOT NULL,
    hidden_from date,
    hidden_to date,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT account_hidden_ranges_valid_range_check CHECK (((hidden_to IS NULL) OR (hidden_from IS NULL) OR (hidden_to > hidden_from)))
);

ALTER TABLE ONLY public.account_hidden_ranges FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.account_hidden_ranges IS 'The days each account was hidden ([issue]), written by a trigger on accounts.hide_account: a goal doesn''t count an account on a day it was hidden.';

COMMENT ON COLUMN public.account_hidden_ranges.hidden_from IS 'The first day (in the ledger''s time zone) the account was hidden; NULL: hidden since always (created hidden, or hidden before this history was kept).';

COMMENT ON COLUMN public.account_hidden_ranges.hidden_to IS 'The day it was shown again, from which it counts; NULL while it is hidden.';

CREATE SEQUENCE public.account_hidden_ranges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.account_hidden_ranges_id_seq OWNED BY public.account_hidden_ranges.id;

CREATE TABLE public.account_imported_balance_history (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    account_id integer,
    account_currency_id integer,
    balance_date timestamp with time zone NOT NULL,
    balance numeric(12,2) NOT NULL,
    available_balance numeric(12,2),
    sync_timestamp timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    import_extra jsonb,
    import_provider character varying(50) DEFAULT 'simplefin'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.account_imported_balance_history FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.account_imported_balance_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.account_imported_balance_history_id_seq OWNED BY public.account_imported_balance_history.id;

CREATE TABLE public.account_institutions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(255) NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    import_domain character varying(255),
    import_url character varying(500),
    import_org_id character varying(255),
    import_org_url character varying(500),
    is_import_enabled boolean DEFAULT false NOT NULL,
    import_last_sync timestamp with time zone,
    import_provider character varying(50) DEFAULT 'simplefin'::character varying,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.account_institutions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.account_institutions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.account_institutions_id_seq OWNED BY public.account_institutions.id;

CREATE TABLE public.accounts (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(100) NOT NULL,
    account_group character varying(50) NOT NULL,
    account_type character varying(50) NOT NULL,
    institution_id integer,
    exclude_account_balance boolean DEFAULT false NOT NULL,
    hide_transactions boolean DEFAULT false NOT NULL,
    hide_account boolean DEFAULT false NOT NULL,
    close_account boolean DEFAULT false NOT NULL,
    last_sync_date timestamp with time zone,
    notes text,
    type character varying(50) DEFAULT 'Asset'::character varying,
    subtype character varying(50),
    link character varying(500),
    institution_available_balance numeric(12,2),
    institution_current_balance numeric(12,2),
    nuggets_balance numeric(12,2),
    account_image character varying(500),
    icon character varying(100) DEFAULT 'CreditCard'::character varying,
    account_number character varying(100),
    routing_number character varying(100),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    import_account_id character varying(255),
    import_currency character varying(100) DEFAULT 'USD'::character varying,
    import_balance numeric(12,2),
    import_available_balance numeric(12,2),
    import_balance_date timestamp with time zone,
    import_last_sync timestamp with time zone,
    import_enabled boolean DEFAULT false NOT NULL,
    import_extra jsonb,
    import_provider character varying(50) DEFAULT 'simplefin'::character varying,
    import_account_rebalance boolean DEFAULT false NOT NULL,
    import_auto_match_merchants boolean DEFAULT true NOT NULL,
    import_auto_assign_budget_period boolean DEFAULT true NOT NULL,
    import_auto_assign_budget_item boolean DEFAULT true NOT NULL,
    import_auto_review boolean DEFAULT false NOT NULL,
    import_default_assigned_to integer,
    require_zero_balance boolean DEFAULT false NOT NULL,
    is_envelope_account boolean DEFAULT false NOT NULL,
    custom_sort integer,
    instructions text,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    simplefin_connection_id integer,
    default_pay_from_account_id integer,
    import_last_error_code text,
    import_last_error_at timestamp with time zone
);

ALTER TABLE ONLY public.accounts FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.accounts.nuggets_balance IS 'Retired ([issue]): always 0. The opening balance is a ''starting balance'' transaction; balances come from calculate_account_balance().';

COMMENT ON COLUMN public.accounts.import_auto_review IS 'Automatically mark imported transactions as reviewed';

COMMENT ON COLUMN public.accounts.import_default_assigned_to IS 'Default user ID to assign imported transactions to';

COMMENT ON COLUMN public.accounts.require_zero_balance IS 'Indicates if this account should have a zero balance at month-end for close-out verification';

COMMENT ON COLUMN public.accounts.custom_sort IS 'Custom sort order for account display in UI dropdowns and lists';

COMMENT ON COLUMN public.accounts.instructions IS 'Free-form instructions/context for AI agents. Distinct from user-facing notes.';

COMMENT ON COLUMN public.accounts.default_pay_from_account_id IS 'Default source (asset) account to pre-fill when paying down this liability from Close-Out.';

CREATE SEQUENCE public.accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.accounts_id_seq OWNED BY public.accounts.id;

CREATE TABLE public.annotations (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    subject_type text NOT NULL,
    subject_id integer NOT NULL,
    parent_id integer,
    root_id integer,
    author_kind text DEFAULT 'user'::text NOT NULL,
    author_user_id integer,
    agent_name text,
    agent_run_id text,
    kind text NOT NULL,
    body text NOT NULL,
    meta jsonb,
    status text DEFAULT 'open'::text NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by_user_id integer,
    notify boolean DEFAULT false NOT NULL,
    severity text,
    pinned boolean DEFAULT false NOT NULL,
    feedback text,
    feedback_reason text,
    learning_status text,
    applied_ref jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    edited boolean DEFAULT false NOT NULL,
    CONSTRAINT annotations_thread_fields_on_root CHECK (((parent_id IS NULL) OR ((notify = false) AND (severity IS NULL) AND (feedback IS NULL) AND (resolved_at IS NULL) AND (resolved_by_user_id IS NULL))))
);

ALTER TABLE ONLY public.annotations FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.annotations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.annotations_id_seq OWNED BY public.annotations.id;

CREATE TABLE public.attachments (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    budget_item_id integer,
    transaction_id integer,
    merchant_id integer,
    name character varying(255) NOT NULL,
    original_filename character varying(500) NOT NULL,
    safe_filename character varying(500) NOT NULL,
    file_extension character varying(10) NOT NULL,
    file_size bigint,
    mime_type character varying(100),
    date_uploaded timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    bill_date date,
    notes text,
    file_name character varying(500) NOT NULL,
    attachment_type character varying(50) DEFAULT 'document'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    holding_event_id integer,
    CONSTRAINT attachments_has_relationship CHECK (((budget_item_id IS NOT NULL) OR (transaction_id IS NOT NULL) OR (merchant_id IS NOT NULL) OR (holding_event_id IS NOT NULL)))
);

ALTER TABLE ONLY public.attachments FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.attachments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.attachments_id_seq OWNED BY public.attachments.id;

CREATE TABLE public.bill_occurrence_transactions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    bill_occurrence_id integer NOT NULL,
    transaction_id integer NOT NULL,
    matched_by text NOT NULL,
    created_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bill_occurrence_transactions_matched_by_check CHECK ((matched_by = ANY (ARRAY['auto'::text, 'manual'::text, 'excluded'::text])))
);

ALTER TABLE ONLY public.bill_occurrence_transactions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.bill_occurrence_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bill_occurrence_transactions_id_seq OWNED BY public.bill_occurrence_transactions.id;

CREATE TABLE public.bill_occurrences (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    budget_item_id integer NOT NULL,
    due_date date NOT NULL,
    expected_amount numeric(12,2) NOT NULL,
    resolution text,
    manual_paid_date date,
    manual_paid_amount numeric(12,2),
    note text,
    updated_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bill_occurrences_resolution_check CHECK ((resolution = ANY (ARRAY['skipped'::text, 'paid_manually'::text])))
);

ALTER TABLE ONLY public.bill_occurrences FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.bill_occurrences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.bill_occurrences_id_seq OWNED BY public.bill_occurrences.id;

CREATE TABLE public.budget_alert_tracking (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    budget_period_item_id integer NOT NULL,
    budget_item_id integer NOT NULL,
    budget_period_id integer NOT NULL,
    first_alerted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_alerted_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    alert_count integer DEFAULT 1,
    over_amount numeric(12,2) NOT NULL,
    budget_amount numeric(12,2) NOT NULL,
    spent_amount numeric(12,2) NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolved_at timestamp with time zone,
    resolution_method character varying(50),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.budget_alert_tracking FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.budget_alert_tracking IS 'Not used: the overspending alert it tracked was replaced by notification rules, whose notification_deliveries keep an alert from repeating.';

COMMENT ON COLUMN public.budget_alert_tracking.resolution_method IS 'How the alert was resolved, e.g. budget_increased, spending_stopped, manual_clear, period_ended';

CREATE SEQUENCE public.budget_alert_tracking_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_alert_tracking_id_seq OWNED BY public.budget_alert_tracking.id;

CREATE TABLE public.budget_item_accounts (
    id integer CONSTRAINT goal_accounts_id_not_null NOT NULL,
    uuid uuid DEFAULT uuidv7() CONSTRAINT goal_accounts_uuid_not_null NOT NULL,
    budget_item_id integer CONSTRAINT goal_accounts_goal_id_not_null NOT NULL,
    account_id integer CONSTRAINT goal_accounts_account_id_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    valid_from date DEFAULT public.app_today() NOT NULL,
    valid_to date,
    CONSTRAINT budget_item_accounts_valid_range_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);

ALTER TABLE ONLY public.budget_item_accounts FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.budget_item_accounts IS 'Junction table linking budget items (especially goals) to accounts for total tracking';

COMMENT ON COLUMN public.budget_item_accounts.valid_from IS 'The first day (in the ledger''s time zone) the goal counts the account: the day it was linked ([issue]).';

COMMENT ON COLUMN public.budget_item_accounts.valid_to IS 'The day the link was removed, from which the goal no longer counts the account; NULL while it is linked ([issue]).';

CREATE SEQUENCE public.budget_item_accounts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_item_accounts_id_seq OWNED BY public.budget_item_accounts.id;

CREATE TABLE public.budget_item_matching_rules (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    budget_item_id integer,
    merchant_id integer,
    method character varying(50) NOT NULL,
    matching_text character varying(255),
    amount_min numeric(12,2),
    amount_max numeric(12,2),
    priority integer DEFAULT 100,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.budget_item_matching_rules FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.budget_item_matching_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_item_matching_rules_id_seq OWNED BY public.budget_item_matching_rules.id;

CREATE TABLE public.budget_item_usage_history (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    budget_item_id integer,
    merchant_id integer,
    transaction_description text,
    amount numeric(12,2),
    last_used_date timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    usage_count integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.budget_item_usage_history FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.budget_item_usage_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_item_usage_history_id_seq OWNED BY public.budget_item_usage_history.id;

CREATE TABLE public.budget_items (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(100) NOT NULL,
    expense_type character varying(50) DEFAULT 'Expense'::character varying,
    description text,
    priority character varying(50) DEFAULT 'Optional'::character varying,
    type character varying(50) DEFAULT 'Fixed'::character varying,
    subtype character varying(50) DEFAULT 'Fixed'::character varying,
    rollover boolean DEFAULT false NOT NULL,
    isbill boolean DEFAULT false NOT NULL,
    recurring_payment boolean DEFAULT false NOT NULL,
    default_budget_amount numeric(12,2) DEFAULT 0.00,
    rollover_target_amount numeric(12,2) DEFAULT 0.00,
    rollover_starting_balance numeric(12,2) DEFAULT 0.00,
    rollover_starting_balance_date date,
    recurring_payment_amount numeric(12,2) DEFAULT 0.00,
    recurring_payment_frequency integer DEFAULT 12,
    recurring_last_payment_date date,
    recurring_next_payment_date date,
    notes text,
    color character varying(7) DEFAULT '#3B82F6'::character varying,
    icon character varying(100) DEFAULT 'CreditCard'::character varying,
    merchant_id integer,
    category_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    goal_target_amount numeric(12,2),
    goal_target_date date,
    image_path character varying(500),
    status character varying(20) DEFAULT 'active'::character varying,
    transaction_auto_tag_id integer,
    instructions text,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    rollover_target_date date,
    recurring_amount_varies boolean DEFAULT false NOT NULL,
    CONSTRAINT budget_items_status_check CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('completed'::character varying)::text, ('paused'::character varying)::text, ('archived'::character varying)::text])))
);

ALTER TABLE ONLY public.budget_items FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.budget_items.goal_target_amount IS 'For a Savings goal: the amount to reach';

COMMENT ON COLUMN public.budget_items.goal_target_date IS 'For a Savings goal: the date to reach it by';

COMMENT ON COLUMN public.budget_items.image_path IS 'Optional image shown for the item (mostly goals)';

COMMENT ON COLUMN public.budget_items.status IS 'active, completed, paused or archived (used mostly by goals)';

COMMENT ON COLUMN public.budget_items.transaction_auto_tag_id IS 'Tag applied automatically (type=auto) to transactions assigned to this budget item';

COMMENT ON COLUMN public.budget_items.instructions IS 'Free-form instructions/context for AI agents. Distinct from user-facing description.';

CREATE SEQUENCE public.budget_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_items_id_seq OWNED BY public.budget_items.id;

CREATE TABLE public.budget_period (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(100) NOT NULL,
    month character varying(150) NOT NULL,
    year integer NOT NULL,
    month_number integer NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status character varying(50),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    CONSTRAINT budget_period_dates_check CHECK ((start_date <= end_date))
);

ALTER TABLE ONLY public.budget_period FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.budget_period_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_period_id_seq OWNED BY public.budget_period.id;

CREATE TABLE public.budget_period_items (
    id integer NOT NULL,
    budget_period_id integer NOT NULL,
    budget_item_id integer NOT NULL,
    starting numeric(12,2) DEFAULT 0.00,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.budget_period_items FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.budget_period_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_period_items_id_seq OWNED BY public.budget_period_items.id;

CREATE TABLE public.budget_period_transactions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    budget_period_item_id integer NOT NULL,
    transaction_type character varying(50) NOT NULL,
    type character varying(50) DEFAULT 'budget_update'::character varying NOT NULL,
    amount numeric(12,2) NOT NULL,
    previous_amount numeric(12,2),
    budget_item_id integer,
    related_transaction_id integer,
    description text,
    user_id integer,
    event_type character varying(50),
    source_system character varying(50),
    batch_id uuid,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    CONSTRAINT budget_period_transactions_amount_not_negative_check CHECK ((amount >= (0)::numeric)),
    CONSTRAINT budget_period_transactions_event_type_check CHECK (((event_type)::text = ANY ((ARRAY['budget_update'::character varying, 'user_transfer'::character varying, 'starting_balance'::character varying])::text[]))),
    CONSTRAINT budget_period_transactions_source_system_check CHECK (((source_system)::text = ANY ((ARRAY['system'::character varying, 'nuggets_app'::character varying, 'type_change'::character varying, 'merge'::character varying, 'import'::character varying])::text[]))),
    CONSTRAINT budget_period_transactions_transaction_type_check CHECK (((transaction_type)::text = ANY (ARRAY[('add'::character varying)::text, ('remove'::character varying)::text, ('move_in'::character varying)::text, ('move_out'::character varying)::text]))),
    CONSTRAINT budget_period_transactions_type_check CHECK (((type)::text = ANY (ARRAY[('budget_update'::character varying)::text, ('starting_balance'::character varying)::text, ('transfer'::character varying)::text])))
);

ALTER TABLE ONLY public.budget_period_transactions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.budget_period_transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.budget_period_transactions_id_seq OWNED BY public.budget_period_transactions.id;

CREATE TABLE public.categories (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(100) NOT NULL,
    description text,
    priority character varying(50) DEFAULT 'Undefined'::character varying,
    notes text,
    icon character varying(100) DEFAULT 'FolderOpen'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    name_key text GENERATED ALWAYS AS (lower(btrim((name)::text))) STORED
);

ALTER TABLE ONLY public.categories FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.categories.name_key IS 'The name as uniqueness compares it: lower case, without surrounding spaces ([issue]).';

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;

CREATE TABLE public.cost_basis_method_settings (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    account_id integer NOT NULL,
    security_id integer,
    method character varying(20) DEFAULT 'fifo'::character varying NOT NULL,
    drip_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cost_basis_method_settings_method_check CHECK (((method)::text = ANY (ARRAY[('fifo'::character varying)::text, ('lifo'::character varying)::text, ('hifo'::character varying)::text, ('specific_id'::character varying)::text, ('average_cost'::character varying)::text])))
);

ALTER TABLE ONLY public.cost_basis_method_settings FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.cost_basis_method_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.cost_basis_method_settings_id_seq OWNED BY public.cost_basis_method_settings.id;

CREATE TABLE public.data_freshness_thresholds (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    security_id integer NOT NULL,
    data_category character varying(32) NOT NULL,
    threshold_days integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_freshness_thresholds_data_category_check CHECK (((data_category)::text = ANY (ARRAY[('price'::character varying)::text, ('composition'::character varying)::text, ('expense_ratio'::character varying)::text, ('underlying_holdings'::character varying)::text])))
);

ALTER TABLE ONLY public.data_freshness_thresholds FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.data_freshness_thresholds_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.data_freshness_thresholds_id_seq OWNED BY public.data_freshness_thresholds.id;

CREATE TABLE public.deployment (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(100) NOT NULL,
    app_version character varying(50),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    setup_token_hash character varying(64)
);

COMMENT ON TABLE public.deployment IS 'The install itself (singleton: exactly one row). Global control-plane metadata + FK anchor for deployment_users.';

COMMENT ON COLUMN public.deployment.setup_token_hash IS 'SHA-256 (hex) of the one-time first-run setup token, never the token. NULL once the first admin exists.';

CREATE SEQUENCE public.deployment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deployment_id_seq OWNED BY public.deployment.id;

CREATE TABLE public.deployment_users (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    deployment_id integer NOT NULL,
    role character varying(20) DEFAULT 'support'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer
);

COMMENT ON TABLE public.deployment_users IS 'user <-> deployment. role admin|support; delegated/restricted deployment management. No is_deployment_admin flag exists on users.';

CREATE SEQUENCE public.deployment_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.deployment_users_id_seq OWNED BY public.deployment_users.id;

CREATE TABLE public.dividend_records (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    account_id integer NOT NULL,
    security_id integer NOT NULL,
    event_id integer NOT NULL,
    ex_date date,
    record_date date,
    pay_date date,
    amount_per_share numeric(12,4),
    total_amount numeric(12,2) NOT NULL,
    is_qualified boolean DEFAULT true NOT NULL,
    is_reinvested boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.dividend_records FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.dividend_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.dividend_records_id_seq OWNED BY public.dividend_records.id;

CREATE TABLE public.fund_compositions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    security_id integer NOT NULL,
    dimension character varying(32) NOT NULL,
    dimension_value character varying(64) NOT NULL,
    weight_percentage numeric(9,6) NOT NULL,
    snapshot_date date NOT NULL,
    source character varying(128) DEFAULT 'mcp_manual'::character varying NOT NULL,
    created_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.fund_compositions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.fund_compositions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.fund_compositions_id_seq OWNED BY public.fund_compositions.id;

CREATE TABLE public.fund_underlying_holdings (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    security_id integer NOT NULL,
    underlying_security_id integer NOT NULL,
    weight_percentage numeric(9,6) NOT NULL,
    shares numeric(18,6),
    snapshot_date date NOT NULL,
    source character varying(128) DEFAULT 'mcp_manual'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.fund_underlying_holdings FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.fund_underlying_holdings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.fund_underlying_holdings_id_seq OWNED BY public.fund_underlying_holdings.id;

CREATE TABLE public.goal_budget_items (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    goal_id integer NOT NULL,
    budget_item_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    valid_from date DEFAULT public.app_today() NOT NULL,
    valid_to date,
    CONSTRAINT goal_budget_items_valid_range_check CHECK (((valid_to IS NULL) OR (valid_to > valid_from)))
);

ALTER TABLE ONLY public.goal_budget_items FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.goal_budget_items IS 'Junction table linking goal budget items to other envelope budget items for total tracking';

COMMENT ON COLUMN public.goal_budget_items.goal_id IS 'The goal: a budget_items row with expense_type = ''Savings''';

COMMENT ON COLUMN public.goal_budget_items.valid_from IS 'The first day (in the ledger''s time zone) the goal counts the envelope: the day it was linked ([issue]).';

COMMENT ON COLUMN public.goal_budget_items.valid_to IS 'The day the link was removed, from which the goal no longer counts the envelope; NULL while it is linked ([issue]).';

CREATE SEQUENCE public.goal_budget_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.goal_budget_items_id_seq OWNED BY public.goal_budget_items.id;

CREATE TABLE public.holding_events (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    account_id integer NOT NULL,
    security_id integer,
    user_id integer,
    event_type character varying(32) NOT NULL,
    event_date date NOT NULL,
    shares numeric(18,6),
    price_per_share numeric(12,4),
    total_amount numeric(12,2),
    fees numeric(12,2) DEFAULT 0 NOT NULL,
    taxes_withheld numeric(12,2) DEFAULT 0 NOT NULL,
    fee_type character varying(32),
    source character varying(128) DEFAULT 'manual'::character varying NOT NULL,
    description text,
    external_reference character varying(255),
    reverses_event_id integer,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    adjusted_through_action_id integer,
    CONSTRAINT holding_events_adjusted_through_action_check CHECK (((adjusted_through_action_id IS NULL) OR ((event_type)::text = ANY ((ARRAY['buy'::character varying, 'sell'::character varying, 'dividend_reinvest'::character varying, 'historical_import'::character varying])::text[])))),
    CONSTRAINT holding_events_event_type_check CHECK (((event_type)::text = ANY (ARRAY[('buy'::character varying)::text, ('sell'::character varying)::text, ('dividend'::character varying)::text, ('dividend_reinvest'::character varying)::text, ('split'::character varying)::text, ('reverse_split'::character varying)::text, ('spinoff'::character varying)::text, ('merger_cash'::character varying)::text, ('merger_stock'::character varying)::text, ('return_of_capital'::character varying)::text, ('transfer_in'::character varying)::text, ('transfer_out'::character varying)::text, ('fee'::character varying)::text, ('manual_adjustment'::character varying)::text, ('lot_correction'::character varying)::text, ('historical_import'::character varying)::text]))),
    CONSTRAINT holding_events_fee_type_check CHECK (((fee_type IS NULL) OR ((fee_type)::text = ANY (ARRAY[('commission'::character varying)::text, ('advisory'::character varying)::text, ('account_maintenance'::character varying)::text, ('inactivity'::character varying)::text, ('wire_transfer'::character varying)::text, ('transfer_out'::character varying)::text, ('paper_statement'::character varying)::text, ('tax_loss_harvesting'::character varying)::text, ('expense_ratio_drag'::character varying)::text, ('other'::character varying)::text]))))
);

ALTER TABLE ONLY public.holding_events FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.holding_events.adjusted_through_action_id IS 'The last split of the security its figures are already adjusted for, recorded after its date ([issue]); NULL when they are as of its date.';

CREATE SEQUENCE public.holding_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.holding_events_id_seq OWNED BY public.holding_events.id;

CREATE TABLE public.import_sync_log (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    sync_type character varying(50) NOT NULL,
    sync_status character varying(50) NOT NULL,
    sync_trigger character varying(50) NOT NULL,
    import_provider character varying(50) DEFAULT 'simplefin'::character varying NOT NULL,
    institution_id integer,
    account_id integer,
    sync_start_time timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    sync_end_time timestamp with time zone,
    records_processed integer DEFAULT 0,
    accounts_synced integer DEFAULT 0,
    transactions_imported integer DEFAULT 0,
    transactions_updated integer DEFAULT 0,
    balance_adjustments_created integer DEFAULT 0,
    error_message text,
    api_response_time_ms integer,
    start_date timestamp with time zone,
    end_date timestamp with time zone,
    include_pending boolean DEFAULT false NOT NULL,
    user_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.import_sync_log FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.import_sync_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.import_sync_log_id_seq OWNED BY public.import_sync_log.id;

CREATE TABLE public.login_throttles (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    throttle_key text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT login_throttles_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT login_throttles_throttle_key_check CHECK ((throttle_key ~ '^[0-9a-f]{64}$'::text))
);

COMMENT ON TABLE public.login_throttles IS 'Per-account password sign-in throttling ([issue]). Keys are HMACs of an email address, or of an address and a trusted device. Control plane: no tenant_id, no RLS.';

CREATE SEQUENCE public.login_throttles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.login_throttles_id_seq OWNED BY public.login_throttles.id;

CREATE TABLE public.lot_consumptions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    tax_lot_id integer NOT NULL,
    sell_event_id integer NOT NULL,
    shares_consumed numeric(18,6) NOT NULL,
    basis_consumed numeric(12,2) NOT NULL,
    proceeds numeric(12,2) NOT NULL,
    realized_gain_loss numeric(12,2) NOT NULL,
    holding_period_days integer NOT NULL,
    is_long_term boolean NOT NULL,
    is_wash_sale boolean DEFAULT false NOT NULL,
    disallowed_loss numeric(12,2) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.lot_consumptions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.lot_consumptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.lot_consumptions_id_seq OWNED BY public.lot_consumptions.id;

CREATE TABLE public.merchant_matching_rules (
    id integer NOT NULL,
    merchant_id integer,
    method character varying(50) NOT NULL,
    matching_text character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.merchant_matching_rules FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.merchant_matching_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.merchant_matching_rules_id_seq OWNED BY public.merchant_matching_rules.id;

CREATE TABLE public.merchants (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(255) NOT NULL,
    merchant_website character varying(255),
    merchant_accountid character varying(100),
    merchant_image character varying(500),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    notes text,
    transaction_auto_tag_id integer,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    instructions text,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.merchants FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.merchants.transaction_auto_tag_id IS 'Tag applied automatically (type=auto) to transactions assigned to this merchant; overrides the budget item''s auto tag';

COMMENT ON COLUMN public.merchants.instructions IS 'Free-form instructions/context for AI agents. Distinct from user-facing notes.';

CREATE SEQUENCE public.merchants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.merchants_id_seq OWNED BY public.merchants.id;

CREATE VIEW public.net_worth_accounts WITH (security_invoker='true') AS
 SELECT id AS account_id,
    COALESCE(((type)::text = 'Liability'::text), false) AS is_liability,
    (NOT COALESCE(close_account, false)) AS is_open
   FROM public.accounts a
  WHERE ((NOT COALESCE(hide_account, false)) AND (NOT COALESCE(exclude_account_balance, false)) AND (upper(COALESCE(NULLIF(btrim((import_currency)::text), ''::text), 'USD'::text)) = 'USD'::text));

COMMENT ON VIEW public.net_worth_accounts IS 'The accounts that count in net worth: not hidden, not excluded from net worth, in dollars (closed accounts count). The only net-worth account set ([issue]).';

CREATE TABLE public.net_worth_snapshots (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    snapshot_date date NOT NULL,
    total_assets numeric(12,2) DEFAULT 0 NOT NULL,
    total_liabilities numeric(12,2) DEFAULT 0 NOT NULL,
    net_worth numeric(12,2) DEFAULT 0 NOT NULL,
    account_count integer DEFAULT 0,
    active_account_count integer DEFAULT 0,
    snapshot_trigger character varying(50) DEFAULT 'transaction'::character varying,
    aggregation_level character varying(20) DEFAULT 'daily'::character varying NOT NULL,
    source_snapshot_count integer DEFAULT 0,
    calculation_method character varying(50) DEFAULT 'event_driven'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.net_worth_snapshots FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.net_worth_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.net_worth_snapshots_id_seq OWNED BY public.net_worth_snapshots.id;

CREATE TABLE public.notification_deliveries (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    rule_key text NOT NULL,
    user_id integer NOT NULL,
    subject_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notification_deliveries FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.notification_deliveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_deliveries_id_seq OWNED BY public.notification_deliveries.id;

CREATE TABLE public.notification_preferences (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    user_id integer NOT NULL,
    rule_key text NOT NULL,
    email boolean NOT NULL,
    push boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notification_preferences FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.notification_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_preferences_id_seq OWNED BY public.notification_preferences.id;

CREATE TABLE public.notification_rule_sets (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    rules jsonb NOT NULL,
    updated_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notification_rule_sets FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.notification_rule_sets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notification_rule_sets_id_seq OWNED BY public.notification_rule_sets.id;

CREATE TABLE public.notifications (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    recipient_email character varying(255) NOT NULL,
    notification_type character varying(50) NOT NULL,
    subject character varying(255) NOT NULL,
    template_data jsonb NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying,
    scheduled_for timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    priority integer DEFAULT 5,
    retry_count integer DEFAULT 0,
    max_retries integer DEFAULT 3,
    last_attempt_at timestamp with time zone,
    sent_at timestamp with time zone,
    error_message text,
    ses_message_id character varying(255),
    related_budget_item_id integer,
    related_budget_period_id integer,
    related_alert_tracking_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    rule_key text
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.notifications IS 'Queue and history of the notifications the notification rules send a person: queued pending, then sent by push, email or both, and marked sent or failed.';

COMMENT ON COLUMN public.notifications.notification_type IS 'The kind of the notification rule that queued it (budget_item, transaction, review_reminder, digest, bill)';

COMMENT ON COLUMN public.notifications.template_data IS 'JSON data rendered into the email template';

COMMENT ON COLUMN public.notifications.status IS 'Lifecycle: pending, processing, then sent or failed (delivered and bounced are accepted for delivery tracking)';

COMMENT ON COLUMN public.notifications.ses_message_id IS 'Message-ID the SMTP server returned for the sent email';

CREATE SEQUENCE public.notifications_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;

CREATE TABLE public.onedrive_tokens (
    id integer NOT NULL,
    user_id integer NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    folder_path character varying(500) DEFAULT '/Backups/Nuggets'::character varying,
    auto_sync_enabled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    uuid uuid DEFAULT uuidv7() NOT NULL
);

COMMENT ON TABLE public.onedrive_tokens IS 'Stores encrypted OneDrive OAuth tokens for backup sync feature';

COMMENT ON COLUMN public.onedrive_tokens.access_token IS 'Microsoft Graph access token, encrypted with a key derived from the data encryption key';

COMMENT ON COLUMN public.onedrive_tokens.refresh_token IS 'Refresh token used to renew the access token, encrypted with a key derived from the data encryption key';

COMMENT ON COLUMN public.onedrive_tokens.expires_at IS 'When the access token expires';

COMMENT ON COLUMN public.onedrive_tokens.folder_path IS 'OneDrive folder that backups are uploaded to (default /Backups/Nuggets)';

COMMENT ON COLUMN public.onedrive_tokens.auto_sync_enabled IS 'Whether backups are uploaded to OneDrive automatically';

CREATE SEQUENCE public.onedrive_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.onedrive_tokens_id_seq OWNED BY public.onedrive_tokens.id;

CREATE TABLE public.organization_invitations (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    organization_id integer NOT NULL,
    email character varying(255) NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    token_hash text NOT NULL,
    invited_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by integer,
    revoked_at timestamp with time zone,
    CONSTRAINT organization_invitations_email_check CHECK ((((email)::text = lower((email)::text)) AND ((email)::text <> ''::text))),
    CONSTRAINT organization_invitations_one_outcome_check CHECK (((accepted_at IS NULL) OR (revoked_at IS NULL))),
    CONSTRAINT organization_invitations_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

COMMENT ON TABLE public.organization_invitations IS 'Invitations to join an organization ([issue]). Accepted only by a signed-in user with the invited email and the link''s token (stored as token_hash). Control plane: no tenant_id, no RLS.';

CREATE SEQUENCE public.organization_invitations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organization_invitations_id_seq OWNED BY public.organization_invitations.id;

CREATE TABLE public.organization_price_sync_runs (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    organization_id integer DEFAULT public.current_organization_id() NOT NULL,
    run_status character varying(16) DEFAULT 'running'::character varying NOT NULL,
    run_trigger character varying(16) DEFAULT 'scheduler'::character varying NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    tenants_synced integer DEFAULT 0 NOT NULL,
    securities_total integer DEFAULT 0 NOT NULL,
    prices_updated integer DEFAULT 0 NOT NULL,
    prices_failed integer DEFAULT 0 NOT NULL,
    snapshots_written integer DEFAULT 0 NOT NULL,
    error_message text,
    user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.organization_price_sync_runs FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.organization_price_sync_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organization_price_sync_runs_id_seq OWNED BY public.organization_price_sync_runs.id;

CREATE TABLE public.organization_price_sync_settings (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    organization_id integer DEFAULT public.current_organization_id() NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    schedule_time character varying(5) DEFAULT '17:00'::character varying NOT NULL,
    timezone character varying(64) DEFAULT 'America/New_York'::character varying NOT NULL,
    provider character varying(32) DEFAULT 'stooq'::character varying NOT NULL,
    last_run_at timestamp with time zone,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.organization_price_sync_settings FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.organization_price_sync_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organization_price_sync_settings_id_seq OWNED BY public.organization_price_sync_settings.id;

CREATE TABLE public.organization_simplefin_connections (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    organization_id integer DEFAULT public.current_organization_id() NOT NULL,
    access_url text NOT NULL,
    label character varying(100),
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    last_synced_at timestamp with time zone,
    created_by integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.organization_simplefin_connections FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.organization_simplefin_connections_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organization_simplefin_connections_id_seq OWNED BY public.organization_simplefin_connections.id;

CREATE TABLE public.organization_users (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    organization_id integer NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer
);

COMMENT ON TABLE public.organization_users IS 'user <-> organization. is_admin = Organization Admin ("Family Manager"), who administers every budget in the org.';

CREATE SEQUENCE public.organization_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organization_users_id_seq OWNED BY public.organization_users.id;

CREATE TABLE public.organizations (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    name character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

COMMENT ON TABLE public.organizations IS 'A family / grouping of budgets. Global control plane; the future billing anchor.';

CREATE SEQUENCE public.organizations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.organizations_id_seq OWNED BY public.organizations.id;

CREATE TABLE public.passkey_credentials (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    credential_id text NOT NULL,
    public_key text NOT NULL,
    counter bigint DEFAULT 0 NOT NULL,
    device_name character varying(255),
    transports text[],
    aaguid text,
    credential_device_type character varying(50),
    credential_backed_up boolean DEFAULT false,
    last_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    user_handle text,
    discoverable boolean,
    CONSTRAINT passkey_credentials_user_handle_check CHECK ((user_handle ~ '^[A-Za-z0-9_-]{1,86}$'::text))
);

COMMENT ON TABLE public.passkey_credentials IS 'WebAuthn/passkey credentials for passwordless authentication. Stores public keys and credential data for user passkey devices.';

COMMENT ON COLUMN public.passkey_credentials.credential_id IS 'Base64URL-encoded credential ID from WebAuthn registration';

COMMENT ON COLUMN public.passkey_credentials.public_key IS 'Base64URL-encoded COSE public key';

COMMENT ON COLUMN public.passkey_credentials.counter IS 'Signature counter for replay attack prevention';

COMMENT ON COLUMN public.passkey_credentials.device_name IS 'User-provided name for the passkey (e.g. "My phone", "Work laptop")';

COMMENT ON COLUMN public.passkey_credentials.transports IS 'Supported authenticator transports (usb, nfc, ble, internal, hybrid)';

COMMENT ON COLUMN public.passkey_credentials.aaguid IS 'Authenticator attestation GUID identifying the device type';

COMMENT ON COLUMN public.passkey_credentials.credential_device_type IS 'single_device, or multi_device for cloud-synced passkeys';

COMMENT ON COLUMN public.passkey_credentials.credential_backed_up IS 'Whether the credential is backed up (cloud-synced passkeys)';

COMMENT ON COLUMN public.passkey_credentials.user_handle IS 'WebAuthn user handle (base64url) the passkey answers with: its account''s since [issue]; for an older passkey, the one it returned at its first sign-in since, null before that';

COMMENT ON COLUMN public.passkey_credentials.discoverable IS 'Whether the passkey can sign in without an email (a discoverable credential): the browser''s credProps rk at registration, else true (registration requires one); true once it has signed in without one; null when unknown (registered before [issue])';

CREATE SEQUENCE public.passkey_credentials_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.passkey_credentials_id_seq OWNED BY public.passkey_credentials.id;

CREATE TABLE public.personal_access_tokens (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    jti character varying(64) NOT NULL,
    label character varying(100) DEFAULT 'mcp'::character varying NOT NULL,
    audience character varying(32) DEFAULT 'mcp'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_reason character varying(100),
    tenant_id integer NOT NULL,
    scope text DEFAULT 'read_write'::text NOT NULL,
    CONSTRAINT personal_access_tokens_scope_check CHECK ((scope = ANY (ARRAY['read'::text, 'read_write'::text])))
);

COMMENT ON TABLE public.personal_access_tokens IS 'Long-lived JWTs for non-browser clients (MCP). Revocation is soft (revoked_at), so audit trail is retained.';

COMMENT ON COLUMN public.personal_access_tokens.scope IS 'What the token may do on the routes it reaches: read (GET/HEAD only) or read_write.';

CREATE SEQUENCE public.personal_access_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.personal_access_tokens_id_seq OWNED BY public.personal_access_tokens.id;

CREATE TABLE public.portfolio_value_snapshots (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    snapshot_date date NOT NULL,
    total_value numeric(12,2) NOT NULL,
    cost_basis numeric(12,2),
    holdings_count integer DEFAULT 0 NOT NULL,
    priced_securities integer DEFAULT 0 NOT NULL,
    stale_securities integer DEFAULT 0 NOT NULL,
    calculation_method character varying(32) DEFAULT 'scheduled'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.portfolio_value_snapshots FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.portfolio_value_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.portfolio_value_snapshots_id_seq OWNED BY public.portfolio_value_snapshots.id;

CREATE TABLE public.push_subscriptions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    endpoint text NOT NULL,
    keys_encrypted text NOT NULL,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_success_at timestamp with time zone
);

CREATE SEQUENCE public.push_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.push_subscriptions_id_seq OWNED BY public.push_subscriptions.id;

CREATE TABLE public.recurring (
    id integer NOT NULL,
    merchant_id integer,
    amount numeric(12,2) NOT NULL,
    recurring_frequency character varying(50) NOT NULL,
    starting_date date NOT NULL,
    recurring_status character varying(50) NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.recurring FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.recurring_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.recurring_id_seq OWNED BY public.recurring.id;

CREATE TABLE public.schema_migrations (
    version character varying(14) NOT NULL,
    name character varying(255) NOT NULL,
    checksum character varying(64) NOT NULL,
    applied_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    execution_time_ms integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

COMMENT ON TABLE public.schema_migrations IS 'Tracks applied database migrations for version control';

COMMENT ON COLUMN public.schema_migrations.version IS 'Migration version in format YYYYMMDDHHMMSS';

COMMENT ON COLUMN public.schema_migrations.checksum IS 'SHA256 checksum of migration file content to detect modifications';

CREATE TABLE public.securities (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    ticker character varying(20) NOT NULL,
    name character varying(255) NOT NULL,
    security_type character varying(20) DEFAULT 'stock'::character varying NOT NULL,
    exchange character varying(50),
    currency character(3) DEFAULT 'USD'::bpchar NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_custom boolean DEFAULT false NOT NULL,
    is_pass_through boolean DEFAULT false NOT NULL,
    track_underlying_holdings boolean DEFAULT false NOT NULL,
    expense_ratio_percentage numeric(6,4),
    last_price_update_at timestamp with time zone,
    last_composition_update_at timestamp with time zone,
    last_expense_ratio_update_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ticker_key text GENERATED ALWAYS AS (upper((ticker)::text)) STORED,
    CONSTRAINT securities_exchange_normalized CHECK (((exchange IS NULL) OR (((exchange)::text <> ''::text) AND ((exchange)::text = upper(public.trim_space((exchange)::text)))))),
    CONSTRAINT securities_security_type_check CHECK (((security_type)::text = ANY (ARRAY[('stock'::character varying)::text, ('etf'::character varying)::text, ('mutual_fund'::character varying)::text, ('bond'::character varying)::text, ('money_market'::character varying)::text, ('crypto'::character varying)::text, ('other'::character varying)::text]))),
    CONSTRAINT securities_ticker_trimmed CHECK ((((ticker)::text <> ''::text) AND ((ticker)::text = public.trim_space((ticker)::text))))
);

ALTER TABLE ONLY public.securities FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.securities.ticker_key IS 'The ticker in upper case, as a holdings snapshot looks it up ([issue]).';

CREATE SEQUENCE public.securities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.securities_id_seq OWNED BY public.securities.id;

CREATE TABLE public.security_corporate_actions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    security_id integer NOT NULL,
    action_type character varying(32) NOT NULL,
    action_date date NOT NULL,
    numerator numeric(18,6),
    denominator numeric(18,6),
    amount_per_share numeric(12,4),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT security_corporate_actions_action_type_check CHECK (((action_type)::text = ANY (ARRAY[('split'::character varying)::text, ('reverse_split'::character varying)::text, ('return_of_capital'::character varying)::text, ('spinoff'::character varying)::text, ('merger_cash'::character varying)::text, ('merger_stock'::character varying)::text])))
);

ALTER TABLE ONLY public.security_corporate_actions FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.security_corporate_actions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.security_corporate_actions_id_seq OWNED BY public.security_corporate_actions.id;

CREATE TABLE public.security_prices (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    security_id integer NOT NULL,
    price_date date NOT NULL,
    close numeric(12,4) NOT NULL,
    adjusted_close numeric(12,4),
    volume bigint,
    source character varying(128) DEFAULT 'mcp_manual'::character varying NOT NULL,
    user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.security_prices FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.security_prices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.security_prices_id_seq OWNED BY public.security_prices.id;

CREATE TABLE public.sessions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    session_token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_activity_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    rotated_from_session_id integer,
    last_rotated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_revoked boolean DEFAULT false NOT NULL,
    revoked_at timestamp with time zone,
    revocation_reason character varying(100),
    ip_address character varying(45),
    user_agent text,
    device_info jsonb,
    created_after_password_change_at timestamp with time zone,
    active_tenant_id integer,
    original_created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    reauthenticated_at timestamp with time zone
);

COMMENT ON TABLE public.sessions IS 'Server-side sign-in sessions. The httpOnly cookie carries the token; this table keeps its SHA-256 hash. A session ends after SESSION_IDLE_HOURS without use (expires_at slides forward) or SESSION_ABSOLUTE_DAYS after sign-in, whichever comes first.';

COMMENT ON COLUMN public.sessions.session_token_hash IS 'SHA-256 hash of the session token. The token itself is never stored.';

COMMENT ON COLUMN public.sessions.expires_at IS 'Idle expiry. Requests slide it forward, up to the absolute lifetime counted from original_created_at.';

COMMENT ON COLUMN public.sessions.last_activity_at IS 'Last time the session was used for an authenticated request (written at most once per throttle interval).';

COMMENT ON COLUMN public.sessions.rotated_from_session_id IS 'The session this one replaced, when it was created by rotation.';

COMMENT ON COLUMN public.sessions.last_rotated_at IS 'Last time the session token was rotated; decides when the next rotation is due.';

COMMENT ON COLUMN public.sessions.revocation_reason IS 'Why the session was revoked, e.g. logout, logout_all, rotated, password_changed, admin_revoked, replaced_by_login.';

COMMENT ON COLUMN public.sessions.created_after_password_change_at IS 'The user''s password_changed_at when the session was created. A session older than the latest password change is invalid.';

COMMENT ON COLUMN public.sessions.active_tenant_id IS 'Which budget (tenant) this session is currently acting in; source of the per-request tenant GUC in a later phase.';

COMMENT ON COLUMN public.sessions.original_created_at IS 'When the user signed in. Rotation copies it to the new session, so the absolute session lifetime counts from here.';

COMMENT ON COLUMN public.sessions.reauthenticated_at IS 'When the user last proved their password or passkey in this session (signing in counts). Minting tokens and enrolling passkeys need it to be recent.';

CREATE SEQUENCE public.sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.sessions_id_seq OWNED BY public.sessions.id;

CREATE TABLE public.stored_images (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    mime_type text NOT NULL,
    byte_size integer NOT NULL,
    data bytea NOT NULL,
    created_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.stored_images FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.stored_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.stored_images_id_seq OWNED BY public.stored_images.id;

CREATE TABLE public.system_settings (
    id integer NOT NULL,
    setting_key character varying(100) NOT NULL,
    setting_value character varying(500),
    setting_type character varying(50) DEFAULT 'string'::character varying,
    description text,
    category character varying(50) DEFAULT 'general'::character varying,
    is_user_configurable boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    uuid uuid DEFAULT uuidv7() NOT NULL
);

COMMENT ON TABLE public.system_settings IS 'Deployment-wide settings, such as SMTP, backups, OneDrive, Web Push and the notification limits; the secrets among them are stored encrypted. A ledger''s own settings, such as its bank import schedule, are in tenant_settings.';

CREATE SEQUENCE public.system_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.system_settings_id_seq OWNED BY public.system_settings.id;

CREATE TABLE public.taggings (
    id integer NOT NULL,
    tag_id integer NOT NULL,
    taggable_type character varying(50) NOT NULL,
    taggable_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer,
    type character varying(50) DEFAULT 'manual'::character varying,
    report_root_id integer,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL
);

ALTER TABLE ONLY public.taggings FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.taggings.user_id IS 'Audit: the user who created the tagging';

COMMENT ON COLUMN public.taggings.type IS 'manual (a person tagged it) or auto (an auto-tag rule)';

COMMENT ON COLUMN public.taggings.report_root_id IS 'Denormalized pointer to the namespace root for the tag in this tagging. NULL when the tag is not under any report-root namespace. Populated automatically by trigger.';

CREATE SEQUENCE public.taggings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.taggings_id_seq OWNED BY public.taggings.id;

CREATE TABLE public.tags (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    color character varying(7) DEFAULT '#3B82F6'::character varying,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    parent_id integer,
    icon character varying(50) DEFAULT 'Tag'::character varying,
    sort_order integer DEFAULT 0,
    description text,
    level integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_active boolean DEFAULT true NOT NULL,
    is_report_root boolean DEFAULT false NOT NULL,
    report_flow_measure character varying(20) DEFAULT 'effective'::character varying,
    last_used_at timestamp with time zone,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    CONSTRAINT chk_tags_max_level CHECK (((level >= 0) AND (level <= 3))),
    CONSTRAINT chk_tags_report_flow_measure CHECK (((report_flow_measure)::text = ANY (ARRAY[('actual'::character varying)::text, ('allocated'::character varying)::text, ('effective'::character varying)::text]))),
    CONSTRAINT chk_tags_report_root_top_level CHECK (((is_report_root = false) OR (parent_id IS NULL)))
);

ALTER TABLE ONLY public.tags FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.tags.is_active IS 'Inactive tags are kept for history but not offered when tagging transactions';

COMMENT ON COLUMN public.tags.is_report_root IS 'When true, this top-level tag defines a "report namespace" for Sankey reporting. Only meaningful on level-0 tags.';

COMMENT ON COLUMN public.tags.report_flow_measure IS 'Sankey flow measure for the namespace: actual (transactions), allocated (budget events), or effective (hybrid by item characteristics). Only meaningful when is_report_root = true.';

CREATE SEQUENCE public.tags_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;

CREATE VIEW public.tags_with_hierarchy WITH (security_invoker='true') AS
 SELECT t.id,
    t.uuid,
    t.name,
    t.color,
    t.icon,
    t.description,
    t.parent_id,
    t.level,
    t.sort_order,
    t.is_active,
    t.is_report_root,
    t.report_flow_measure,
    t.created_at,
    t.updated_at,
    public.get_tag_hierarchy_path(t.id) AS hierarchy_path,
    p.name AS parent_name,
    p.uuid AS parent_uuid,
    ( SELECT count(*) AS count
           FROM public.tags
          WHERE (tags.parent_id = t.id)) AS child_count,
    ( SELECT count(*) AS count
           FROM public.taggings
          WHERE ((taggings.tag_id = t.id) AND ((taggings.taggable_type)::text = 'transaction'::text))) AS transaction_count,
    ( SELECT count(*) AS count
           FROM public.taggings
          WHERE ((taggings.tag_id = t.id) AND ((taggings.taggable_type)::text = 'budget_item'::text))) AS budget_item_count,
    t.last_used_at
   FROM (public.tags t
     LEFT JOIN public.tags p ON ((t.parent_id = p.id)));

CREATE TABLE public.tax_lots (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    account_id integer NOT NULL,
    security_id integer NOT NULL,
    created_by_event_id integer NOT NULL,
    parent_lot_id integer,
    acquisition_date date NOT NULL,
    holding_period_start date NOT NULL,
    shares_original numeric(18,6) NOT NULL,
    shares_remaining numeric(18,6) NOT NULL,
    cost_basis_per_share numeric(12,4) NOT NULL,
    total_cost_basis numeric(12,2) NOT NULL,
    acquisition_method character varying(32) DEFAULT 'purchase'::character varying NOT NULL,
    is_open boolean DEFAULT true NOT NULL,
    is_covered boolean DEFAULT true NOT NULL,
    data_quality character varying(32) DEFAULT 'complete'::character varying NOT NULL,
    external_reference character varying(255),
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tax_lots_acquisition_method_check CHECK (((acquisition_method)::text = ANY (ARRAY[('purchase'::character varying)::text, ('dividend_reinvest'::character varying)::text, ('split_adjustment'::character varying)::text, ('spinoff'::character varying)::text, ('transfer_in'::character varying)::text, ('inheritance'::character varying)::text, ('gift_received'::character varying)::text, ('employer_match'::character varying)::text, ('espp'::character varying)::text, ('manual_adjustment'::character varying)::text, ('historical_balance_plant'::character varying)::text, ('merger'::character varying)::text]))),
    CONSTRAINT tax_lots_data_quality_check CHECK (((data_quality)::text = ANY (ARRAY[('complete'::character varying)::text, ('imputed_date'::character varying)::text, ('imputed_basis'::character varying)::text, ('aggregate_only'::character varying)::text, ('unknown_provenance'::character varying)::text])))
);

ALTER TABLE ONLY public.tax_lots FORCE ROW LEVEL SECURITY;

CREATE SEQUENCE public.tax_lots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tax_lots_id_seq OWNED BY public.tax_lots.id;

CREATE TABLE public.tenant_settings (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    setting_key character varying(100) NOT NULL,
    setting_value text,
    updated_by_user_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT tenant_settings_setting_key_check CHECK (((setting_key)::text = ANY ((ARRAY['application_timezone'::character varying, 'application_currency'::character varying, 'application_locale'::character varying, 'import_enabled'::character varying, 'import_manual_sync_enabled'::character varying, 'import_sync_frequency'::character varying, 'import_sync_time'::character varying, 'import_days_back'::character varying, 'import_user_id'::character varying, 'import_last_auto_sync'::character varying, 'import_last_attempt'::character varying])::text[])))
);

ALTER TABLE ONLY public.tenant_settings FORCE ROW LEVEL SECURITY;

COMMENT ON TABLE public.tenant_settings IS 'A ledger''s own settings ([issue]): its time zone and its bank import schedule. Deployment-wide settings stay in system_settings.';

COMMENT ON COLUMN public.tenant_settings.setting_key IS 'One of the keys the check constraint lists.';

CREATE SEQUENCE public.tenant_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tenant_settings_id_seq OWNED BY public.tenant_settings.id;

CREATE TABLE public.tenant_users (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    tenant_id integer NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer
);

COMMENT ON TABLE public.tenant_users IS 'user <-> tenant/budget. is_admin = Tenant Admin for that budget.';

CREATE SEQUENCE public.tenant_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tenant_users_id_seq OWNED BY public.tenant_users.id;

CREATE TABLE public.tenants (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    organization_id integer NOT NULL,
    name character varying(100) NOT NULL,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    balance_adjustment_merchant_id integer
);

COMMENT ON TABLE public.tenants IS 'One budget = the per-budget data isolation unit (RLS lands here in a later phase). Belongs to an organization.';

COMMENT ON COLUMN public.tenants.balance_adjustment_merchant_id IS 'Per-ledger merchant assigned to balance-adjustment transactions (manual Adjust Balance + SimpleFin auto-rebalance). NULL = no merchant.';

CREATE SEQUENCE public.tenants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tenants_id_seq OWNED BY public.tenants.id;

CREATE TABLE public.transactions (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    notes text,
    description character varying(255),
    amount numeric(12,2) DEFAULT 0.00 NOT NULL,
    type character varying(50) NOT NULL,
    status character varying(50) DEFAULT 'pending'::character varying NOT NULL,
    account_id integer NOT NULL,
    budget_item_id integer,
    merchant_id integer,
    synced_amount numeric(12,2) DEFAULT 0.00,
    synced_transactiondate timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    synced_category character varying(255),
    synced_name character varying(255),
    synced_location character varying(1000),
    synced_description text,
    institution_transaction_status character varying(100),
    budget_period_id integer,
    budget_period_item_id integer,
    review_status character varying(50) DEFAULT 'needs review'::character varying NOT NULL,
    transaction_date date NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    assigned_to integer,
    import_transaction_id character varying(255),
    import_posted_date timestamp with time zone,
    import_transacted_at timestamp with time zone,
    import_amount numeric(12,2),
    import_description text,
    import_pending boolean DEFAULT false NOT NULL,
    import_extra jsonb,
    import_imported_at timestamp with time zone,
    is_import boolean DEFAULT false NOT NULL,
    import_provider character varying(50) DEFAULT 'simplefin'::character varying,
    budget_matching_method character varying(50),
    budget_matching_confidence numeric(3,2),
    budget_matching_rule_id integer,
    transfer_transaction_id integer,
    transfer_source_account_id integer,
    parent_transaction_id integer,
    is_split_parent boolean DEFAULT false NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    external_transaction_id text,
    external_link text,
    import_payee character varying(500),
    budget_period_cleared_from integer,
    budget_period_cleared_start date
);

ALTER TABLE ONLY public.transactions FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.transactions.transfer_transaction_id IS 'The other side of a transfer (each side points at the other)';

COMMENT ON COLUMN public.transactions.transfer_source_account_id IS 'On the destination side of a transfer: the source account';

COMMENT ON COLUMN public.transactions.parent_transaction_id IS 'On a split child: the transaction it was split from';

COMMENT ON COLUMN public.transactions.is_split_parent IS 'True when the transaction is split into child transactions; its splits add up to it';

COMMENT ON COLUMN public.transactions.import_payee IS 'Payee name as reported by the import provider (e.g. SimpleFin''s pre-cleaned merchant name). Null for manual transactions and providers that omit it.';

COMMENT ON COLUMN public.transactions.budget_period_cleared_from IS 'The budget period an update last took this transaction out of, null once it is in one again: a bank sync doesn''t put it back in one ([issue]).';

COMMENT ON COLUMN public.transactions.budget_period_cleared_start IS 'The first day of the budget period it was taken out of: deleted, and its month''s period made again, the sync puts it back in that one ([issue]).';

CREATE SEQUENCE public.transactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.transactions_id_seq OWNED BY public.transactions.id;

CREATE TABLE public.user_profile_images (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    user_id integer NOT NULL,
    mime_type text NOT NULL,
    byte_size integer NOT NULL,
    data bytea NOT NULL,
    created_by_user_id integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE SEQUENCE public.user_profile_images_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.user_profile_images_id_seq OWNED BY public.user_profile_images.id;

CREATE TABLE public.users (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    first_name character varying(100),
    last_name character varying(100),
    profile_image character varying(500),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_locked boolean DEFAULT false NOT NULL,
    default_color character varying(7) DEFAULT '#3B82F6'::character varying,
    icon character varying(100) DEFAULT 'User'::character varying,
    password_changed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    login_disabled boolean DEFAULT false NOT NULL,
    last_tenant_id integer,
    must_change_password boolean DEFAULT false NOT NULL,
    webauthn_user_id text,
    CONSTRAINT users_webauthn_user_id_check CHECK ((webauthn_user_id ~ '^[A-Za-z0-9_-]{43}$'::text))
);

COMMENT ON COLUMN public.users.password_changed_at IS 'When the password last changed. Sessions created before it are invalid.';

COMMENT ON COLUMN public.users.login_disabled IS 'Service account: interactive login (password/passkey/session) is blocked; token (PAT/MCP) auth still works. Independent of is_locked.';

COMMENT ON COLUMN public.users.must_change_password IS 'An admin set this password (a new account, or a reset): the user must replace it before their session reaches anything else.';

COMMENT ON COLUMN public.users.webauthn_user_id IS 'WebAuthn user handle (32 random bytes, base64url) every passkey of the account is registered under; made at its first passkey registration since [issue], never changed';

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

CREATE TABLE public.wash_sale_records (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    tenant_id integer DEFAULT public.current_tenant_id() NOT NULL,
    loss_lot_consumption_id integer NOT NULL,
    replacement_lot_id integer,
    disallowed_loss numeric(12,2) NOT NULL,
    basis_adjustment numeric(12,2) DEFAULT 0 NOT NULL,
    is_manual_override boolean DEFAULT false NOT NULL,
    detection_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    replacement_shares numeric(18,6) DEFAULT 0 NOT NULL,
    loss_shares numeric(18,6) NOT NULL
);

ALTER TABLE ONLY public.wash_sale_records FORCE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.wash_sale_records.replacement_shares IS 'Shares of the replacement lot matched to the loss shares: one per loss share when matched, scaled since by the lot''s splits.';

COMMENT ON COLUMN public.wash_sale_records.loss_shares IS 'Loss shares this record matched, as they were sold ([issue]).';

CREATE SEQUENCE public.wash_sale_records_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.wash_sale_records_id_seq OWNED BY public.wash_sale_records.id;

CREATE TABLE public.webauthn_challenges (
    id integer NOT NULL,
    uuid uuid DEFAULT uuidv7() NOT NULL,
    browser_hash text NOT NULL,
    purpose text NOT NULL,
    user_id integer,
    challenge text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT webauthn_challenges_browser_hash_check CHECK ((browser_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT webauthn_challenges_purpose_check CHECK ((purpose = ANY (ARRAY['registration'::text, 'authentication'::text, 'reauthentication'::text]))),
    CONSTRAINT webauthn_challenges_user_check CHECK (((purpose = 'authentication'::text) = (user_id IS NULL)))
);

COMMENT ON TABLE public.webauthn_challenges IS 'Passkey ceremony challenges ([issue]), each for the browser that started it (browser_hash: SHA-256 of a random id in its httpOnly cookie). Single use. Control plane: no tenant_id, no RLS.';

CREATE SEQUENCE public.webauthn_challenges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.webauthn_challenges_id_seq OWNED BY public.webauthn_challenges.id;

ALTER TABLE ONLY public.account_currencies ALTER COLUMN id SET DEFAULT nextval('public.account_currencies_id_seq'::regclass);

ALTER TABLE ONLY public.account_hidden_ranges ALTER COLUMN id SET DEFAULT nextval('public.account_hidden_ranges_id_seq'::regclass);

ALTER TABLE ONLY public.account_imported_balance_history ALTER COLUMN id SET DEFAULT nextval('public.account_imported_balance_history_id_seq'::regclass);

ALTER TABLE ONLY public.account_institutions ALTER COLUMN id SET DEFAULT nextval('public.account_institutions_id_seq'::regclass);

ALTER TABLE ONLY public.accounts ALTER COLUMN id SET DEFAULT nextval('public.accounts_id_seq'::regclass);

ALTER TABLE ONLY public.annotations ALTER COLUMN id SET DEFAULT nextval('public.annotations_id_seq'::regclass);

ALTER TABLE ONLY public.attachments ALTER COLUMN id SET DEFAULT nextval('public.attachments_id_seq'::regclass);

ALTER TABLE ONLY public.bill_occurrence_transactions ALTER COLUMN id SET DEFAULT nextval('public.bill_occurrence_transactions_id_seq'::regclass);

ALTER TABLE ONLY public.bill_occurrences ALTER COLUMN id SET DEFAULT nextval('public.bill_occurrences_id_seq'::regclass);

ALTER TABLE ONLY public.budget_alert_tracking ALTER COLUMN id SET DEFAULT nextval('public.budget_alert_tracking_id_seq'::regclass);

ALTER TABLE ONLY public.budget_item_accounts ALTER COLUMN id SET DEFAULT nextval('public.budget_item_accounts_id_seq'::regclass);

ALTER TABLE ONLY public.budget_item_matching_rules ALTER COLUMN id SET DEFAULT nextval('public.budget_item_matching_rules_id_seq'::regclass);

ALTER TABLE ONLY public.budget_item_usage_history ALTER COLUMN id SET DEFAULT nextval('public.budget_item_usage_history_id_seq'::regclass);

ALTER TABLE ONLY public.budget_items ALTER COLUMN id SET DEFAULT nextval('public.budget_items_id_seq'::regclass);

ALTER TABLE ONLY public.budget_period ALTER COLUMN id SET DEFAULT nextval('public.budget_period_id_seq'::regclass);

ALTER TABLE ONLY public.budget_period_items ALTER COLUMN id SET DEFAULT nextval('public.budget_period_items_id_seq'::regclass);

ALTER TABLE ONLY public.budget_period_transactions ALTER COLUMN id SET DEFAULT nextval('public.budget_period_transactions_id_seq'::regclass);

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);

ALTER TABLE ONLY public.cost_basis_method_settings ALTER COLUMN id SET DEFAULT nextval('public.cost_basis_method_settings_id_seq'::regclass);

ALTER TABLE ONLY public.data_freshness_thresholds ALTER COLUMN id SET DEFAULT nextval('public.data_freshness_thresholds_id_seq'::regclass);

ALTER TABLE ONLY public.deployment ALTER COLUMN id SET DEFAULT nextval('public.deployment_id_seq'::regclass);

ALTER TABLE ONLY public.deployment_users ALTER COLUMN id SET DEFAULT nextval('public.deployment_users_id_seq'::regclass);

ALTER TABLE ONLY public.dividend_records ALTER COLUMN id SET DEFAULT nextval('public.dividend_records_id_seq'::regclass);

ALTER TABLE ONLY public.fund_compositions ALTER COLUMN id SET DEFAULT nextval('public.fund_compositions_id_seq'::regclass);

ALTER TABLE ONLY public.fund_underlying_holdings ALTER COLUMN id SET DEFAULT nextval('public.fund_underlying_holdings_id_seq'::regclass);

ALTER TABLE ONLY public.goal_budget_items ALTER COLUMN id SET DEFAULT nextval('public.goal_budget_items_id_seq'::regclass);

ALTER TABLE ONLY public.holding_events ALTER COLUMN id SET DEFAULT nextval('public.holding_events_id_seq'::regclass);

ALTER TABLE ONLY public.import_sync_log ALTER COLUMN id SET DEFAULT nextval('public.import_sync_log_id_seq'::regclass);

ALTER TABLE ONLY public.login_throttles ALTER COLUMN id SET DEFAULT nextval('public.login_throttles_id_seq'::regclass);

ALTER TABLE ONLY public.lot_consumptions ALTER COLUMN id SET DEFAULT nextval('public.lot_consumptions_id_seq'::regclass);

ALTER TABLE ONLY public.merchant_matching_rules ALTER COLUMN id SET DEFAULT nextval('public.merchant_matching_rules_id_seq'::regclass);

ALTER TABLE ONLY public.merchants ALTER COLUMN id SET DEFAULT nextval('public.merchants_id_seq'::regclass);

ALTER TABLE ONLY public.net_worth_snapshots ALTER COLUMN id SET DEFAULT nextval('public.net_worth_snapshots_id_seq'::regclass);

ALTER TABLE ONLY public.notification_deliveries ALTER COLUMN id SET DEFAULT nextval('public.notification_deliveries_id_seq'::regclass);

ALTER TABLE ONLY public.notification_preferences ALTER COLUMN id SET DEFAULT nextval('public.notification_preferences_id_seq'::regclass);

ALTER TABLE ONLY public.notification_rule_sets ALTER COLUMN id SET DEFAULT nextval('public.notification_rule_sets_id_seq'::regclass);

ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);

ALTER TABLE ONLY public.onedrive_tokens ALTER COLUMN id SET DEFAULT nextval('public.onedrive_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.organization_invitations ALTER COLUMN id SET DEFAULT nextval('public.organization_invitations_id_seq'::regclass);

ALTER TABLE ONLY public.organization_price_sync_runs ALTER COLUMN id SET DEFAULT nextval('public.organization_price_sync_runs_id_seq'::regclass);

ALTER TABLE ONLY public.organization_price_sync_settings ALTER COLUMN id SET DEFAULT nextval('public.organization_price_sync_settings_id_seq'::regclass);

ALTER TABLE ONLY public.organization_simplefin_connections ALTER COLUMN id SET DEFAULT nextval('public.organization_simplefin_connections_id_seq'::regclass);

ALTER TABLE ONLY public.organization_users ALTER COLUMN id SET DEFAULT nextval('public.organization_users_id_seq'::regclass);

ALTER TABLE ONLY public.organizations ALTER COLUMN id SET DEFAULT nextval('public.organizations_id_seq'::regclass);

ALTER TABLE ONLY public.passkey_credentials ALTER COLUMN id SET DEFAULT nextval('public.passkey_credentials_id_seq'::regclass);

ALTER TABLE ONLY public.personal_access_tokens ALTER COLUMN id SET DEFAULT nextval('public.personal_access_tokens_id_seq'::regclass);

ALTER TABLE ONLY public.portfolio_value_snapshots ALTER COLUMN id SET DEFAULT nextval('public.portfolio_value_snapshots_id_seq'::regclass);

ALTER TABLE ONLY public.push_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.push_subscriptions_id_seq'::regclass);

ALTER TABLE ONLY public.recurring ALTER COLUMN id SET DEFAULT nextval('public.recurring_id_seq'::regclass);

ALTER TABLE ONLY public.securities ALTER COLUMN id SET DEFAULT nextval('public.securities_id_seq'::regclass);

ALTER TABLE ONLY public.security_corporate_actions ALTER COLUMN id SET DEFAULT nextval('public.security_corporate_actions_id_seq'::regclass);

ALTER TABLE ONLY public.security_prices ALTER COLUMN id SET DEFAULT nextval('public.security_prices_id_seq'::regclass);

ALTER TABLE ONLY public.sessions ALTER COLUMN id SET DEFAULT nextval('public.sessions_id_seq'::regclass);

ALTER TABLE ONLY public.stored_images ALTER COLUMN id SET DEFAULT nextval('public.stored_images_id_seq'::regclass);

ALTER TABLE ONLY public.system_settings ALTER COLUMN id SET DEFAULT nextval('public.system_settings_id_seq'::regclass);

ALTER TABLE ONLY public.taggings ALTER COLUMN id SET DEFAULT nextval('public.taggings_id_seq'::regclass);

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);

ALTER TABLE ONLY public.tax_lots ALTER COLUMN id SET DEFAULT nextval('public.tax_lots_id_seq'::regclass);

ALTER TABLE ONLY public.tenant_settings ALTER COLUMN id SET DEFAULT nextval('public.tenant_settings_id_seq'::regclass);

ALTER TABLE ONLY public.tenant_users ALTER COLUMN id SET DEFAULT nextval('public.tenant_users_id_seq'::regclass);

ALTER TABLE ONLY public.tenants ALTER COLUMN id SET DEFAULT nextval('public.tenants_id_seq'::regclass);

ALTER TABLE ONLY public.transactions ALTER COLUMN id SET DEFAULT nextval('public.transactions_id_seq'::regclass);

ALTER TABLE ONLY public.user_profile_images ALTER COLUMN id SET DEFAULT nextval('public.user_profile_images_id_seq'::regclass);

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);

ALTER TABLE ONLY public.wash_sale_records ALTER COLUMN id SET DEFAULT nextval('public.wash_sale_records_id_seq'::regclass);

ALTER TABLE ONLY public.webauthn_challenges ALTER COLUMN id SET DEFAULT nextval('public.webauthn_challenges_id_seq'::regclass);

ALTER TABLE ONLY public.account_currencies
    ADD CONSTRAINT account_currencies_account_id_key UNIQUE (tenant_id, account_id);

ALTER TABLE ONLY public.account_currencies
    ADD CONSTRAINT account_currencies_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.account_currencies
    ADD CONSTRAINT account_currencies_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.account_currencies
    ADD CONSTRAINT account_currencies_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.account_hidden_ranges
    ADD CONSTRAINT account_hidden_ranges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.account_hidden_ranges
    ADD CONSTRAINT account_hidden_ranges_tenant_id_account_id_hidden_from_key UNIQUE NULLS NOT DISTINCT (tenant_id, account_id, hidden_from);

ALTER TABLE ONLY public.account_hidden_ranges
    ADD CONSTRAINT account_hidden_ranges_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.account_imported_balance_history
    ADD CONSTRAINT account_imported_balance_history_account_id_balance_date_key UNIQUE (tenant_id, account_id, balance_date);

ALTER TABLE ONLY public.account_imported_balance_history
    ADD CONSTRAINT account_imported_balance_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.account_imported_balance_history
    ADD CONSTRAINT account_imported_balance_history_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.account_institutions
    ADD CONSTRAINT account_institutions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.account_institutions
    ADD CONSTRAINT account_institutions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.account_institutions
    ADD CONSTRAINT account_institutions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_transaction_key UNIQUE (transaction_id);

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_bill_due_key UNIQUE (budget_item_id, due_date);

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_item_accounts
    ADD CONSTRAINT budget_item_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_item_accounts
    ADD CONSTRAINT budget_item_accounts_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_item_matching_rules
    ADD CONSTRAINT budget_item_matching_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_item_matching_rules
    ADD CONSTRAINT budget_item_matching_rules_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.budget_item_matching_rules
    ADD CONSTRAINT budget_item_matching_rules_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_item_usage_history
    ADD CONSTRAINT budget_item_usage_history_budget_item_id_merchant_id_key UNIQUE (tenant_id, budget_item_id, merchant_id);

ALTER TABLE ONLY public.budget_item_usage_history
    ADD CONSTRAINT budget_item_usage_history_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_item_usage_history
    ADD CONSTRAINT budget_item_usage_history_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT budget_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT budget_items_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT budget_items_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_budget_period_id_budget_item_id_key UNIQUE (tenant_id, budget_period_id, budget_item_id);

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_period
    ADD CONSTRAINT budget_period_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_period
    ADD CONSTRAINT budget_period_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.budget_period
    ADD CONSTRAINT budget_period_tenant_month_key UNIQUE (tenant_id, year, month_number);

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.budget_period
    ADD CONSTRAINT budget_period_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.cost_basis_method_settings
    ADD CONSTRAINT cost_basis_method_settings_account_security_key UNIQUE (account_id, security_id);

ALTER TABLE ONLY public.cost_basis_method_settings
    ADD CONSTRAINT cost_basis_method_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.cost_basis_method_settings
    ADD CONSTRAINT cost_basis_method_settings_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.data_freshness_thresholds
    ADD CONSTRAINT data_freshness_thresholds_natural_key UNIQUE (security_id, data_category);

ALTER TABLE ONLY public.data_freshness_thresholds
    ADD CONSTRAINT data_freshness_thresholds_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.data_freshness_thresholds
    ADD CONSTRAINT data_freshness_thresholds_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.deployment
    ADD CONSTRAINT deployment_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deployment_users
    ADD CONSTRAINT deployment_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.deployment_users
    ADD CONSTRAINT deployment_users_user_id_deployment_id_key UNIQUE (user_id, deployment_id);

ALTER TABLE ONLY public.deployment_users
    ADD CONSTRAINT deployment_users_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.deployment
    ADD CONSTRAINT deployment_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.dividend_records
    ADD CONSTRAINT dividend_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.dividend_records
    ADD CONSTRAINT dividend_records_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.fund_compositions
    ADD CONSTRAINT fund_compositions_natural_key UNIQUE (security_id, dimension, dimension_value, snapshot_date);

ALTER TABLE ONLY public.fund_compositions
    ADD CONSTRAINT fund_compositions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fund_compositions
    ADD CONSTRAINT fund_compositions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.fund_underlying_holdings
    ADD CONSTRAINT fund_underlying_holdings_natural_key UNIQUE (security_id, underlying_security_id, snapshot_date);

ALTER TABLE ONLY public.fund_underlying_holdings
    ADD CONSTRAINT fund_underlying_holdings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.fund_underlying_holdings
    ADD CONSTRAINT fund_underlying_holdings_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.goal_budget_items
    ADD CONSTRAINT goal_budget_items_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.goal_budget_items
    ADD CONSTRAINT goal_budget_items_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.import_sync_log
    ADD CONSTRAINT import_sync_log_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.import_sync_log
    ADD CONSTRAINT import_sync_log_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.login_throttles
    ADD CONSTRAINT login_throttles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.login_throttles
    ADD CONSTRAINT login_throttles_throttle_key_key UNIQUE (throttle_key);

ALTER TABLE ONLY public.login_throttles
    ADD CONSTRAINT login_throttles_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.merchant_matching_rules
    ADD CONSTRAINT merchant_matching_rules_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.merchant_matching_rules
    ADD CONSTRAINT merchant_matching_rules_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.merchants
    ADD CONSTRAINT merchants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.merchants
    ADD CONSTRAINT merchants_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.merchants
    ADD CONSTRAINT merchants_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.net_worth_snapshots
    ADD CONSTRAINT net_worth_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.net_worth_snapshots
    ADD CONSTRAINT net_worth_snapshots_snapshot_date_aggregation_level_key UNIQUE (tenant_id, snapshot_date, aggregation_level);

ALTER TABLE ONLY public.net_worth_snapshots
    ADD CONSTRAINT net_worth_snapshots_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_subject_key UNIQUE (tenant_id, rule_key, user_id, subject_key);

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_person_rule_key UNIQUE (tenant_id, user_id, rule_key);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.notification_rule_sets
    ADD CONSTRAINT notification_rule_sets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notification_rule_sets
    ADD CONSTRAINT notification_rule_sets_tenant_key UNIQUE (tenant_id);

ALTER TABLE ONLY public.notification_rule_sets
    ADD CONSTRAINT notification_rule_sets_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.onedrive_tokens
    ADD CONSTRAINT onedrive_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.onedrive_tokens
    ADD CONSTRAINT onedrive_tokens_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.onedrive_tokens
    ADD CONSTRAINT onedrive_tokens_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT organization_invitations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT organization_invitations_token_hash_key UNIQUE (token_hash);

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT organization_invitations_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.organization_price_sync_runs
    ADD CONSTRAINT organization_price_sync_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organization_price_sync_runs
    ADD CONSTRAINT organization_price_sync_runs_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.organization_price_sync_settings
    ADD CONSTRAINT organization_price_sync_settings_org_key UNIQUE (organization_id);

ALTER TABLE ONLY public.organization_price_sync_settings
    ADD CONSTRAINT organization_price_sync_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organization_price_sync_settings
    ADD CONSTRAINT organization_price_sync_settings_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.organization_simplefin_connections
    ADD CONSTRAINT organization_simplefin_connections_org_key UNIQUE (organization_id);

ALTER TABLE ONLY public.organization_simplefin_connections
    ADD CONSTRAINT organization_simplefin_connections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organization_simplefin_connections
    ADD CONSTRAINT organization_simplefin_connections_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_user_id_organization_id_key UNIQUE (user_id, organization_id);

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.passkey_credentials
    ADD CONSTRAINT passkey_credentials_credential_id_key UNIQUE (credential_id);

ALTER TABLE ONLY public.passkey_credentials
    ADD CONSTRAINT passkey_credentials_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.passkey_credentials
    ADD CONSTRAINT passkey_credentials_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_jti_key UNIQUE (jti);

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.portfolio_value_snapshots
    ADD CONSTRAINT portfolio_value_snapshots_natural_key UNIQUE (tenant_id, snapshot_date);

ALTER TABLE ONLY public.portfolio_value_snapshots
    ADD CONSTRAINT portfolio_value_snapshots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.portfolio_value_snapshots
    ADD CONSTRAINT portfolio_value_snapshots_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.recurring
    ADD CONSTRAINT recurring_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.recurring
    ADD CONSTRAINT recurring_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);

ALTER TABLE ONLY public.securities
    ADD CONSTRAINT securities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.securities
    ADD CONSTRAINT securities_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.securities
    ADD CONSTRAINT securities_ticker_key_exchange_key UNIQUE NULLS NOT DISTINCT (tenant_id, ticker_key, exchange);

ALTER TABLE ONLY public.securities
    ADD CONSTRAINT securities_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.security_corporate_actions
    ADD CONSTRAINT security_corporate_actions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_corporate_actions
    ADD CONSTRAINT security_corporate_actions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.security_corporate_actions
    ADD CONSTRAINT security_corporate_actions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.security_prices
    ADD CONSTRAINT security_prices_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.security_prices
    ADD CONSTRAINT security_prices_security_date_key UNIQUE (security_id, price_date);

ALTER TABLE ONLY public.security_prices
    ADD CONSTRAINT security_prices_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_session_token_hash_key UNIQUE (session_token_hash);

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.stored_images
    ADD CONSTRAINT stored_images_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.stored_images
    ADD CONSTRAINT stored_images_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_setting_key_key UNIQUE (setting_key);

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_tag_id_taggable_type_taggable_id_key UNIQUE (tenant_id, tag_id, taggable_type, taggable_id);

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_name_key UNIQUE (tenant_id, name);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_tenant_id_setting_key_key UNIQUE (tenant_id, setting_key);

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_user_id_tenant_id_key UNIQUE (user_id, tenant_id);

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.user_profile_images
    ADD CONSTRAINT user_profile_images_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_profile_images
    ADD CONSTRAINT user_profile_images_user_id_key UNIQUE (user_id);

ALTER TABLE ONLY public.user_profile_images
    ADD CONSTRAINT user_profile_images_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_webauthn_user_id_key UNIQUE (webauthn_user_id);

ALTER TABLE ONLY public.wash_sale_records
    ADD CONSTRAINT wash_sale_records_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.wash_sale_records
    ADD CONSTRAINT wash_sale_records_uuid_key UNIQUE (uuid);

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_challenge_key UNIQUE (challenge);

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_uuid_key UNIQUE (uuid);

CREATE UNIQUE INDEX account_hidden_ranges_open_key ON public.account_hidden_ranges USING btree (tenant_id, account_id) WHERE (hidden_to IS NULL);

CREATE UNIQUE INDEX budget_item_accounts_open_link_key ON public.budget_item_accounts USING btree (tenant_id, budget_item_id, account_id) WHERE (valid_to IS NULL);

CREATE UNIQUE INDEX goal_budget_items_open_link_key ON public.goal_budget_items USING btree (tenant_id, goal_id, budget_item_id) WHERE (valid_to IS NULL);

CREATE INDEX idx_account_imported_balance_history_account_currency_id ON public.account_imported_balance_history USING btree (account_currency_id);

CREATE INDEX idx_account_imported_balance_history_balance_date ON public.account_imported_balance_history USING btree (balance_date DESC);

CREATE INDEX idx_accounts_custom_sort ON public.accounts USING btree (custom_sort) WHERE (custom_sort IS NOT NULL);

CREATE INDEX idx_accounts_default_pay_from ON public.accounts USING btree (default_pay_from_account_id) WHERE (default_pay_from_account_id IS NOT NULL);

CREATE INDEX idx_accounts_import_default_assigned_to ON public.accounts USING btree (import_default_assigned_to);

CREATE INDEX idx_accounts_institution_id ON public.accounts USING btree (institution_id);

CREATE INDEX idx_accounts_is_envelope ON public.accounts USING btree (is_envelope_account) WHERE (is_envelope_account = true);

CREATE INDEX idx_accounts_require_zero_balance ON public.accounts USING btree (require_zero_balance) WHERE (require_zero_balance = true);

CREATE INDEX idx_accounts_simplefin_connection_id ON public.accounts USING btree (simplefin_connection_id);

CREATE INDEX idx_annotations_cursor ON public.annotations USING btree (tenant_id, created_at);

CREATE INDEX idx_annotations_notify_open ON public.annotations USING btree (tenant_id, subject_type, subject_id) WHERE ((notify = true) AND (status = 'open'::text));

CREATE INDEX idx_annotations_parent ON public.annotations USING btree (parent_id);

CREATE INDEX idx_annotations_status ON public.annotations USING btree (tenant_id, status, notify);

CREATE INDEX idx_annotations_subject ON public.annotations USING btree (tenant_id, subject_type, subject_id, created_at);

CREATE INDEX idx_attachments_attachment_type ON public.attachments USING btree (attachment_type);

CREATE INDEX idx_attachments_bill_date ON public.attachments USING btree (bill_date);

CREATE INDEX idx_attachments_budget_item_id ON public.attachments USING btree (budget_item_id);

CREATE INDEX idx_attachments_date_uploaded ON public.attachments USING btree (date_uploaded);

CREATE INDEX idx_attachments_file_extension ON public.attachments USING btree (file_extension);

CREATE INDEX idx_attachments_holding_event_id ON public.attachments USING btree (holding_event_id);

CREATE INDEX idx_attachments_merchant_id ON public.attachments USING btree (merchant_id);

CREATE INDEX idx_attachments_tenant_id ON public.attachments USING btree (tenant_id);

CREATE INDEX idx_attachments_transaction_id ON public.attachments USING btree (transaction_id);

CREATE INDEX idx_bill_occurrence_transactions_created_by_user_id ON public.bill_occurrence_transactions USING btree (created_by_user_id);

CREATE INDEX idx_bill_occurrence_transactions_occurrence ON public.bill_occurrence_transactions USING btree (bill_occurrence_id);

CREATE INDEX idx_bill_occurrence_transactions_tenant_id ON public.bill_occurrence_transactions USING btree (tenant_id);

CREATE INDEX idx_bill_occurrences_tenant_due ON public.bill_occurrences USING btree (tenant_id, due_date);

CREATE INDEX idx_bill_occurrences_updated_by_user_id ON public.bill_occurrences USING btree (updated_by_user_id);

CREATE INDEX idx_budget_alert_tracking_budget_item_id ON public.budget_alert_tracking USING btree (budget_item_id);

CREATE INDEX idx_budget_alert_tracking_period ON public.budget_alert_tracking USING btree (budget_period_id);

CREATE INDEX idx_budget_alert_tracking_period_item ON public.budget_alert_tracking USING btree (budget_period_item_id);

CREATE INDEX idx_budget_alert_tracking_resolved ON public.budget_alert_tracking USING btree (resolved) WHERE (resolved = false);

CREATE INDEX idx_budget_alert_tracking_user ON public.budget_alert_tracking USING btree (user_id);

CREATE INDEX idx_budget_item_accounts_account_id ON public.budget_item_accounts USING btree (account_id);

CREATE INDEX idx_budget_item_accounts_lookup ON public.budget_item_accounts USING btree (budget_item_id, account_id);

CREATE INDEX idx_budget_item_matching_rules_active ON public.budget_item_matching_rules USING btree (is_active);

CREATE INDEX idx_budget_item_matching_rules_budget_item_id ON public.budget_item_matching_rules USING btree (budget_item_id);

CREATE INDEX idx_budget_item_matching_rules_merchant_id ON public.budget_item_matching_rules USING btree (merchant_id);

CREATE INDEX idx_budget_item_matching_rules_method ON public.budget_item_matching_rules USING btree (method);

CREATE INDEX idx_budget_item_matching_rules_priority ON public.budget_item_matching_rules USING btree (priority);

CREATE INDEX idx_budget_item_usage_history_budget_item_id ON public.budget_item_usage_history USING btree (budget_item_id);

CREATE INDEX idx_budget_item_usage_history_last_used ON public.budget_item_usage_history USING btree (last_used_date DESC);

CREATE INDEX idx_budget_item_usage_history_merchant_id ON public.budget_item_usage_history USING btree (merchant_id);

CREATE INDEX idx_budget_item_usage_history_usage_count ON public.budget_item_usage_history USING btree (usage_count DESC);

CREATE INDEX idx_budget_items_category_id ON public.budget_items USING btree (category_id);

CREATE INDEX idx_budget_items_expense_type_savings ON public.budget_items USING btree (expense_type) WHERE ((expense_type)::text = 'Savings'::text);

CREATE INDEX idx_budget_items_goal_target_date ON public.budget_items USING btree (goal_target_date) WHERE (goal_target_date IS NOT NULL);

CREATE INDEX idx_budget_items_merchant_id ON public.budget_items USING btree (merchant_id);

CREATE INDEX idx_budget_items_status ON public.budget_items USING btree (status) WHERE (status IS NOT NULL);

CREATE INDEX idx_budget_items_transaction_auto_tag_id ON public.budget_items USING btree (transaction_auto_tag_id);

CREATE INDEX idx_budget_period_dates ON public.budget_period USING btree (start_date, end_date, id);

CREATE INDEX idx_budget_period_items_lookup ON public.budget_period_items USING btree (budget_item_id, budget_period_id);

CREATE INDEX idx_budget_period_items_period_id ON public.budget_period_items USING btree (budget_period_id);

CREATE INDEX idx_budget_period_tenant_start_date ON public.budget_period USING btree (tenant_id, start_date);

CREATE INDEX idx_budget_period_transactions_batch_id ON public.budget_period_transactions USING btree (batch_id);

CREATE INDEX idx_budget_period_transactions_budget_item ON public.budget_period_transactions USING btree (budget_item_id, tenant_id, budget_period_item_id) INCLUDE (type, transaction_type, amount);

CREATE INDEX idx_budget_period_transactions_created_at ON public.budget_period_transactions USING btree (created_at);

CREATE INDEX idx_budget_period_transactions_event_type ON public.budget_period_transactions USING btree (event_type);

CREATE INDEX idx_budget_period_transactions_item_id ON public.budget_period_transactions USING btree (budget_period_item_id);

CREATE INDEX idx_budget_period_transactions_related_id ON public.budget_period_transactions USING btree (related_transaction_id);

CREATE INDEX idx_budget_period_transactions_source_system ON public.budget_period_transactions USING btree (source_system);

CREATE INDEX idx_budget_period_transactions_type ON public.budget_period_transactions USING btree (transaction_type);

CREATE INDEX idx_budget_period_transactions_type_field ON public.budget_period_transactions USING btree (type);

CREATE INDEX idx_budget_period_transactions_user_id ON public.budget_period_transactions USING btree (user_id);

CREATE INDEX idx_budget_period_year_month ON public.budget_period USING btree (year, month_number);

CREATE INDEX idx_cost_basis_method_settings_security_id ON public.cost_basis_method_settings USING btree (security_id);

CREATE INDEX idx_deployment_users_created_by ON public.deployment_users USING btree (created_by);

CREATE INDEX idx_deployment_users_deployment_id ON public.deployment_users USING btree (deployment_id);

CREATE INDEX idx_dividend_records_account_security ON public.dividend_records USING btree (account_id, security_id, pay_date);

CREATE INDEX idx_dividend_records_event_id ON public.dividend_records USING btree (event_id);

CREATE INDEX idx_dividend_records_security_id ON public.dividend_records USING btree (security_id);

CREATE INDEX idx_fund_compositions_created_by_user_id ON public.fund_compositions USING btree (created_by_user_id);

CREATE INDEX idx_fund_compositions_security_snapshot ON public.fund_compositions USING btree (security_id, snapshot_date DESC);

CREATE INDEX idx_fund_underlying_holdings_security_snapshot ON public.fund_underlying_holdings USING btree (security_id, snapshot_date DESC);

CREATE INDEX idx_fund_underlying_holdings_underlying_security_id ON public.fund_underlying_holdings USING btree (underlying_security_id);

CREATE INDEX idx_goal_budget_items_budget_item_id ON public.goal_budget_items USING btree (budget_item_id);

CREATE INDEX idx_goal_budget_items_lookup ON public.goal_budget_items USING btree (goal_id, budget_item_id);

CREATE INDEX idx_holding_events_account_security ON public.holding_events USING btree (account_id, security_id, event_date);

CREATE INDEX idx_holding_events_adjusted_through_action ON public.holding_events USING btree (tenant_id, adjusted_through_action_id) WHERE (adjusted_through_action_id IS NOT NULL);

CREATE INDEX idx_holding_events_fee_type ON public.holding_events USING btree (tenant_id, fee_type) WHERE (fee_type IS NOT NULL);

CREATE INDEX idx_holding_events_reverses_event_id ON public.holding_events USING btree (reverses_event_id);

CREATE INDEX idx_holding_events_security_id ON public.holding_events USING btree (security_id);

CREATE INDEX idx_holding_events_type ON public.holding_events USING btree (tenant_id, event_type);

CREATE INDEX idx_holding_events_user_id ON public.holding_events USING btree (user_id);

CREATE INDEX idx_import_sync_log_account_id ON public.import_sync_log USING btree (account_id);

CREATE INDEX idx_import_sync_log_institution_id ON public.import_sync_log USING btree (institution_id);

CREATE INDEX idx_import_sync_log_tenant_id ON public.import_sync_log USING btree (tenant_id);

CREATE INDEX idx_login_throttles_last_attempt_at ON public.login_throttles USING btree (last_attempt_at);

CREATE INDEX idx_lot_consumptions_sell_event ON public.lot_consumptions USING btree (sell_event_id);

CREATE INDEX idx_lot_consumptions_tax_lot ON public.lot_consumptions USING btree (tax_lot_id);

CREATE INDEX idx_merchant_matching_rules_matching_text ON public.merchant_matching_rules USING btree (matching_text);

CREATE INDEX idx_merchant_matching_rules_merchant_id ON public.merchant_matching_rules USING btree (merchant_id);

CREATE INDEX idx_merchant_matching_rules_method ON public.merchant_matching_rules USING btree (method);

CREATE INDEX idx_merchant_matching_rules_tenant_id ON public.merchant_matching_rules USING btree (tenant_id);

CREATE INDEX idx_merchants_transaction_auto_tag_id ON public.merchants USING btree (transaction_auto_tag_id);

CREATE INDEX idx_net_worth_snapshots_date_level ON public.net_worth_snapshots USING btree (snapshot_date DESC, aggregation_level);

CREATE INDEX idx_net_worth_snapshots_level_date ON public.net_worth_snapshots USING btree (aggregation_level, snapshot_date DESC);

CREATE INDEX idx_net_worth_snapshots_trigger ON public.net_worth_snapshots USING btree (snapshot_trigger, snapshot_date DESC);

CREATE INDEX idx_notification_deliveries_user ON public.notification_deliveries USING btree (user_id);

CREATE INDEX idx_notification_preferences_user_id ON public.notification_preferences USING btree (user_id);

CREATE INDEX idx_notification_rule_sets_updated_by_user_id ON public.notification_rule_sets USING btree (updated_by_user_id);

CREATE INDEX idx_notifications_alert_tracking ON public.notifications USING btree (related_alert_tracking_id) WHERE (related_alert_tracking_id IS NOT NULL);

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at);

CREATE INDEX idx_notifications_pending ON public.notifications USING btree (scheduled_for, priority) WHERE ((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('processing'::character varying)::text]));

CREATE INDEX idx_notifications_related_budget_item_id ON public.notifications USING btree (related_budget_item_id);

CREATE INDEX idx_notifications_related_budget_period_id ON public.notifications USING btree (related_budget_period_id);

CREATE INDEX idx_notifications_sent_at ON public.notifications USING btree (sent_at) WHERE ((status)::text = ANY (ARRAY[('sent'::character varying)::text, ('delivered'::character varying)::text, ('bounced'::character varying)::text]));

CREATE INDEX idx_notifications_status ON public.notifications USING btree (status);

CREATE INDEX idx_notifications_tenant_id ON public.notifications USING btree (tenant_id);

CREATE INDEX idx_notifications_type ON public.notifications USING btree (notification_type);

CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id);

CREATE INDEX idx_onedrive_tokens_expires_at ON public.onedrive_tokens USING btree (expires_at);

CREATE INDEX idx_org_price_sync_runs_org_started ON public.organization_price_sync_runs USING btree (organization_id, started_at DESC);

CREATE INDEX idx_organization_invitations_accepted_by ON public.organization_invitations USING btree (accepted_by);

CREATE INDEX idx_organization_invitations_invited_by ON public.organization_invitations USING btree (invited_by);

CREATE INDEX idx_organization_invitations_organization_id ON public.organization_invitations USING btree (organization_id);

CREATE INDEX idx_organization_price_sync_runs_user_id ON public.organization_price_sync_runs USING btree (user_id);

CREATE INDEX idx_organization_price_sync_settings_created_by ON public.organization_price_sync_settings USING btree (created_by);

CREATE INDEX idx_organization_simplefin_connections_created_by ON public.organization_simplefin_connections USING btree (created_by);

CREATE INDEX idx_organization_users_created_by ON public.organization_users USING btree (created_by);

CREATE INDEX idx_organization_users_organization_id ON public.organization_users USING btree (organization_id);

CREATE INDEX idx_passkey_credentials_last_used ON public.passkey_credentials USING btree (user_id, last_used_at DESC);

CREATE INDEX idx_pat_user_active ON public.personal_access_tokens USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE INDEX idx_personal_access_tokens_tenant_id ON public.personal_access_tokens USING btree (tenant_id);

CREATE INDEX idx_push_subscriptions_user ON public.push_subscriptions USING btree (user_id);

CREATE INDEX idx_recurring_merchant_id ON public.recurring USING btree (merchant_id);

CREATE INDEX idx_recurring_tenant_id ON public.recurring USING btree (tenant_id);

CREATE INDEX idx_schema_migrations_applied_at ON public.schema_migrations USING btree (applied_at);

CREATE INDEX idx_securities_pass_through ON public.securities USING btree (tenant_id, is_pass_through) WHERE (is_pass_through = true);

CREATE INDEX idx_securities_tenant_active ON public.securities USING btree (tenant_id, is_active);

CREATE INDEX idx_security_corporate_actions_security ON public.security_corporate_actions USING btree (security_id, action_date);

CREATE INDEX idx_security_prices_user_id ON public.security_prices USING btree (user_id);

CREATE INDEX idx_sessions_active_lookup ON public.sessions USING btree (session_token_hash, is_revoked, expires_at);

CREATE INDEX idx_sessions_active_tenant_id ON public.sessions USING btree (active_tenant_id);

CREATE INDEX idx_sessions_expires_at ON public.sessions USING btree (expires_at);

CREATE INDEX idx_sessions_is_revoked ON public.sessions USING btree (is_revoked);

CREATE INDEX idx_sessions_rotated_from_session_id ON public.sessions USING btree (rotated_from_session_id);

CREATE INDEX idx_sessions_user_active ON public.sessions USING btree (user_id, is_revoked, expires_at) WHERE (is_revoked = false);

CREATE INDEX idx_sessions_user_id ON public.sessions USING btree (user_id);

CREATE UNIQUE INDEX idx_single_envelope_account ON public.accounts USING btree (tenant_id) WHERE (is_envelope_account = true);

CREATE INDEX idx_stored_images_tenant ON public.stored_images USING btree (tenant_id);

CREATE INDEX idx_system_settings_category_configurable ON public.system_settings USING btree (category, is_user_configurable);

CREATE INDEX idx_system_settings_type ON public.system_settings USING btree (setting_type);

CREATE INDEX idx_system_settings_user_configurable ON public.system_settings USING btree (is_user_configurable);

CREATE UNIQUE INDEX idx_taggings_one_tag_per_report_namespace ON public.taggings USING btree (taggable_type, taggable_id, report_root_id) WHERE ((report_root_id IS NOT NULL) AND ((taggable_type)::text = 'budget_item'::text));

CREATE INDEX idx_taggings_report_root_id ON public.taggings USING btree (report_root_id) WHERE (report_root_id IS NOT NULL);

CREATE INDEX idx_taggings_tag_id ON public.taggings USING btree (tag_id);

CREATE INDEX idx_taggings_taggable ON public.taggings USING btree (taggable_type, taggable_id);

CREATE INDEX idx_taggings_type ON public.taggings USING btree (type);

CREATE INDEX idx_taggings_user_id ON public.taggings USING btree (user_id);

CREATE INDEX idx_tags_is_active ON public.tags USING btree (is_active);

CREATE INDEX idx_tags_is_report_root ON public.tags USING btree (is_report_root) WHERE (is_report_root = true);

CREATE INDEX idx_tags_level ON public.tags USING btree (level);

CREATE INDEX idx_tags_name ON public.tags USING btree (name);

CREATE INDEX idx_tags_parent_id ON public.tags USING btree (parent_id);

CREATE INDEX idx_tags_sort_order ON public.tags USING btree (sort_order);

CREATE INDEX idx_tax_lots_account_security_open ON public.tax_lots USING btree (account_id, security_id, is_open);

CREATE INDEX idx_tax_lots_created_by_event ON public.tax_lots USING btree (created_by_event_id);

CREATE INDEX idx_tax_lots_data_quality ON public.tax_lots USING btree (tenant_id, data_quality) WHERE ((data_quality)::text <> 'complete'::text);

CREATE INDEX idx_tax_lots_parent_lot_id ON public.tax_lots USING btree (parent_lot_id);

CREATE INDEX idx_tax_lots_security_id ON public.tax_lots USING btree (security_id);

CREATE INDEX idx_tenant_settings_updated_by_user_id ON public.tenant_settings USING btree (updated_by_user_id);

CREATE INDEX idx_tenant_users_created_by ON public.tenant_users USING btree (created_by);

CREATE INDEX idx_tenant_users_tenant_id ON public.tenant_users USING btree (tenant_id);

CREATE INDEX idx_tenants_balance_adjustment_merchant ON public.tenants USING btree (balance_adjustment_merchant_id) WHERE (balance_adjustment_merchant_id IS NOT NULL);

CREATE INDEX idx_tenants_organization_id ON public.tenants USING btree (organization_id);

CREATE INDEX idx_transactions_account_date_status_amount ON public.transactions USING btree (account_id, transaction_date DESC, status) INCLUDE (amount, type, description);

CREATE INDEX idx_transactions_account_external_id ON public.transactions USING btree (account_id, external_transaction_id) WHERE (external_transaction_id IS NOT NULL);

CREATE INDEX idx_transactions_assigned_to ON public.transactions USING btree (assigned_to);

CREATE INDEX idx_transactions_assigned_to_status ON public.transactions USING btree (assigned_to, review_status) WHERE (assigned_to IS NOT NULL);

CREATE INDEX idx_transactions_budget_item ON public.transactions USING btree (budget_item_id);

CREATE INDEX idx_transactions_budget_item_date ON public.transactions USING btree (budget_item_id, transaction_date DESC) INCLUDE (amount, type, budget_period_id, tenant_id) WHERE (budget_item_id IS NOT NULL);

CREATE INDEX idx_transactions_budget_matching_method ON public.transactions USING btree (budget_matching_method);

CREATE INDEX idx_transactions_budget_matching_rule ON public.transactions USING btree (budget_matching_rule_id);

CREATE INDEX idx_transactions_budget_period_budget_item ON public.transactions USING btree (budget_period_id, budget_item_id);

CREATE INDEX idx_transactions_budget_period_item ON public.transactions USING btree (budget_period_item_id);

CREATE INDEX idx_transactions_date ON public.transactions USING btree (transaction_date);

CREATE INDEX idx_transactions_import_id ON public.transactions USING btree (import_transaction_id) WHERE (import_transaction_id IS NOT NULL);

CREATE INDEX idx_transactions_is_split_parent ON public.transactions USING btree (is_split_parent) WHERE (is_split_parent = true);

CREATE INDEX idx_transactions_list_order ON public.transactions USING btree (tenant_id, transaction_date DESC, created_at DESC, id DESC) INCLUDE (review_status, assigned_to) WHERE (parent_transaction_id IS NULL);

CREATE INDEX idx_transactions_merchant ON public.transactions USING btree (merchant_id);

CREATE INDEX idx_transactions_merchant_date ON public.transactions USING btree (merchant_id, transaction_date DESC) WHERE (merchant_id IS NOT NULL);

CREATE INDEX idx_transactions_parent_id ON public.transactions USING btree (parent_transaction_id) WHERE (parent_transaction_id IS NOT NULL);

CREATE INDEX idx_transactions_review_status_date ON public.transactions USING btree (review_status, transaction_date DESC) WHERE ((review_status)::text = ANY (ARRAY[('flagged'::character varying)::text, ('needs review'::character varying)::text]));

CREATE INDEX idx_transactions_transfer_source_account_id ON public.transactions USING btree (transfer_source_account_id) WHERE (transfer_source_account_id IS NOT NULL);

CREATE INDEX idx_transactions_transfer_transaction_id ON public.transactions USING btree (transfer_transaction_id) WHERE (transfer_transaction_id IS NOT NULL);

CREATE INDEX idx_transactions_type_date ON public.transactions USING btree (type, transaction_date DESC);

CREATE INDEX idx_users_last_tenant_id ON public.users USING btree (last_tenant_id);

CREATE INDEX idx_wash_sale_records_consumption ON public.wash_sale_records USING btree (loss_lot_consumption_id);

CREATE INDEX idx_wash_sale_records_replacement_lot_id ON public.wash_sale_records USING btree (replacement_lot_id);

CREATE INDEX idx_webauthn_challenges_browser_hash ON public.webauthn_challenges USING btree (browser_hash, purpose);

CREATE INDEX idx_webauthn_challenges_expires_at ON public.webauthn_challenges USING btree (expires_at);

CREATE INDEX idx_webauthn_challenges_user_id ON public.webauthn_challenges USING btree (user_id);

CREATE UNIQUE INDEX organization_invitations_open_key ON public.organization_invitations USING btree (organization_id, email) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));

CREATE UNIQUE INDEX unique_budget_period_item_alert ON public.budget_alert_tracking USING btree (tenant_id, user_id, budget_period_item_id) WHERE (resolved = false);

CREATE UNIQUE INDEX uq_categories_tenant_name_key ON public.categories USING btree (tenant_id, name_key);

CREATE UNIQUE INDEX uq_holding_events_external_ref ON public.holding_events USING btree (account_id, security_id, external_reference) WHERE (external_reference IS NOT NULL);

CREATE UNIQUE INDEX uq_merchants_tenant_lower_name ON public.merchants USING btree (tenant_id, lower((name)::text));

CREATE UNIQUE INDEX uq_tax_lots_external_ref ON public.tax_lots USING btree (account_id, security_id, external_reference) WHERE (external_reference IS NOT NULL);

CREATE UNIQUE INDEX uq_transactions_account_import_id ON public.transactions USING btree (account_id, import_transaction_id) WHERE ((import_transaction_id IS NOT NULL) AND (parent_transaction_id IS NULL));

CREATE TRIGGER generate_attachment_safe_filename BEFORE INSERT OR UPDATE ON public.attachments FOR EACH ROW EXECUTE FUNCTION public.generate_safe_filename();

CREATE TRIGGER set_annotations_root_id BEFORE INSERT OR UPDATE OF parent_id ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.set_annotation_root_id();

CREATE TRIGGER trg_annotations_lock_subject_on_update AFTER UPDATE OF subject_type, subject_id ON public.annotations FOR EACH ROW WHEN (((old.subject_type IS DISTINCT FROM new.subject_type) OR (old.subject_id IS DISTINCT FROM new.subject_id))) EXECUTE FUNCTION public.lock_referenced_subject_on_update('subject_type', 'subject_id');

CREATE TRIGGER trg_annotations_lock_subjects AFTER INSERT ON public.annotations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.lock_referenced_subjects('subject_type', 'subject_id');

CREATE TRIGGER trg_annotations_lock_transactions AFTER INSERT ON public.annotations REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.lock_referenced_transactions('subject_type', 'subject_id');

CREATE TRIGGER trg_calculate_descendant_tag_levels AFTER UPDATE OF parent_id ON public.tags FOR EACH ROW WHEN ((old.parent_id IS DISTINCT FROM new.parent_id)) EXECUTE FUNCTION public.calculate_descendant_tag_levels();

CREATE TRIGGER trg_calculate_inserted_tag_levels AFTER INSERT ON public.tags FOR EACH ROW WHEN ((new.parent_id IS NOT NULL)) EXECUTE FUNCTION public.calculate_descendant_tag_levels();

CREATE TRIGGER trg_calculate_tag_level BEFORE INSERT OR UPDATE OF parent_id ON public.tags FOR EACH ROW EXECUTE FUNCTION public.calculate_tag_level();

CREATE TRIGGER trg_fund_compositions_stamp_freshness AFTER INSERT OR UPDATE ON public.fund_compositions FOR EACH ROW EXECUTE FUNCTION public.stamp_security_last_composition_update();

CREATE TRIGGER trg_refresh_taggings_on_tag_move AFTER UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.refresh_descendant_taggings_on_tag_move();

CREATE TRIGGER trg_security_prices_stamp_freshness AFTER INSERT OR UPDATE ON public.security_prices FOR EACH ROW EXECUTE FUNCTION public.stamp_security_last_price_update();

CREATE TRIGGER trg_taggings_lock_subject_on_update AFTER UPDATE OF taggable_type, taggable_id ON public.taggings FOR EACH ROW WHEN ((((old.taggable_type)::text IS DISTINCT FROM (new.taggable_type)::text) OR (old.taggable_id IS DISTINCT FROM new.taggable_id))) EXECUTE FUNCTION public.lock_referenced_subject_on_update('taggable_type', 'taggable_id');

CREATE TRIGGER trg_taggings_lock_subjects AFTER INSERT ON public.taggings REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.lock_referenced_subjects('taggable_type', 'taggable_id');

CREATE TRIGGER trg_taggings_lock_transactions AFTER INSERT ON public.taggings REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.lock_referenced_transactions('taggable_type', 'taggable_id');

CREATE TRIGGER trg_taggings_report_root BEFORE INSERT OR UPDATE OF tag_id ON public.taggings FOR EACH ROW EXECUTE FUNCTION public.populate_taggings_report_root();

CREATE TRIGGER trg_transaction_auto_tag AFTER INSERT OR UPDATE OF budget_item_id, merchant_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.trigger_transaction_auto_tag();

CREATE TRIGGER trg_update_tag_last_used AFTER INSERT ON public.taggings REFERENCING NEW TABLE AS inserted_taggings FOR EACH STATEMENT EXECUTE FUNCTION public.update_tag_last_used();

CREATE TRIGGER trg_update_tag_timestamp BEFORE UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION public.update_tag_timestamp();

CREATE TRIGGER trigger_accounts_account_group_known BEFORE INSERT OR UPDATE OF account_group ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('account_group', 'cash', 'credit cards', 'credit_cards', 'investments', 'loans', 'other');

CREATE TRIGGER trigger_accounts_account_type_known BEFORE INSERT OR UPDATE OF account_type ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('account_type', 'checking', 'savings', 'cash', 'investment', 'business', 'credit_card', 'loan', 'mortgage', 'line_of_credit', 'other');

CREATE TRIGGER trigger_accounts_delete_references AFTER DELETE ON public.accounts REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('account');

CREATE TRIGGER trigger_accounts_hidden_range_insert AFTER INSERT ON public.accounts FOR EACH ROW WHEN (new.hide_account) EXECUTE FUNCTION public.record_account_hidden_range();

CREATE TRIGGER trigger_accounts_hidden_range_update AFTER UPDATE OF hide_account ON public.accounts FOR EACH ROW WHEN ((old.hide_account IS DISTINCT FROM new.hide_account)) EXECUTE FUNCTION public.record_account_hidden_range();

CREATE TRIGGER trigger_accounts_type_known BEFORE INSERT OR UPDATE OF type ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('type', 'Asset', 'Liability');

CREATE TRIGGER trigger_accounts_wait_for_day_range_change BEFORE INSERT ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.wait_for_day_range_change();

CREATE TRIGGER trigger_annotations_author_kind_known BEFORE INSERT OR UPDATE OF author_kind ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('author_kind', 'agent', 'user', 'system');

CREATE TRIGGER trigger_annotations_feedback_known BEFORE INSERT OR UPDATE OF feedback ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('feedback', 'correct', 'incorrect');

CREATE TRIGGER trigger_annotations_kind_known BEFORE INSERT OR UPDATE OF kind ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('kind', 'reasoning', 'question', 'answer', 'observation', 'decision', 'flag', 'correction', 'note');

CREATE TRIGGER trigger_annotations_learning_status_known BEFORE INSERT OR UPDATE OF learning_status ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('learning_status', 'pending', 'applied', 'ignored');

CREATE TRIGGER trigger_annotations_severity_known BEFORE INSERT OR UPDATE OF severity ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('severity', 'info', 'question', 'warning', 'action_required');

CREATE TRIGGER trigger_annotations_status_known BEFORE INSERT OR UPDATE OF status ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('status', 'open', 'answered', 'resolved', 'dismissed', 'acknowledged');

CREATE TRIGGER trigger_annotations_subject_type_known BEFORE INSERT OR UPDATE OF subject_type ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('subject_type', 'transaction', 'account', 'merchant', 'security', 'budget_item', 'budget_period_item', 'category', 'tag');

CREATE TRIGGER trigger_budget_items_delete_references AFTER DELETE ON public.budget_items REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('budget_item');

CREATE TRIGGER trigger_budget_items_expense_type_known BEFORE INSERT OR UPDATE OF expense_type ON public.budget_items FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('expense_type', 'Expense', 'Income', 'Savings', 'Transfer', 'Transfer: Payment');

CREATE TRIGGER trigger_budget_items_goal_waits_for_day_range_change BEFORE UPDATE OF expense_type, type ON public.budget_items FOR EACH ROW WHEN ((((new.expense_type)::text = 'Savings'::text) AND ((new.type)::text = 'Goal'::text) AND (((old.expense_type)::text IS DISTINCT FROM 'Savings'::text) OR ((old.type)::text IS DISTINCT FROM 'Goal'::text)))) EXECUTE FUNCTION public.goal_waits_for_day_range_change();

CREATE TRIGGER trigger_budget_items_priority_known BEFORE INSERT OR UPDATE OF priority ON public.budget_items FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('priority', 'Essential', 'Optional');

CREATE TRIGGER trigger_budget_items_wait_for_day_range_change BEFORE INSERT ON public.budget_items FOR EACH ROW EXECUTE FUNCTION public.wait_for_day_range_change();

CREATE TRIGGER trigger_budget_period_items_delete_references AFTER DELETE ON public.budget_period_items REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('budget_period_item');

CREATE TRIGGER trigger_categories_delete_references AFTER DELETE ON public.categories REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('category');

CREATE TRIGGER trigger_check_account_simplefin_connection BEFORE INSERT OR UPDATE OF simplefin_connection_id, tenant_id ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.check_account_simplefin_connection();

CREATE TRIGGER trigger_check_transaction_type_for_account BEFORE INSERT OR UPDATE OF type, account_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.check_transaction_type_for_account();

CREATE TRIGGER trigger_maintain_budget_period_consistency BEFORE INSERT OR UPDATE OF budget_item_id, budget_period_id, budget_period_item_id, is_split_parent ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.maintain_transaction_budget_period_consistency();

CREATE TRIGGER trigger_merchants_delete_references AFTER DELETE ON public.merchants REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('merchant');

CREATE TRIGGER trigger_notifications_status_known BEFORE INSERT OR UPDATE OF status ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('status', 'pending', 'processing', 'sent', 'failed', 'delivered', 'bounced');

CREATE TRIGGER trigger_securities_delete_references AFTER DELETE ON public.securities REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('security');

CREATE TRIGGER trigger_taggings_taggable_type_known BEFORE INSERT OR UPDATE OF taggable_type ON public.taggings FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('taggable_type', 'transaction', 'budget_item');

CREATE TRIGGER trigger_taggings_type_known BEFORE INSERT OR UPDATE OF type ON public.taggings FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('type', 'manual', 'auto');

CREATE TRIGGER trigger_tags_delete_references AFTER DELETE ON public.tags REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('tag');

CREATE TRIGGER trigger_transactions_budget_matching_method_known BEFORE INSERT OR UPDATE OF budget_matching_method ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('budget_matching_method', 'none', 'merchant-rule', 'description-rule', 'merchant-history', 'description-similarity', 'error');

CREATE TRIGGER trigger_transactions_delete_references AFTER DELETE ON public.transactions REFERENCING OLD TABLE AS deleted_rows FOR EACH STATEMENT EXECUTE FUNCTION public.delete_polymorphic_references('transaction');

CREATE TRIGGER trigger_transactions_income_sign BEFORE INSERT OR UPDATE OF type, amount, parent_transaction_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.check_transaction_income_sign();

CREATE TRIGGER trigger_transactions_remember_cleared_period BEFORE UPDATE OF budget_period_id ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.remember_cleared_budget_period();

CREATE TRIGGER trigger_transactions_review_status_known BEFORE INSERT OR UPDATE OF review_status ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('review_status', 'needs review', 'reviewed', 'flagged');

CREATE CONSTRAINT TRIGGER trigger_transactions_splits_and_transfers_delete AFTER DELETE ON public.transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.parent_transaction_id IS NOT NULL) OR (old.transfer_transaction_id IS NOT NULL))) EXECUTE FUNCTION public.check_transaction_splits_and_transfers();

CREATE CONSTRAINT TRIGGER trigger_transactions_splits_and_transfers_insert AFTER INSERT ON public.transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.parent_transaction_id IS NOT NULL) OR new.is_split_parent OR (new.transfer_transaction_id IS NOT NULL))) EXECUTE FUNCTION public.check_transaction_splits_and_transfers();

CREATE CONSTRAINT TRIGGER trigger_transactions_splits_and_transfers_update AFTER UPDATE ON public.transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((((old.amount IS DISTINCT FROM new.amount) AND ((new.parent_transaction_id IS NOT NULL) OR new.is_split_parent OR (new.transfer_transaction_id IS NOT NULL))) OR (old.parent_transaction_id IS DISTINCT FROM new.parent_transaction_id) OR (old.is_split_parent IS DISTINCT FROM new.is_split_parent) OR (old.transfer_transaction_id IS DISTINCT FROM new.transfer_transaction_id))) EXECUTE FUNCTION public.check_transaction_splits_and_transfers();

CREATE TRIGGER trigger_transactions_status_known BEFORE INSERT OR UPDATE OF status ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('status', 'pending', 'cleared', 'reconciled');

CREATE TRIGGER trigger_transactions_type_known BEFORE INSERT OR UPDATE OF type ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.check_known_or_unchanged('type', 'income', 'expense', 'payment', 'transfer', 'starting balance', 'balance adjustment');

CREATE TRIGGER update_account_currencies_updated_at BEFORE UPDATE ON public.account_currencies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_annotations_updated_at BEFORE UPDATE ON public.annotations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_attachments_updated_at BEFORE UPDATE ON public.attachments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_bill_occurrences_updated_at BEFORE UPDATE ON public.bill_occurrences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_budget_alert_tracking_updated_at BEFORE UPDATE ON public.budget_alert_tracking FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_budget_item_matching_rules_updated_at BEFORE UPDATE ON public.budget_item_matching_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_budget_item_usage_history_updated_at BEFORE UPDATE ON public.budget_item_usage_history FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_budget_items_updated_at BEFORE UPDATE ON public.budget_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_budget_period_items_updated_at BEFORE UPDATE ON public.budget_period_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_budget_period_updated_at BEFORE UPDATE ON public.budget_period FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_cost_basis_method_settings_updated_at BEFORE UPDATE ON public.cost_basis_method_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_data_freshness_thresholds_updated_at BEFORE UPDATE ON public.data_freshness_thresholds FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_deployment_updated_at BEFORE UPDATE ON public.deployment FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_deployment_users_updated_at BEFORE UPDATE ON public.deployment_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_dividend_records_updated_at BEFORE UPDATE ON public.dividend_records FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_fund_compositions_updated_at BEFORE UPDATE ON public.fund_compositions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_fund_underlying_holdings_updated_at BEFORE UPDATE ON public.fund_underlying_holdings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_holding_events_updated_at BEFORE UPDATE ON public.holding_events FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_lot_consumptions_updated_at BEFORE UPDATE ON public.lot_consumptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_merchant_matching_rules_updated_at BEFORE UPDATE ON public.merchant_matching_rules FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_merchants_updated_at BEFORE UPDATE ON public.merchants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_net_worth_snapshots_updated_at BEFORE UPDATE ON public.net_worth_snapshots FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notification_preferences_updated_at BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notification_rule_sets_updated_at BEFORE UPDATE ON public.notification_rule_sets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notifications_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_onedrive_tokens_updated_at BEFORE UPDATE ON public.onedrive_tokens FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_organization_price_sync_runs_updated_at BEFORE UPDATE ON public.organization_price_sync_runs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_organization_price_sync_settings_updated_at BEFORE UPDATE ON public.organization_price_sync_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_organization_simplefin_connections_updated_at BEFORE UPDATE ON public.organization_simplefin_connections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_organization_users_updated_at BEFORE UPDATE ON public.organization_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_passkey_credentials_updated_at BEFORE UPDATE ON public.passkey_credentials FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_portfolio_value_snapshots_updated_at BEFORE UPDATE ON public.portfolio_value_snapshots FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_push_subscriptions_updated_at BEFORE UPDATE ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_recurring_updated_at BEFORE UPDATE ON public.recurring FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_securities_updated_at BEFORE UPDATE ON public.securities FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_security_corporate_actions_updated_at BEFORE UPDATE ON public.security_corporate_actions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_security_prices_updated_at BEFORE UPDATE ON public.security_prices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_stored_images_updated_at BEFORE UPDATE ON public.stored_images FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_system_settings_updated_at BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_tax_lots_updated_at BEFORE UPDATE ON public.tax_lots FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_tenant_settings_updated_at BEFORE UPDATE ON public.tenant_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_tenant_users_updated_at BEFORE UPDATE ON public.tenant_users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON public.tenants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_user_profile_images_updated_at BEFORE UPDATE ON public.user_profile_images FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_wash_sale_records_updated_at BEFORE UPDATE ON public.wash_sale_records FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE ONLY public.account_currencies
    ADD CONSTRAINT account_currencies_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.account_currencies
    ADD CONSTRAINT account_currencies_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.account_hidden_ranges
    ADD CONSTRAINT account_hidden_ranges_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.account_hidden_ranges
    ADD CONSTRAINT account_hidden_ranges_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.account_imported_balance_history
    ADD CONSTRAINT account_imported_balance_history_account_currency_id_fkey FOREIGN KEY (tenant_id, account_currency_id) REFERENCES public.account_currencies(tenant_id, id);

ALTER TABLE ONLY public.account_imported_balance_history
    ADD CONSTRAINT account_imported_balance_history_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.account_imported_balance_history
    ADD CONSTRAINT account_imported_balance_history_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.account_institutions
    ADD CONSTRAINT account_institutions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_default_pay_from_account_id_fkey FOREIGN KEY (tenant_id, default_pay_from_account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE SET NULL (default_pay_from_account_id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_import_default_assigned_to_fkey FOREIGN KEY (import_default_assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_institution_id_fkey FOREIGN KEY (tenant_id, institution_id) REFERENCES public.account_institutions(tenant_id, id) ON DELETE SET NULL (institution_id);

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_simplefin_connection_id_fkey FOREIGN KEY (simplefin_connection_id) REFERENCES public.organization_simplefin_connections(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.annotations
    ADD CONSTRAINT annotations_parent_id_fkey FOREIGN KEY (tenant_id, parent_id) REFERENCES public.annotations(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_holding_event_id_fkey FOREIGN KEY (tenant_id, holding_event_id) REFERENCES public.holding_events(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_transaction_id_fkey FOREIGN KEY (tenant_id, transaction_id) REFERENCES public.transactions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_bill_occurrence_id_fkey FOREIGN KEY (tenant_id, bill_occurrence_id) REFERENCES public.bill_occurrences(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_occurrence_transactions
    ADD CONSTRAINT bill_occurrence_transactions_transaction_id_fkey FOREIGN KEY (tenant_id, transaction_id) REFERENCES public.transactions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.bill_occurrences
    ADD CONSTRAINT bill_occurrences_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_budget_period_id_fkey FOREIGN KEY (tenant_id, budget_period_id) REFERENCES public.budget_period(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_budget_period_item_id_fkey FOREIGN KEY (tenant_id, budget_period_item_id) REFERENCES public.budget_period_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_alert_tracking
    ADD CONSTRAINT budget_alert_tracking_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_accounts
    ADD CONSTRAINT budget_item_accounts_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_accounts
    ADD CONSTRAINT budget_item_accounts_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_accounts
    ADD CONSTRAINT budget_item_accounts_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_item_matching_rules
    ADD CONSTRAINT budget_item_matching_rules_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_matching_rules
    ADD CONSTRAINT budget_item_matching_rules_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_matching_rules
    ADD CONSTRAINT budget_item_matching_rules_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_item_usage_history
    ADD CONSTRAINT budget_item_usage_history_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_usage_history
    ADD CONSTRAINT budget_item_usage_history_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_item_usage_history
    ADD CONSTRAINT budget_item_usage_history_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT budget_items_category_id_fkey FOREIGN KEY (tenant_id, category_id) REFERENCES public.categories(tenant_id, id) ON DELETE SET NULL (category_id);

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT budget_items_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE SET NULL (merchant_id);

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT budget_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_budget_period_id_fkey FOREIGN KEY (tenant_id, budget_period_id) REFERENCES public.budget_period(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_period_items
    ADD CONSTRAINT budget_period_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_period
    ADD CONSTRAINT budget_period_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_budget_period_item_id_fkey FOREIGN KEY (tenant_id, budget_period_item_id) REFERENCES public.budget_period_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_related_transaction_id_fkey FOREIGN KEY (tenant_id, related_transaction_id) REFERENCES public.budget_period_transactions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.budget_period_transactions
    ADD CONSTRAINT budget_period_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.cost_basis_method_settings
    ADD CONSTRAINT cost_basis_method_settings_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.cost_basis_method_settings
    ADD CONSTRAINT cost_basis_method_settings_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.data_freshness_thresholds
    ADD CONSTRAINT data_freshness_thresholds_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deployment_users
    ADD CONSTRAINT deployment_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.deployment_users
    ADD CONSTRAINT deployment_users_deployment_id_fkey FOREIGN KEY (deployment_id) REFERENCES public.deployment(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.deployment_users
    ADD CONSTRAINT deployment_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dividend_records
    ADD CONSTRAINT dividend_records_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dividend_records
    ADD CONSTRAINT dividend_records_event_id_fkey FOREIGN KEY (tenant_id, event_id) REFERENCES public.holding_events(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.dividend_records
    ADD CONSTRAINT dividend_records_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.budget_items
    ADD CONSTRAINT fk_budget_items_transaction_auto_tag FOREIGN KEY (tenant_id, transaction_auto_tag_id) REFERENCES public.tags(tenant_id, id) ON DELETE SET NULL (transaction_auto_tag_id);

ALTER TABLE ONLY public.merchants
    ADD CONSTRAINT fk_merchants_transaction_auto_tag FOREIGN KEY (tenant_id, transaction_auto_tag_id) REFERENCES public.tags(tenant_id, id) ON DELETE SET NULL (transaction_auto_tag_id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT fk_notifications_alert_tracking FOREIGN KEY (tenant_id, related_alert_tracking_id) REFERENCES public.budget_alert_tracking(tenant_id, id) ON DELETE SET NULL (related_alert_tracking_id);

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT fk_taggings_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT fk_transactions_budget_matching_rule FOREIGN KEY (tenant_id, budget_matching_rule_id) REFERENCES public.budget_item_matching_rules(tenant_id, id) ON DELETE SET NULL (budget_matching_rule_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT fk_transfer_source_account FOREIGN KEY (tenant_id, transfer_source_account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE SET NULL (transfer_source_account_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT fk_transfer_transaction FOREIGN KEY (tenant_id, transfer_transaction_id) REFERENCES public.transactions(tenant_id, id) ON DELETE SET NULL (transfer_transaction_id);

ALTER TABLE ONLY public.fund_compositions
    ADD CONSTRAINT fund_compositions_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.fund_compositions
    ADD CONSTRAINT fund_compositions_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fund_underlying_holdings
    ADD CONSTRAINT fund_underlying_holdings_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.fund_underlying_holdings
    ADD CONSTRAINT fund_underlying_holdings_underlying_security_id_fkey FOREIGN KEY (tenant_id, underlying_security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goal_budget_items
    ADD CONSTRAINT goal_budget_items_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goal_budget_items
    ADD CONSTRAINT goal_budget_items_goal_id_fkey FOREIGN KEY (tenant_id, goal_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goal_budget_items
    ADD CONSTRAINT goal_budget_items_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_adjusted_through_action_id_fkey FOREIGN KEY (tenant_id, adjusted_through_action_id) REFERENCES public.security_corporate_actions(tenant_id, id);

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_reverses_event_id_fkey FOREIGN KEY (tenant_id, reverses_event_id) REFERENCES public.holding_events(tenant_id, id) ON DELETE SET NULL (reverses_event_id);

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.holding_events
    ADD CONSTRAINT holding_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.import_sync_log
    ADD CONSTRAINT import_sync_log_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE SET NULL (account_id);

ALTER TABLE ONLY public.import_sync_log
    ADD CONSTRAINT import_sync_log_institution_id_fkey FOREIGN KEY (tenant_id, institution_id) REFERENCES public.account_institutions(tenant_id, id) ON DELETE SET NULL (institution_id);

ALTER TABLE ONLY public.import_sync_log
    ADD CONSTRAINT import_sync_log_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_sell_event_id_fkey FOREIGN KEY (tenant_id, sell_event_id) REFERENCES public.holding_events(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.lot_consumptions
    ADD CONSTRAINT lot_consumptions_tax_lot_id_fkey FOREIGN KEY (tenant_id, tax_lot_id) REFERENCES public.tax_lots(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.merchant_matching_rules
    ADD CONSTRAINT merchant_matching_rules_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.merchant_matching_rules
    ADD CONSTRAINT merchant_matching_rules_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.merchants
    ADD CONSTRAINT merchants_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.net_worth_snapshots
    ADD CONSTRAINT net_worth_snapshots_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_rule_sets
    ADD CONSTRAINT notification_rule_sets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notification_rule_sets
    ADD CONSTRAINT notification_rule_sets_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_related_budget_item_id_fkey FOREIGN KEY (tenant_id, related_budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE SET NULL (related_budget_item_id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_related_budget_period_id_fkey FOREIGN KEY (tenant_id, related_budget_period_id) REFERENCES public.budget_period(tenant_id, id) ON DELETE SET NULL (related_budget_period_id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.onedrive_tokens
    ADD CONSTRAINT onedrive_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT organization_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT organization_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.organization_invitations
    ADD CONSTRAINT organization_invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.organization_price_sync_runs
    ADD CONSTRAINT organization_price_sync_runs_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.organization_price_sync_runs
    ADD CONSTRAINT organization_price_sync_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.organization_price_sync_settings
    ADD CONSTRAINT organization_price_sync_settings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.organization_price_sync_settings
    ADD CONSTRAINT organization_price_sync_settings_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.organization_simplefin_connections
    ADD CONSTRAINT organization_simplefin_connections_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.organization_simplefin_connections
    ADD CONSTRAINT organization_simplefin_connections_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.organization_users
    ADD CONSTRAINT organization_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.passkey_credentials
    ADD CONSTRAINT passkey_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.personal_access_tokens
    ADD CONSTRAINT personal_access_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.recurring
    ADD CONSTRAINT recurring_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.recurring
    ADD CONSTRAINT recurring_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.security_corporate_actions
    ADD CONSTRAINT security_corporate_actions_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.security_prices
    ADD CONSTRAINT security_prices_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.security_prices
    ADD CONSTRAINT security_prices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_active_tenant_id_fkey FOREIGN KEY (active_tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_rotated_from_session_id_fkey FOREIGN KEY (rotated_from_session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.stored_images
    ADD CONSTRAINT stored_images_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_report_root_id_fkey FOREIGN KEY (tenant_id, report_root_id) REFERENCES public.tags(tenant_id, id);

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_tag_id_fkey FOREIGN KEY (tenant_id, tag_id) REFERENCES public.tags(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.taggings
    ADD CONSTRAINT taggings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_parent_id_fkey FOREIGN KEY (tenant_id, parent_id) REFERENCES public.tags(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_created_by_event_id_fkey FOREIGN KEY (tenant_id, created_by_event_id) REFERENCES public.holding_events(tenant_id, id);

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_parent_lot_id_fkey FOREIGN KEY (tenant_id, parent_lot_id) REFERENCES public.tax_lots(tenant_id, id) ON DELETE SET NULL (parent_lot_id);

ALTER TABLE ONLY public.tax_lots
    ADD CONSTRAINT tax_lots_security_id_fkey FOREIGN KEY (tenant_id, security_id) REFERENCES public.securities(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.tenant_settings
    ADD CONSTRAINT tenant_settings_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenant_users
    ADD CONSTRAINT tenant_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_balance_adjustment_merchant_id_fkey FOREIGN KEY (id, balance_adjustment_merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE SET NULL (balance_adjustment_merchant_id);

ALTER TABLE ONLY public.tenants
    ADD CONSTRAINT tenants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organizations(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_account_id_fkey FOREIGN KEY (tenant_id, account_id) REFERENCES public.accounts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_budget_item_id_fkey FOREIGN KEY (tenant_id, budget_item_id) REFERENCES public.budget_items(tenant_id, id) ON DELETE SET NULL (budget_item_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_budget_period_id_fkey FOREIGN KEY (tenant_id, budget_period_id) REFERENCES public.budget_period(tenant_id, id) ON DELETE SET NULL (budget_period_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_budget_period_item_id_fkey FOREIGN KEY (tenant_id, budget_period_item_id) REFERENCES public.budget_period_items(tenant_id, id) ON DELETE SET NULL (budget_period_item_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_merchant_id_fkey FOREIGN KEY (tenant_id, merchant_id) REFERENCES public.merchants(tenant_id, id) ON DELETE SET NULL (merchant_id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_parent_transaction_id_fkey FOREIGN KEY (tenant_id, parent_transaction_id) REFERENCES public.transactions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_tenant_fk FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);

ALTER TABLE ONLY public.user_profile_images
    ADD CONSTRAINT user_profile_images_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_last_tenant_id_fkey FOREIGN KEY (last_tenant_id) REFERENCES public.tenants(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.wash_sale_records
    ADD CONSTRAINT wash_sale_records_loss_lot_consumption_id_fkey FOREIGN KEY (tenant_id, loss_lot_consumption_id) REFERENCES public.lot_consumptions(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.wash_sale_records
    ADD CONSTRAINT wash_sale_records_replacement_lot_id_fkey FOREIGN KEY (tenant_id, replacement_lot_id) REFERENCES public.tax_lots(tenant_id, id) ON DELETE SET NULL (replacement_lot_id);

ALTER TABLE ONLY public.webauthn_challenges
    ADD CONSTRAINT webauthn_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE public.account_currencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_currencies_tenant_isolation ON public.account_currencies USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.account_hidden_ranges ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_hidden_ranges_tenant_isolation ON public.account_hidden_ranges USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.account_imported_balance_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_imported_balance_history_tenant_isolation ON public.account_imported_balance_history USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.account_institutions ENABLE ROW LEVEL SECURITY;

CREATE POLICY account_institutions_tenant_isolation ON public.account_institutions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY accounts_tenant_isolation ON public.accounts USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.annotations ENABLE ROW LEVEL SECURITY;

CREATE POLICY annotations_tenant_isolation ON public.annotations USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY attachments_tenant_isolation ON public.attachments USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.bill_occurrence_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bill_occurrence_transactions_tenant_isolation ON public.bill_occurrence_transactions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.bill_occurrences ENABLE ROW LEVEL SECURITY;

CREATE POLICY bill_occurrences_tenant_isolation ON public.bill_occurrences USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_alert_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_alert_tracking_tenant_isolation ON public.budget_alert_tracking USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_item_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_item_accounts_tenant_isolation ON public.budget_item_accounts USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_item_matching_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_item_matching_rules_tenant_isolation ON public.budget_item_matching_rules USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_item_usage_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_item_usage_history_tenant_isolation ON public.budget_item_usage_history USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_items_tenant_isolation ON public.budget_items USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_period ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.budget_period_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_period_items_tenant_isolation ON public.budget_period_items USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

CREATE POLICY budget_period_tenant_isolation ON public.budget_period USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.budget_period_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY budget_period_transactions_tenant_isolation ON public.budget_period_transactions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY categories_tenant_isolation ON public.categories USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.cost_basis_method_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY cost_basis_method_settings_tenant_isolation ON public.cost_basis_method_settings USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.data_freshness_thresholds ENABLE ROW LEVEL SECURITY;

CREATE POLICY data_freshness_thresholds_tenant_isolation ON public.data_freshness_thresholds USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.dividend_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY dividend_records_tenant_isolation ON public.dividend_records USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.fund_compositions ENABLE ROW LEVEL SECURITY;

CREATE POLICY fund_compositions_tenant_isolation ON public.fund_compositions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.fund_underlying_holdings ENABLE ROW LEVEL SECURITY;

CREATE POLICY fund_underlying_holdings_tenant_isolation ON public.fund_underlying_holdings USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.goal_budget_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY goal_budget_items_tenant_isolation ON public.goal_budget_items USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.holding_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY holding_events_tenant_isolation ON public.holding_events USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.import_sync_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY import_sync_log_tenant_isolation ON public.import_sync_log USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.lot_consumptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY lot_consumptions_tenant_isolation ON public.lot_consumptions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.merchant_matching_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY merchant_matching_rules_tenant_isolation ON public.merchant_matching_rules USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;

CREATE POLICY merchants_tenant_isolation ON public.merchants USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.net_worth_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY net_worth_snapshots_tenant_isolation ON public.net_worth_snapshots USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_deliveries_tenant_isolation ON public.notification_deliveries USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_tenant_isolation ON public.notification_preferences USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.notification_rule_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_rule_sets_tenant_isolation ON public.notification_rule_sets USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant_isolation ON public.notifications USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.organization_price_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_price_sync_runs_organization_isolation ON public.organization_price_sync_runs USING ((organization_id = public.current_organization_id())) WITH CHECK ((organization_id = public.current_organization_id()));

ALTER TABLE public.organization_price_sync_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_price_sync_settings_organization_isolation ON public.organization_price_sync_settings USING ((organization_id = public.current_organization_id())) WITH CHECK ((organization_id = public.current_organization_id()));

ALTER TABLE public.organization_simplefin_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY organization_simplefin_connections_organization_isolation ON public.organization_simplefin_connections USING ((organization_id = public.current_organization_id())) WITH CHECK ((organization_id = public.current_organization_id()));

ALTER TABLE public.portfolio_value_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY portfolio_value_snapshots_tenant_isolation ON public.portfolio_value_snapshots USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.recurring ENABLE ROW LEVEL SECURITY;

CREATE POLICY recurring_tenant_isolation ON public.recurring USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.securities ENABLE ROW LEVEL SECURITY;

CREATE POLICY securities_tenant_isolation ON public.securities USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.security_corporate_actions ENABLE ROW LEVEL SECURITY;

CREATE POLICY security_corporate_actions_tenant_isolation ON public.security_corporate_actions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.security_prices ENABLE ROW LEVEL SECURITY;

CREATE POLICY security_prices_tenant_isolation ON public.security_prices USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.stored_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY stored_images_tenant_isolation ON public.stored_images USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.taggings ENABLE ROW LEVEL SECURITY;

CREATE POLICY taggings_tenant_isolation ON public.taggings USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY tags_tenant_isolation ON public.tags USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.tax_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY tax_lots_tenant_isolation ON public.tax_lots USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.tenant_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_settings_tenant_isolation ON public.tenant_settings USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY transactions_tenant_isolation ON public.transactions USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

ALTER TABLE public.wash_sale_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY wash_sale_records_tenant_isolation ON public.wash_sale_records USING ((tenant_id = public.current_tenant_id())) WITH CHECK ((tenant_id = public.current_tenant_id()));

GRANT USAGE ON SCHEMA public TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_in(cstring) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_out(public.gtrgm) TO nuggets_app;

GRANT ALL ON FUNCTION public.account_balances_as_of(p_account_ids integer[], p_dates date[]) TO nuggets_app;

GRANT ALL ON FUNCTION public.aggregate_net_worth_snapshots(p_source_level character varying, p_target_level character varying, p_start_date date, p_end_date date) TO nuggets_app;

GRANT ALL ON FUNCTION public.app_timezone() TO nuggets_app;

GRANT ALL ON FUNCTION public.app_today() TO nuggets_app;

GRANT ALL ON FUNCTION public.apply_transaction_auto_tag(p_transaction_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.apply_transaction_auto_tags(p_transaction_ids integer[]) TO nuggets_app;

GRANT ALL ON FUNCTION public.assert_transaction_split_balanced(p_transaction_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.assert_transaction_transfer_paired(p_transaction_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.bulk_create_budget_items(p_budget_items jsonb, p_user_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_account_balance(p_account_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_account_balance_as_of(p_account_id integer, p_as_of date) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_actual_for_period_item(p_budget_period_item_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_budget_for_period_item(p_budget_period_item_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_descendant_tag_levels() TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_remaining_for_period_item(p_budget_period_item_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_remaining_for_period_items(p_budget_period_item_ids integer[]) TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_tag_level() TO nuggets_app;

GRANT ALL ON FUNCTION public.calculate_transfers_for_period_item(p_budget_period_item_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.check_account_simplefin_connection() TO nuggets_app;

GRANT ALL ON FUNCTION public.check_known_or_unchanged() TO nuggets_app;

GRANT ALL ON FUNCTION public.check_transaction_income_sign() TO nuggets_app;

GRANT ALL ON FUNCTION public.check_transaction_splits_and_transfers() TO nuggets_app;

GRANT ALL ON FUNCTION public.check_transaction_type_for_account() TO nuggets_app;

GRANT ALL ON FUNCTION public.create_budget_period_with_items(p_year integer, p_month integer, p_user_id integer, p_auto_rollover boolean) TO nuggets_app;

GRANT ALL ON FUNCTION public.create_net_worth_snapshot(p_snapshot_date date, p_snapshot_trigger character varying, p_aggregation_level character varying) TO nuggets_app;

GRANT ALL ON FUNCTION public.current_organization_id() TO nuggets_app;

GRANT ALL ON FUNCTION public.current_tenant_id() TO nuggets_app;

GRANT ALL ON FUNCTION public.delete_polymorphic_references() TO nuggets_app;

GRANT ALL ON FUNCTION public.generate_safe_filename() TO nuggets_app;

GRANT ALL ON FUNCTION public.get_account_id_by_uuid(account_uuid uuid) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_budget_period_summary(p_period_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_child_tag_ids(parent_tag_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_merchant_id_by_uuid(merchant_uuid uuid) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_merchant_rule_id_by_uuid(rule_uuid uuid) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_net_worth_history(p_period character varying, p_limit integer, p_fill_gaps boolean) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_tag_hierarchy_path(tag_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_tag_id_by_uuid(tag_uuid_param uuid) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_tag_report_root(p_tag_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_tag_transaction_summary(tag_uuid_param uuid, start_date_param date, end_date_param date) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_transaction_id_by_uuid(transaction_uuid uuid) TO nuggets_app;

GRANT ALL ON FUNCTION public.get_user_id_by_uuid(user_uuid uuid) TO nuggets_app;

GRANT ALL ON FUNCTION public.gin_extract_query_trgm(text, internal, smallint, internal, internal, internal, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gin_extract_value_trgm(text, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gin_trgm_consistent(internal, smallint, text, integer, internal, internal, internal, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gin_trgm_triconsistent(internal, smallint, text, integer, internal, internal, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.goal_waits_for_day_range_change() TO nuggets_app;

REVOKE ALL ON FUNCTION public.grant_deployment_admin(p_user_id integer, p_granted_by integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.grant_deployment_admin(p_user_id integer, p_granted_by integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_compress(internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_consistent(internal, text, smallint, oid, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_decompress(internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_distance(internal, text, smallint, oid, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_options(internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_penalty(internal, internal, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_picksplit(internal, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_same(public.gtrgm, public.gtrgm, internal) TO nuggets_app;

GRANT ALL ON FUNCTION public.gtrgm_union(internal, internal) TO nuggets_app;

REVOKE ALL ON FUNCTION public.lock_deployment_admin(p_user_id integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_deployment_admin(p_user_id integer) TO nuggets_app;

REVOKE ALL ON FUNCTION public.lock_deployment_users_of(p_user_id integer, p_actor_id integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lock_deployment_users_of(p_user_id integer, p_actor_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.lock_referenced_subject_on_update() TO nuggets_app;

GRANT ALL ON FUNCTION public.lock_referenced_subjects() TO nuggets_app;

GRANT ALL ON FUNCTION public.lock_referenced_transactions() TO nuggets_app;

GRANT ALL ON FUNCTION public.maintain_transaction_budget_period_consistency() TO nuggets_app;

GRANT ALL ON FUNCTION public.net_worth_as_of(p_as_of date) TO nuggets_app;

GRANT ALL ON FUNCTION public.organization_context_missing() TO nuggets_app;

GRANT ALL ON FUNCTION public.populate_taggings_report_root() TO nuggets_app;

GRANT ALL ON FUNCTION public.record_account_hidden_range() TO nuggets_app;

GRANT ALL ON FUNCTION public.record_budget_change_event(p_budget_period_item_id integer, p_budget_item_id integer, p_amount numeric, p_previous_amount numeric, p_description text, p_user_id integer, p_batch_id uuid, p_transaction_type character varying) TO nuggets_app;

GRANT ALL ON FUNCTION public.record_transfer_event(p_from_budget_period_item_id integer, p_to_budget_period_item_id integer, p_amount numeric, p_description text, p_user_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.refresh_descendant_taggings_on_tag_move() TO nuggets_app;

GRANT ALL ON FUNCTION public.remember_cleared_budget_period() TO nuggets_app;

REVOKE ALL ON FUNCTION public.revoke_deployment_admin(p_user_id integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_deployment_admin(p_user_id integer) TO nuggets_app;

GRANT ALL ON FUNCTION public.set_annotation_root_id() TO nuggets_app;

GRANT ALL ON FUNCTION public.set_limit(real) TO nuggets_app;

GRANT ALL ON FUNCTION public.show_limit() TO nuggets_app;

GRANT ALL ON FUNCTION public.show_trgm(text) TO nuggets_app;

GRANT ALL ON FUNCTION public.similarity(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.similarity_dist(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.similarity_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.stamp_security_last_composition_update() TO nuggets_app;

GRANT ALL ON FUNCTION public.stamp_security_last_price_update() TO nuggets_app;

GRANT ALL ON FUNCTION public.starting_balance_period_item(p_budget_item_id integer, p_starting_date date) TO nuggets_app;

GRANT ALL ON FUNCTION public.strict_word_similarity(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.strict_word_similarity_commutator_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.strict_word_similarity_dist_commutator_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.strict_word_similarity_dist_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.strict_word_similarity_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.tenant_context_missing() TO nuggets_app;

GRANT ALL ON FUNCTION public.trigger_transaction_auto_tag() TO nuggets_app;

GRANT ALL ON FUNCTION public.trim_space(value text) TO nuggets_app;

GRANT ALL ON FUNCTION public.update_tag_last_used() TO nuggets_app;

GRANT ALL ON FUNCTION public.update_tag_timestamp() TO nuggets_app;

GRANT ALL ON FUNCTION public.update_updated_at_column() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_generate_v1() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_generate_v1mc() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_generate_v3(namespace uuid, name text) TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_generate_v4() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_generate_v5(namespace uuid, name text) TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_nil() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_ns_dns() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_ns_oid() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_ns_url() TO nuggets_app;

GRANT ALL ON FUNCTION public.uuid_ns_x500() TO nuggets_app;

GRANT ALL ON FUNCTION public.wait_for_day_range_change() TO nuggets_app;

GRANT ALL ON FUNCTION public.word_similarity(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.word_similarity_commutator_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.word_similarity_dist_commutator_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.word_similarity_dist_op(text, text) TO nuggets_app;

GRANT ALL ON FUNCTION public.word_similarity_op(text, text) TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_currencies TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.account_currencies_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_hidden_ranges TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.account_hidden_ranges_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_imported_balance_history TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.account_imported_balance_history_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.account_institutions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.account_institutions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.accounts TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.accounts_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.annotations TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.annotations_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.attachments TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.attachments_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bill_occurrence_transactions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.bill_occurrence_transactions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bill_occurrences TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.bill_occurrences_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_alert_tracking TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_alert_tracking_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_item_accounts TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_item_accounts_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_item_matching_rules TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_item_matching_rules_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_item_usage_history TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_item_usage_history_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_items TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_items_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_period TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_period_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_period_items TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_period_items_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.budget_period_transactions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.budget_period_transactions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.categories TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.categories_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.cost_basis_method_settings TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.cost_basis_method_settings_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.data_freshness_thresholds TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.data_freshness_thresholds_id_seq TO nuggets_app;

GRANT SELECT ON TABLE public.deployment TO nuggets_app;

GRANT UPDATE(setup_token_hash) ON TABLE public.deployment TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.deployment_id_seq TO nuggets_app;

GRANT SELECT ON TABLE public.deployment_users TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.deployment_users_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.dividend_records TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.dividend_records_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fund_compositions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.fund_compositions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.fund_underlying_holdings TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.fund_underlying_holdings_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.goal_budget_items TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.goal_budget_items_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.holding_events TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.holding_events_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.import_sync_log TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.import_sync_log_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.login_throttles TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.login_throttles_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.lot_consumptions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.lot_consumptions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.merchant_matching_rules TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.merchant_matching_rules_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.merchants TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.merchants_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.net_worth_accounts TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.net_worth_snapshots TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.net_worth_snapshots_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_deliveries TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.notification_deliveries_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_preferences TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.notification_preferences_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_rule_sets TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.notification_rule_sets_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notifications TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.notifications_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.onedrive_tokens TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.onedrive_tokens_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_invitations TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.organization_invitations_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_price_sync_runs TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.organization_price_sync_runs_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_price_sync_settings TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.organization_price_sync_settings_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_simplefin_connections TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.organization_simplefin_connections_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organization_users TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.organization_users_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.organizations TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.organizations_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.passkey_credentials TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.passkey_credentials_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.personal_access_tokens TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.personal_access_tokens_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portfolio_value_snapshots TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.portfolio_value_snapshots_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.push_subscriptions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.push_subscriptions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.recurring TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.recurring_id_seq TO nuggets_app;

GRANT SELECT ON TABLE public.schema_migrations TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.securities TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.securities_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.security_corporate_actions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.security_corporate_actions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.security_prices TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.security_prices_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sessions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.sessions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.stored_images TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.stored_images_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.system_settings TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.system_settings_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.taggings TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.taggings_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tags TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.tags_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tags_with_hierarchy TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tax_lots TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.tax_lots_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_settings TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.tenant_settings_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenant_users TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.tenant_users_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.tenants TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.tenants_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.transactions TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.transactions_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_profile_images TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.user_profile_images_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.users TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.users_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.wash_sale_records TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.wash_sale_records_id_seq TO nuggets_app;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.webauthn_challenges TO nuggets_app;

GRANT SELECT,USAGE ON SEQUENCE public.webauthn_challenges_id_seq TO nuggets_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,USAGE ON SEQUENCES TO nuggets_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO nuggets_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES TO nuggets_app;

--
-- PostgreSQL database dump complete
--


-- ============================================================================
-- SEED DATA: the rows a fresh install starts with
-- ============================================================================

INSERT INTO public.deployment (id, name, app_version, status, setup_token_hash) VALUES ('1'::integer, 'Nuggets'::character varying(100), NULL::character varying(50), 'active'::character varying(20), NULL::character varying(64));
INSERT INTO public.organizations (id, name, status) VALUES ('1'::integer, 'Organization 1'::character varying(100), 'active'::character varying(20));
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('12'::integer, 'notification_queue_process_interval'::character varying(100), '5'::character varying(500), 'integer'::character varying(50), 'Minutes between notification queue processing (default: 5 minutes)'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('13'::integer, 'notification_max_per_user_per_day'::character varying(100), '5'::character varying(500), 'integer'::character varying(50), 'Maximum notifications per user per day (rate limiting)'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('14'::integer, 'notification_smtp_host'::character varying(100), ''::character varying(500), 'string'::character varying(50), 'SMTP server hostname'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('15'::integer, 'notification_smtp_port'::character varying(100), '587'::character varying(500), 'integer'::character varying(50), 'SMTP server port (587 for TLS, 465 for SSL)'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('16'::integer, 'notification_smtp_username'::character varying(100), ''::character varying(500), 'string'::character varying(50), 'SMTP username'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('17'::integer, 'notification_email_from_address'::character varying(100), 'notifications@nuggets.local'::character varying(500), 'string'::character varying(50), 'Email FROM address for notifications'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('18'::integer, 'notification_email_from_name'::character varying(100), 'Nuggets Financial Tracker'::character varying(500), 'string'::character varying(50), 'Email FROM name for notifications'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('19'::integer, 'notification_logo_url'::character varying(100), ''::character varying(500), 'string'::character varying(50), 'URL to logo image for email notifications (hosted in S3 or CDN)'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('22'::integer, 'notification_last_queue_process'::character varying(100), NULL::character varying(500), 'timestamp'::character varying(50), 'Last time queue was processed (auto-updated)'::text, 'notifications'::character varying(50), 'false'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('23'::integer, 'notification_rules_check_interval'::character varying(100), '15'::character varying(500), 'integer'::character varying(50), 'Minutes between notification rule checks (default: 15 minutes)'::text, 'notifications'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('24'::integer, 'notification_last_rules_check'::character varying(100), NULL::character varying(500), 'timestamp'::character varying(50), 'Last time the notification rules were checked (auto-updated)'::text, 'notifications'::character varying(50), 'false'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('25'::integer, 'application_timezone'::character varying(100), 'UTC'::character varying(500), 'string'::character varying(50), 'The deployment''s time zone (an IANA name such as America/New_York): the time zone of a ledger that hasn''t set its own, and of deployment jobs such as backups. Each ledger sets its own on its General settings page.'::text, 'general'::character varying(50), 'true'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('6'::integer, 'backup_enabled'::character varying(100), 'true'::character varying(500), 'boolean'::character varying(50), 'Enable automatic weekly backups'::text, 'backup'::character varying(50), 'false'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('7'::integer, 'backup_time'::character varying(100), '03:00'::character varying(500), 'string'::character varying(50), 'Time of day to run automatic backups (HH:MM format)'::text, 'backup'::character varying(50), 'false'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('8'::integer, 'backup_retention_days'::character varying(100), '90'::character varying(500), 'integer'::character varying(50), 'Number of days to keep backup files before deletion'::text, 'backup'::character varying(50), 'false'::boolean);
INSERT INTO public.system_settings (id, setting_key, setting_value, setting_type, description, category, is_user_configurable) VALUES ('9'::integer, 'notification_system_enabled'::character varying(100), 'true'::character varying(500), 'boolean'::character varying(50), 'Enable/disable entire notification system'::text, 'notifications'::character varying(50), 'false'::boolean);
INSERT INTO public.tenants (id, organization_id, name, status, balance_adjustment_merchant_id) VALUES ('1'::integer, '1'::integer, 'Ledger 1'::character varying(100), 'active'::character varying(20), NULL::integer);
SELECT pg_catalog.setval('public.deployment_id_seq', 1, true);
SELECT pg_catalog.setval('public.organizations_id_seq', 1, true);
SELECT pg_catalog.setval('public.system_settings_id_seq', 25, true);
SELECT pg_catalog.setval('public.tenants_id_seq', 1, true);

-- application_timezone (migration 20261027230000_app_today): a fresh install starts with
-- the zone its database cluster was configured with (TZ at initdb), UTC's aliases spelled
-- UTC, or UTC when that can't be read or isn't an Area/Location zone.
DO $seed$
DECLARE
    configured text;
BEGIN
    BEGIN
        SELECT setting INTO configured
          FROM pg_file_settings
         WHERE lower(name) = 'timezone' AND applied
         ORDER BY seqno DESC
         LIMIT 1;
    EXCEPTION WHEN insufficient_privilege THEN
        configured := NULL;
    END;
    IF configured IS NULL
       OR configured IN ('Etc/UTC', 'Etc/UCT', 'Etc/Universal', 'Etc/Zulu', 'Etc/GMT', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Greenwich')
       OR configured !~ '^[A-Za-z][A-Za-z0-9_+-]*/[A-Za-z0-9_+/-]+$'
       OR configured ~ '^(posix|right)/'
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = configured)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_abbrevs WHERE lower(abbrev) = lower(configured)) THEN
        configured := 'UTC';
    END IF;
    UPDATE public.system_settings SET setting_value = configured WHERE setting_key = 'application_timezone';
END
$seed$;

-- ============================================================================
-- MIGRATION TRACKING SEED DATA
-- ============================================================================
-- Seed schema_migrations so the migration runner knows these are already applied
INSERT INTO public.schema_migrations (version, name, checksum) VALUES
  ('20251024152915', 'replace import start date with days back', 'c7495fb6e92cbc8dc6f8bdcc320a6f94898d4f94270e481f29cce53970ce1811'),
  ('20251024221505', 'mark manual transactions as pending', '93f87cba0c681dd7641697ee974fdc96e72db82b2497e185efb9e0345908b52b'),
  ('20251103132957', 'add transfer and custom sort fields', 'da1a790950f9d9ef15328923788438d2eae712b2f0cd5e18ceadfa8f66bfff68'),
  ('20251109154200', 'add onedrive integration', '15611c6640c4f4fa6cc73c40a838df186db0602b0eaf16047aca2d0517327993'),
  ('20251110232304', 'add passkey credentials', '486f1bd68fb2b4fc3b12fb71fe88e98ea5d36d9450ef0874f72329f780c1658c'),
  ('20251120034700', 'create notification system', '95de4910a03404589e865d6586497494b61823190f441de2e5443213b9b24d58'),
  ('20251120040000', 'add notification logo setting', '2c136ab9f93bc5af853b8b9fa994cc442c60c8996337ce1ee8b35688bcddf3ab'),
  ('20251212200100', 'enhance tags system', '7be789f553e1bfdc003e5eb82fb1de77ebb4c5684d83ace8eb839292f0e4e06f'),
  ('20251213000000', 'exclude split parents from tag summaries', '19b92cfbe436e7b638ee3597ca51b77a4372a7d08318eaa659f19bb36a07acef'),
  ('20251213135500', 'add tags is active', '7eab897dd24720f9075ee739911f1e04b790a640d1b871bde3a168909ce99774'),
  ('20251213140000', 'add split transaction support', '0b977c7252d97008fd1f04d5c24381b7bb0fab886d6441e63fbd2f9754c419b3'),
  ('20251214091228', 'exclude split children from balance calculations', '0f762d069f8fd925a9d332bb024f43a3376194c0496d288d8cda0be2409063c7'),
  ('20251216000000', 'add refresh token system', 'ee5e1990ecfbbebd050b050bf898d5940fdbcc0aadb681cdb038942e4df4bd87'),
  ('20251217000000', 'consolidate goals into budget items', '169a9eb98a97711eafd95f2de273dd597d5745eca6a0c705c8f6bce87fecded6'),
  ('20251218000000', 'add ollama settings', '9001351cb79b07a8e2d60a3a9e1b73f8952fd92e49ba078b2bbd0f0533b2a09c'),
  ('20251218000001', 'create document import templates', '4e6e9e5147d06d53794b9b17b6013413d280084b21b020aeb0928422523c90db'),
  ('20251219000000', 'add ollama system instructions', '321888489d28285e8811948c1152ee4682e362135411c29a1d7dc6d68a1a2f17'),
  ('20251222000000', 'add uuid to document imports', '69d29ae58d87e1c1fe001aab73058f1d3743c846ad163d255e50e34caec7bde7'),
  ('20251223000000', 'add transaction date to imports', '72945cef0d19192fc5b5930e3f491843b8d61811a07832e28e95348eb42eb4b4'),
  ('20251227184016', 'add performance indexes', 'b33617289def79f3b085b41e27b1da0da490b37bd414f99c5f61f862d0e118c6'),
  ('20251227184500', 'update budget calculations for transfers', 'ebe24516983824e9632092f4a4c852ea2c90f74ed1ab2c996fc2c43ba20b0b7a'),
  ('20251229000000', 'fix remaining calculation double counting', '7e7c0a783af44128a04b71e8baaa2303d6a5d5b93346cb08903177c3a4179ce5'),
  ('20251231000000', 'add user id and type to taggings', '7e36ab70b8f9b7edf35bc8b7be01a281d134283b4b56182e46d8be8ffc9fd2de'),
  ('20251231000001', 'add transaction auto tag to budget items', 'aac22dd50b2dafa40ec061771b5de4ad182d4ba30606c2b4c7e202d40968c29c'),
  ('20251231000002', 'add transaction auto tag to merchants', '6c756651f01807d4ee8e1f15d1f9c5ee64e57ca63577c80d4ccf6f45385937dc'),
  ('20251231000003', 'create auto tag function and trigger', '1847531294772eb237fadfa31dfacdcb1792a13d37d96825f00323f5c64b407a'),
  ('20260122000000', 'add sessions table', '1f0400e3a370c0c50cb8cf3e67a336bbc56846ca44df5e9ff0e170682419e675'),
  ('20260203000000', 'add default line items from rules', 'c40c99e2a68e1b21258f661c31a19c5d1e4c70187a4247a6744c3c25847d5afa'),
  ('20260204000000', 'add amount to mapping rules', '5952d48b4bc40fe04b20195093e2334a296d61e41e79e4127b7846668e4e7432'),
  ('20260221000000', 'add is manual to templates', 'e13d55fae2de997a6a21669f8b1059284caef5183c4bd09c9a4a86224c3d517e'),
  ('20260221000001', 'add tag ids to rules and line items', 'ae864e382b0de133a0f03eae0b777ce21b7200167e37e54d0efd1111df958769'),
  ('20260418000000', 'add personal access tokens', '2e94b1132ee92b99c98fe01602d80a0539a11193376ac6e5f8d4d6243a253a5a'),
  ('20260419000000', 'add updated at to merchants', '408c92649ba28c54012fd559f0471805d5fb5b2c67195ae5c29de6d299e1fa97'),
  ('20260419000001', 'add instructions field', 'a18caf22ed69fcdf871d0e0038fcdc14b62c04f332cebde95e0e7c4084865cec'),
  ('20260517000000', 'add tag report namespaces', 'f5c94a8bb9a252c5365997e5c138ace1663bbb1c329b750410d796b03451a9f2'),
  ('20260520000000', 'unique current snapshot per account', '325794c62c1212a6e8dce27a14790537ca47e92e800ed06c490a799e340cf55d'),
  ('20260607000000', 'add tag last used at', '698fff77b410c48feb29ce26fd9c36f0e7ef6c51ebe5377af3fc789101ba0670'),
  ('20260608000000', 'add budget items uuid index', 'f143781acea7a4125d2a8a566a4328a66aa6acf8ec2441c1514571fabbee8188'),
  ('20260609000000', 'add trgm search indexes', '9d03d535f26499229de02b63081e138a5b2751a2a1cb62ac86aac97e4b4dcc6c'),
  ('20260610000000', 'drop refresh tokens table', 'cf587fbd2c4a9aae72088937f7554a487faa65fbdd35d1e4e09173191f5fa056'),
  ('20260610130000', 'switch uuid defaults to uuidv7', 'fae09d0ec7abefbc14e3a9e6d9abff7f839b136ca25d6db49d217b52c716913d'),
  ('20260610140000', 'uuidv7 in plpgsql functions', '448dcec9378dc8ecf454eabf792008ec31009da6d1b20b6c55bafc50b9344506'),
  ('20260614120000', 'add imported balance history date index', '36f3055768da9f0d236c20ca0848e267fb86d95ba66a10606e58cbf87c0304ed'),
  ('20260614180000', 'create import sessions', 'd41de32f165465581cff041592e73c2a8ed50fdf717bf68aa9e1dbb9aef8c7e4'),
  ('20260614210000', 'backfill uuidv4 to uuidv7', 'dd5c5afc22935c9e9f527d085dbf7124bee4182a08ed973be8351350d41f2893'),
  ('20260614220000', 'add uuid to remaining tables', '4159a320e18d873034f1074d6618acbc7daf7cbb45915644ac45900abc1fb97d'),
  ('20260614230000', 'uuid columns not null', 'f9ab2aa2e5e96e384f019b228a9c06d72d766594ca88cd4f89695f3436f16b79'),
  ('20260614240000', 'import sessions session id uuid', '0f9e179dcc350440e5ae1d90a5c80f935b66bdddad25fe745dce38a405aafb87'),
  ('20260615000000', 'drop dead budget trigger functions', 'd9517af7a5ef848e2952c71c4283940acaba9e6b296f6ed644847a302193b23b'),
  ('20260615000100', 'drop unused security definer uuid helpers', 'f98f9130c47557ecf605a324559741519243a15d638304aacf0f951d2b576282'),
  ('20260615000200', 'drop unused helper functions', '6db97c9c2ff843d64fed14e86cd224a1210811b560aaa200ad4cae3d57082d3b'),
  ('20260616000000', 'create multitenancy control plane', '9e9f6f26d423433a9cff010916f8405d176aed2aaf476add5a77c093cb76b94e'),
  ('20260616100000', 'harden updated at trigger', 'a80389d96dfb6448327e111f74b199a485c739b802470119950a5f3fb799a223'),
  ('20260616120000', 'tenant id columns and backfill', 'd7319b6c997e64c7e656d599618e36f37968189b0e637fb9324a5cd9bd91e98f'),
  ('20260616210000', 'create nuggets app role', 'c0c5ebae0bf098616aec9b336de98de7323e1a2c6a2f3072e7ab7bf006237c8c'),
  ('20260617000000', 'fix function on conflict for tenant uniques', '612d2416fa8244873b5d04896caf8906caee9c52f8f3532211207024aa23a37b'),
  ('20260618000000', 'enable rls cutover', '616bd9947d54b1f3c389310f6ea66eca7f32d0ba60ce7173555a734a5bcd8133'),
  ('20260619120000', 'add users login disabled', 'a7fef740799bc65ce15a06c8f081486d59b51ba8d5992098d58bf5bc22b19f7f'),
  ('20260619130000', 'drop users is admin', '954fb16be79f744ad6574e56dc9276026f1a8b69d845b245629292b2dbea23d1'),
  ('20260619140000', 'add pat tenant id', 'a918de6bb8e303abdb48eb619e543391a7d29c6cd457261c2883eac6d1c61cac'),
  ('20260619150000', 'organization simplefin connections', '034079dbe6ea15a0ed02dcde779055599de17bea262234f18fb3d5ed71ad0b83'),
  ('20260620120000', 'add users last tenant id', 'f89acce12b3b9f7f433a050661e371366a9c0d1f17db7916327ae4d79bfb95d5'),
  ('20260622110000', 'fix budget alert dedup uniqueness', 'c9a24743b0186fc7bf1affc12fb133603c9b2bae3e8b03034c0951d9bac322f4'),
  ('20260622120000', 'temporal instants to timestamptz', 'a3fc0d22af4fe2c3d4b5faf393e911ab833b0f0b0d0fe027b10ac407f8ea9653'),
  ('20260622130000', 'normalize account icons to lucide', '9d5195e7b8038b03788d744a46325250168881638b69891c5f1a72d9affe7ab1'),
  ('20260622140000', 'add default pay from account id', 'bc300ff7fc3106684710e0e855953d3899bb34edea89b97cd5d439aef2fcfcc3'),
  ('20260623000000', 'add tenant balance adjustment merchant', 'cd1216dab9fc7d560a2699c96e04c5abbbd91a8fd13619a08134715c8dd13150'),
  ('20260625000000', 'add transaction external fields', '8b43da1a02fc1e6e9f32880862784c5decd26df3cb62cb66a20911d865c19416'),
  ('20260626000000', 'create investment foundation', 'c0c6ee24ac54e603ec2219e9e7206c7b4dce7c4955e88900e3c72d8e3b533441'),
  ('20260626001000', 'create security corporate actions', '502a09680d6d8265abd9ed2d1556f6869f8f19e240483beb3617ff7366736d7a'),
  ('20260626002000', 'create fund composition', '791267ffd1a19df016eeeebb9c0ea8da68af622012882ec4c1f5e0c8aa5fb481'),
  ('20260626003000', 'create wash sale records', '51743d69f2cf928e358499cda428116fc4a999fae81589bab87c4156f02a25cb'),
  ('20260626004000', 'create data freshness thresholds', '0b89dbcf53ed97d33e88c985ef222825ae882e4ce15da9a1dc8a9970feb597f8'),
  ('20260626005000', 'add merger acquisition method', '16e4ff477ae9c9b4cf3542dd8d969b6534ffad5b2d5f38aef24b8c8d0310b8d9'),
  ('20260627000000', 'widen investment source columns', '545496e471fbeb2c37cf7897392620c30cfb8723938d77cd80d55c23c44ad110'),
  ('20260627010000', 'widen weight percentage precision', '0c6d55bbd767331ead09b9d0f3173f665be557eb095341a51ddcfdbd7f8495f5'),
  ('20260627030000', 'create organization price sync', '1848477df54a5829178f1edc10c055c82669c709518a804f055adb524903d0c4'),
  ('20260627040000', 'create portfolio value snapshots', '745a406c4db53f06d0a532d24f9cff490707c33faa33351264aca2585daa1673'),
  ('20260628000000', 'create annotations', 'ad7289d9f79eb4be944f9cfd26edf3c9df8d1d39c010ad1685471faf951d258f'),
  ('20260628120000', 'add account import error', '49507fe7d3f515fc5f0dcccb40906c15a7daa6562d0fea1864e29c00efd08b48'),
  ('20260629130000', 'drop security asset class sector', 'ada8966cf9f03282cc33d7ca06d4069ee8310e0ce6cb98eb3fa704f21b025370'),
  ('20260701000000', 'attachments add holding event', '5f2280206e390074f3e9ddd7ab9aae3565ff8e6b51c7cbaa0a43b9e51ea7babd'),
  ('20260704000000', 'remove ollama document import', '5d1ba6f2acd24c295a3ab86d4dc6893b39cd0738030512a465b1703667f0492c'),
  ('20260705000000', 'remove csv importer', '46bcd1aa90207f9dbd9bf29df2fb7e8d25ef6ece7f4031452b7b047d1587aad3'),
  ('20260705120000', 'add import payee', '65691b2d3e9713b1ae416c397d5c492981c82d4754fd8fdc7fbbf5eb5a8c4305'),
  ('20260708000000', 'purge plaintext import access url', '0d0894c641455f114f4366ab8d0e1ca8d9f736ba4557a838e98794b0b98feb04'),
  ('20260711000000', 'create stored images', 'dc5388e6669188ce29fe398d0030dce07c74b5adc133b7ea60ffdda3effd5ce8'),
  ('20260829150000', 'backfill split parent budget period', 'eaf5e93e77946af1fc6a41647493c2f9e8a214acb4817c4450fe9484a4c86454'),
  ('20261019120000', 'create push subscriptions', '0e3b8c9603de6880e355d315bc67635610f86b753ef20ad82ef8adf179a6ad34'),
  ('20261020000000', 'create notification rules', '4c23033e4b61aebb2b6251b6b197f21302d4fbfc7c066acd91eca9a48b58d7b5'),
  ('20261023120000', 'split parents have no budget item', 'c2afc0d0b87eeec8887061367ec8c9c0c1369985a4a0c7752f2a995c76345b49'),
  ('20261025120000', 'add budget item rollover target date', '3376d40784c1e8a25212a54a8518edd7fe7af11af4e49fa9b265199734dfe4a0'),
  ('20261025180000', 'create bill occurrences', 'b7b7169f802444e9d818c85548214ad8107cb176db320fdfdbe2139cb4441088'),
  ('20261026120000', 'skip archived items in new periods', '39da0156c25fbc2eaa05679366fada2b4e507266b4b0269190e2b1942eaaa635'),
  ('20261027030000', 'tenant context fails loudly', '017bd3ed983b9085763ab4be18d481381cdd23445d392788061d4073728d2567'),
  ('20261027040000', 'purge legacy account access urls', '161a16428846022655f262b94ec55f8ecde25edf5ba317aea7ed94ca2ad81697'),
  ('20261027120000', 'add deployment setup token hash', '29848fefd9a24796a81a02ca04582723b51b3042e35d8924ebe4234858b6c078'),
  ('20261027121000', 'add sessions original created at', '53d824ef66177a43c8f850c6f8bad431f2c2e9ed60df9279fa0e29e57afbc6ef'),
  ('20261027122000', 'create organization invitations', '8d7d19723777289c974b31049fdaeec14e96b4a6e2cba64b748e1df956b7c991'),
  ('20261027130000', 'token scope and session reauth', '51476f65fe2daae01cc3e2cef8d836b2881f3c9a188279380245430b3099dc78'),
  ('20261027140000', 'opening balances as transactions', '93be1dc401fd48ae7b407b8118259eb711e9041780fbc08f78c9bfd736f40cc9'),
  ('20261027150000', 'unique imported transaction ids', '787f33abf7d304c63bf15d2643f28ae0d8c7dca22bfca9a9ffd2451b5a8e39c8'),
  ('20261027230000', 'app today', 'dc8c27e85e84b5777f85579280e1cd0e9cdd362d6c5ddc870322c98c4546ae70'),
  ('20261027231000', 'database timezone utc', '09110ca91f8dd054430dccc7a21f72c5da79ae67dc56c59bf47ccb1805547b3b'),
  ('20261027232000', 'tag summary by transaction date', 'b4d874728bc10bcec8144b77db00230c3e7da24eeb8b0b16fa822bba4dd0baf9'),
  ('20261028120000', 'unique budget period per month', '0c5a571ff492b9a11c21c5e46be99b9097170f21addebf8886e419f1f00a169c'),
  ('20261028121000', 'unique merchant names', '1c9368fb26910b6780f5b83c22fc30e74c75f582bf5ec63b08f3a2deb9ee0c02'),
  ('20261028130000', 'net worth history from daily snapshots', 'ff78551d24262760fd7eff19d4fbc1c2c4f7b7ab77ae165451f293fb9b7222cc'),
  ('20261101120000', 'tag summary counts each transaction once', 'a00db80dcef90c541c2ab55947b4ea0a11c992e3e3bf0e89de1ddb546afd4ce8'),
  ('20261101122000', 'one net worth definition', 'c5c3311f60bdd2d681f103c8a1f2e224ecf36abc67de5fc41c98600ac3937d2e'),
  ('20261101220700', 'login throttles and must change password', '8ebc0c4733b0b8650aad1de2eb7a418304f2b1ea23adc3af108fc5f33dac100f'),
  ('20261101220800', 'create webauthn challenges', '0acb9b0fd8ce7856fb8e2e6f1860228a3209c130412766304930e5b1cd9d51f2'),
  ('20261101231500', 'budget event log integrity', '66c8a21068b0d2a988c970343b1d7ef000bf0dc63b55899c8ece4736f4bb4fa5'),
  ('20261101232000', 'long term by anniversary', 'fb3939478f46ff20fbafe60de9f1ca0fd261c7ea19a8c8492c4a204f7f71336e'),
  ('20261101232100', 'tax lot total is remaining basis', '627d29a0148dbfe29787629dc5ca2a85b0604422faff198bc0e2245c1ab71438'),
  ('20261101232200', 'wash sale replacement shares', '91e36dbf294ae4fc52e89e5c4bb55c15a1b3338333edd545cb42cdd707ba5962'),
  ('20261102090000', 'transactions list pages first', '2f70c6791d1e8f39ac4f26f34fd280399bc2d133d809780a3ecca4bea838f12a'),
  ('20261102091000', 'budget and goal history read their rows', 'c55875d6c38cdb730edd8eeef7d620dfcbdcb8bd9085d157ad64bfcc71bfa7d7'),
  ('20261102100000', 'tenant composite foreign keys', '06bcff4e1c5765c9d8946ec23ec8c150af284efce5cca9d46d9744e54df1e074'),
  ('20261102100100', 'profile images and tenant owned images', '2a2617a1f40058391b6320af51747e74e168e3d763149c02111608419a22328a'),
  ('20261102110000', 'ledger vocabulary', 'ada68cdcd6b2f44b2721de7f69f0dbc5abe80390e34c3957666fda5e78247084'),
  ('20261102110100', 'ledger not null', '5c14825d6d352f004b0c66f31ee9d30f0a8939bcd642bdb0b6e25c493d82bd51'),
  ('20261102110200', 'ledger money rules', 'aeb8131c28636649209d030240fd9fba1e301e0e2605573b9f168f24fe5a87ca'),
  ('20261102110300', 'ledger references', 'e099b9933cbfedac211c827f5285a04d4371615db995b8285fddc44cd3bf0fcd'),
  ('20261102140700', 'index sessions rotated from', 'b3500850a431efa8c3d2c6d0777327c04ac461af24e48dee56695f12818e1b0a'),
  ('20261102150000', 'neutral instructions comment', '18088858e120f44187ea4e1382d80313325d578c999c0d41159b182abc7057f3'),
  ('20261102200000', 'restore column comments', '3df40ab434f784131becd93d20077b390b7cb0f813c8df9db6e397bc3002e5ac'),
  ('20261102200100', 'tenant settings', 'ce07b301d2e06b869470ad47cbb4e04b8fc9526ae70bf436c3b6facca159b3f2'),
  ('20261103160000', 'upgrade matches fresh install', '8e2444543af22da4bdcc31c946b1977c85bb7003dfa3ceb3d9cda19ca0aca1f0'),
  ('20261103190000', 'tag levels follow their parents', '5d1e9766f8438563f661b9c7dedadd152281361f9cd1f0776e8977ccb9df97c7'),
  ('20261103193000', 'tenant settings import last attempt', '722816daa91be156a15dace001b4725d886e736da0fd6670d89989f74e1f9711'),
  ('20261104000000', 'drop retired schema', 'c6edadbbf19d95c97a71da2632adddc1ec194aa1c91d292845f8498c62a519ea'),
  ('20261104100000', 'tags and notes lock their transaction', '52396e87274190e4aa9e7a9c6878f7e19dbc05a63f546b1a126cfc71e37f4547'),
  ('20261104100100', 'income waits for account type', '77126700343005a70dedc175ece197e1ba6eb8df84e0ef739a1445872dfedb56'),
  ('20261104110000', 'app role reads deployment admins', 'b96e2f08c69788551d95c0821dc9e80991a437a3a33ecddb75ba8f39cc41e07f'),
  ('20261104120000', 'drop prefix indexes', 'f8b989571fc6971965fb2abb966a5014162a2f9686d7e84286380e7662d13f40'),
  ('20261104130000', 'drop template registry and unread settings', '5e28637411c0af6400c76a6de7e85cb3ad1b91aec09f80a5a5a9cf2b3ef24b6e'),
  ('20261104130100', 'rename seeded ledger', '72880051b90c941e79ba7329b68abb70aaef5e1825a4cc90c6cde5a50814996a'),
  ('20261104150000', 'organization rls', '4a0d7ec9d7c3c2806f4e43f2c36723415b249ff9f5f1ef4783c1ab75456ab75a'),
  ('20261104160000', 'drop goal progress history', '1c3b4aa0cef2bfba6f52908d19d31491952259413c4cb2b6e85ddabecaa15e52'),
  ('20261104180000', 'tags and notes lock their subject', '55dd7bd2b133106cc46a9e6986ff1b8a982fbe316f69560792e9a16e36790c50'),
  ('20261104180100', 'grant deployment admin rechecks granter', '96c9bb2cc44a8ff16475282036926bb7ed4f8d9977f847f4b8f92ce350938a14'),
  ('20261104180200', 'tag summary drops deleted status filter', '93f76958ce692c51ebe876bac0295a1d3dc48c280e5a9887ce578e80a7a81a63'),
  ('20261104200000', 'tags and notes lock subject on update', '330d6c66d1a78741e686f54896be4045c426818e24f8e3ebdb3853986135d3ab'),
  ('20261104220000', 'config and wording leftovers', '47323f1b6688efc747847cc8a06d1a1a4b8701dba27d4781a71e73e2cd9cba3b'),
  ('20261105110000', 'goal link history', 'c615391f37f94d532cae0eaf3a3eb299780de7d0306a2e30644dad6c7c231a6b'),
  ('20261105110100', 'account hidden ranges', '52b2240440e5393e6badfd19e970eb6862979dc5c37b5456da8b68ed5876b924'),
  ('20261105110200', 'remaining for period items', '57b11fafd3ec6257cfd938fabdcf5f646ae45139e5f77e4e4807e6e61c5adbc2'),
  ('20261105130000', 'drop trigram indexes', '39c55a81b245e53ca0085adb4411aab339c1da27c83d68096e69dc0a88dc5d7b'),
  ('20261105140000', 'lots covered by their source', 'aab17d61f8421ecb599c2d68fd1984d4fc9e3b4272937aae5d75915205e04f1a'),
  ('20261106100000', 'passkey user handles', 'c9cfe3ab9042194b0720a3eac04debe6db1d5ad2ea7d52ed876e41bb3a1cef77'),
  ('20261110100000', 'unique category names', 'a65c8e419bab574883630578670758b9339e7577bc397725053f60c003dc5e99'),
  ('20261111100000', 'remember cleared budget period', 'ca334b93c4326d8fd41a93e3e3f82dcd5f6e654081ffa005d6af60330564fa79'),
  ('20261111110000', 'zone change waits for new rows', '04eb5e459410dcee169fe996f63f2662b28a58c3b5dc6724b106f8908b9029f3'),
  ('20261111120000', 'category name key', 'b8598ef8d804340d0a5ffbb1dc8f2047b43f0b6935fb6b033ffea3edad95848e'),
  ('20261111130000', 'wash sale loss shares', '05e3c2c1ae87d5dc7c128da40c25d1dfc5102d2276405f5c49f63e8f7787c447'),
  ('20261111140000', 'day range lock new goal type', '1390f95b280985a7a1b80e0cc6a9825d1a558d1bfadbf25923cfa90cbe1f01d1'),
  ('20261111150000', 'security ticker key', '81ca234209b26963c03b601d662efe0c7876c25d8f710541bafb505c83117927'),
  ('20261112100000', 'one security per ticker', '3ea779ff169f064ee38031ae43d9dc630c6c487c0b25bd9a4c8bcb9a309799ed'),
  ('20261112100100', 'events adjusted for splits', 'fb41dfd7abd6d5e8e4ef9f3a5c82c722fb23d03f5b9b4f2558ec73b6b25ad974'),
  ('20261112200000', 'tenant settings money format', 'd5df7e182fe057a3f3df671b48618eb7e258d93bba188e25d4cdbc55a9bcb377');
