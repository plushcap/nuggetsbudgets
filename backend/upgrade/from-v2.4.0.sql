-- ============================================================================
-- Nuggets: the cutover of a v2.4.0 database to the v3.0.0 baseline
--
-- v3.0.0 replaced the migration history up to v2.4.0 with one baseline (init.sql,
-- schema_migrations version 20261113000000). A v2.4.0 database's schema differs from the
-- baseline's only in text and in two unused extensions, and the migration runner
-- (MigrationService) turns it into the baseline's with this SQL: when schema_migrations
-- holds exactly v2.4.0's migrations (db/baseline.ts), it runs this, deletes those rows and
-- records the baseline's, in one transaction under the migration lock.
--
-- It re-asserts the baseline's text rather than editing the old one, so the result doesn't
-- depend on what the database had:
--   1. drops pg_trgm and uuid-ossp, which nothing uses (and their privileges with them);
--   2. clears every comment on an object in public;
--   3. creates every function of the baseline again (CREATE OR REPLACE: the same signature,
--      owner and privileges, the baseline's body and attributes);
--   4. sets every comment of the baseline.
-- Made once, from v2.4.0's schema with the baseline's wording, and never edited: its
-- SHA-256 is the baseline's schema_migrations checksum, which the runner checks before it
-- runs this. backend/scripts/check-migrations.sh upgrade (CI) loads a v2.4.0 install
-- (src/test/fixtures/v2.4.0-install.sql), lets the runner cut it over, and compares it with
-- a fresh install.
-- ============================================================================

SELECT pg_catalog.set_config('search_path', '', true);
SELECT pg_catalog.set_config('check_function_bodies', 'false', true);

-- 1. The extensions. A role that doesn't own one, or an object of the database's own that
-- uses one, leaves it in place, with a warning: it does no harm there.
DO $cutover$
DECLARE
    ext text;
BEGIN
    FOREACH ext IN ARRAY ARRAY['pg_trgm', 'uuid-ossp'] LOOP
        BEGIN
            EXECUTE format('DROP EXTENSION IF EXISTS %I', ext);
        EXCEPTION WHEN insufficient_privilege OR dependent_objects_still_exist THEN
            RAISE WARNING 'The % extension stays in this database (%): Nuggets no longer uses it, and its owner can drop it', ext, SQLERRM;
        END;
    END LOOP;
END
$cutover$;

-- 2. Every comment on an object in public, as COMMENT ON <kind> <identity> IS NULL.
DO $cutover$
DECLARE
    d record;
    kind text;
    target text;
BEGIN
    FOR d IN
        SELECT o.type, o.identity
          FROM pg_catalog.pg_description c
         CROSS JOIN LATERAL pg_catalog.pg_identify_object(c.classoid, c.objoid, c.objsubid) o
         WHERE o.schema = 'public'
         ORDER BY o.type, o.identity
    LOOP
        target := d.identity;
        kind := CASE d.type
            WHEN 'table column' THEN 'COLUMN'
            WHEN 'view column' THEN 'COLUMN'
            WHEN 'materialized view column' THEN 'COLUMN'
            WHEN 'foreign table column' THEN 'COLUMN'
            WHEN 'composite type column' THEN 'COLUMN'
            WHEN 'table constraint' THEN 'CONSTRAINT'
            WHEN 'domain constraint' THEN 'CONSTRAINT'
            WHEN 'statistics object' THEN 'STATISTICS'
            ELSE upper(d.type)
        END;
        -- "c on public.d" names a domain's constraint as COMMENT ON CONSTRAINT c ON DOMAIN public.d.
        IF d.type = 'domain constraint' THEN
            target := regexp_replace(target, ' on ', ' ON DOMAIN ');
        END IF;
        EXECUTE format('COMMENT ON %s %s IS NULL', kind, target);
    END LOOP;
END
$cutover$;

-- 3. The baseline's functions.

CREATE OR REPLACE FUNCTION public.account_balances_as_of(p_account_ids integer[], p_dates date[]) RETURNS TABLE(account_id integer, as_of date, balance numeric)
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

CREATE OR REPLACE FUNCTION public.aggregate_net_worth_snapshots(p_source_level character varying, p_target_level character varying, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date) RETURNS integer
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

CREATE OR REPLACE FUNCTION public.app_timezone() RETURNS text
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

CREATE OR REPLACE FUNCTION public.app_today() RETURNS date
    LANGUAGE sql STABLE
    AS $$
    SELECT (now() AT TIME ZONE public.app_timezone())::date
$$;

CREATE OR REPLACE FUNCTION public.apply_transaction_auto_tag(p_transaction_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM apply_transaction_auto_tags(ARRAY[p_transaction_id]);
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_transaction_auto_tags(p_transaction_ids integer[]) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- The transactions first, in id order, as a tag on them locks them; one deleted
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

CREATE OR REPLACE FUNCTION public.assert_transaction_split_balanced(p_transaction_id integer) RETURNS void
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

CREATE OR REPLACE FUNCTION public.assert_transaction_transfer_paired(p_transaction_id integer) RETURNS void
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

CREATE OR REPLACE FUNCTION public.bulk_create_budget_items(p_budget_items jsonb, p_user_id integer DEFAULT NULL::integer) RETURNS TABLE(budget_item_id integer, success boolean, error_message text)
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

CREATE OR REPLACE FUNCTION public.calculate_account_balance(p_account_id integer) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT public.calculate_account_balance_as_of(p_account_id, public.app_today())
$$;

CREATE OR REPLACE FUNCTION public.calculate_account_balance_as_of(p_account_id integer, p_as_of date) RETURNS numeric
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(SUM(t.amount), 0)
      FROM public.transactions t
     WHERE t.account_id = p_account_id
       AND t.parent_transaction_id IS NULL
       AND (p_as_of IS NULL OR t.transaction_date <= p_as_of)
$$;

CREATE OR REPLACE FUNCTION public.calculate_actual_for_period_item(p_budget_period_item_id integer) RETURNS numeric
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

CREATE OR REPLACE FUNCTION public.calculate_budget_for_period_item(p_budget_period_item_id integer) RETURNS numeric
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

CREATE OR REPLACE FUNCTION public.calculate_descendant_tag_levels() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    tag_level INTEGER;
    under_itself BOOLEAN;
    height INTEGER;
BEGIN
    -- One move at a time in a tenant: a move another transaction holds this lock for is
    -- committed or rolled back before the walks below, each a statement of its own, read
    -- the tags (READ COMMITTED). TagService takes the lock first (TAG_TREE_LOCK_CLASS,
    -- 0x54414753), before its own checks. Released when the transaction ends.
    PERFORM pg_advisory_xact_lock(1413564243, NEW.tenant_id);

    -- A move or a new tag, checked after the statement, with every row it wrote there, so a
    -- statement that moves or adds several tags is checked as it leaves them, in whatever
    -- order its rows were written. Up from the new parent: reaching the tag is a
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

CREATE OR REPLACE FUNCTION public.calculate_remaining_for_period_item(p_budget_period_item_id integer) RETURNS numeric
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
        -- give it for (nearly) every event; any other is looked up.
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
        -- calculate_budget_for_period_item already includes the transfers
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

CREATE OR REPLACE FUNCTION public.calculate_remaining_for_period_items(p_budget_period_item_ids integer[]) RETURNS TABLE(budget_period_item_id integer, remaining numeric)
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

CREATE OR REPLACE FUNCTION public.calculate_tag_level() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent_level INTEGER;
BEGIN
    -- An update keeps the level the tag has. In a statement that moves several tags a
    -- parent's stored level may not be final yet, and chk_tags_max_level would check a
    -- level worked out from it: trg_calculate_descendant_tag_levels checks a move,
    -- and sets the moved tag's level and those below it, once the statement's rows are all
    -- written. A write that leaves the parent alone (a rename: PUT /api/tags/:uuid writes
    -- parent_id back unchanged) keeps the tag where it is, deeper too, as an older install
    -- may hold one: a row may keep the level it has.
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

CREATE OR REPLACE FUNCTION public.calculate_transfers_for_period_item(p_budget_period_item_id integer) RETURNS numeric
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

CREATE OR REPLACE FUNCTION public.check_account_simplefin_connection() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.check_known_or_unchanged() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.check_transaction_income_sign() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.check_transaction_splits_and_transfers() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.check_transaction_type_for_account() RETURNS trigger
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
    -- UPDATE until it commits, and this waits for it.
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

CREATE OR REPLACE FUNCTION public.create_budget_period_with_items(p_year integer, p_month integer, p_user_id integer DEFAULT NULL::integer, p_auto_rollover boolean DEFAULT true) RETURNS integer
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

    -- Create the budget period. The tenant has one per month
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

CREATE OR REPLACE FUNCTION public.create_net_worth_snapshot(p_snapshot_date date DEFAULT NULL::date, p_snapshot_trigger character varying DEFAULT 'transaction'::character varying, p_aggregation_level character varying DEFAULT 'daily'::character varying) RETURNS uuid
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

    -- Net worth at the end of target_date, from the one definition.
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

CREATE OR REPLACE FUNCTION public.current_organization_id() RETURNS integer
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT COALESCE(NULLIF(current_setting('app.current_organization_id', true), '')::integer, public.organization_context_missing())
$$;

CREATE OR REPLACE FUNCTION public.current_tenant_id() RETURNS integer
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
  SELECT COALESCE(NULLIF(current_setting('app.current_tenant_id', true), '')::integer, public.tenant_context_missing())
$$;

CREATE OR REPLACE FUNCTION public.delete_polymorphic_references() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.generate_safe_filename() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.get_account_id_by_uuid(account_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM accounts WHERE uuid = account_uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_budget_period_summary(p_period_id integer) RETURNS TABLE(budget_item_id integer, budget_item_name character varying, starting_amount numeric, budget_amount numeric, actual_amount numeric, transfers_amount numeric, remaining_amount numeric, rollover_enabled boolean)
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

CREATE OR REPLACE FUNCTION public.get_child_tag_ids(parent_tag_id integer) RETURNS TABLE(tag_id integer)
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

CREATE OR REPLACE FUNCTION public.get_merchant_id_by_uuid(merchant_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM merchants WHERE uuid = merchant_uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_merchant_rule_id_by_uuid(rule_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM merchant_matching_rules WHERE uuid = rule_uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_net_worth_history(p_period character varying DEFAULT 'month'::character varying, p_limit integer DEFAULT 30, p_fill_gaps boolean DEFAULT true) RETURNS TABLE(snapshot_date date, total_assets numeric, total_liabilities numeric, net_worth numeric, account_count integer, is_interpolated boolean)
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

CREATE OR REPLACE FUNCTION public.get_tag_hierarchy_path(tag_id integer) RETURNS text
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

CREATE OR REPLACE FUNCTION public.get_tag_id_by_uuid(tag_uuid_param uuid) RETURNS integer
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    RETURN (SELECT id FROM tags WHERE uuid = tag_uuid_param);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_tag_report_root(p_tag_id integer) RETURNS integer
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

CREATE OR REPLACE FUNCTION public.get_tag_transaction_summary(tag_uuid_param uuid, start_date_param date DEFAULT NULL::date, end_date_param date DEFAULT NULL::date) RETURNS TABLE(tag_id integer, tag_name character varying, tag_uuid uuid, hierarchy_path text, transaction_count bigint, total_amount numeric, income_amount numeric, expense_amount numeric)
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

CREATE OR REPLACE FUNCTION public.get_transaction_id_by_uuid(transaction_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM transactions WHERE uuid = transaction_uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_id_by_uuid(user_uuid uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN (SELECT id FROM users WHERE uuid = user_uuid);
END;
$$;

CREATE OR REPLACE FUNCTION public.goal_waits_for_day_range_change() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.grant_deployment_admin(p_user_id integer, p_granted_by integer) RETURNS void
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

CREATE OR REPLACE FUNCTION public.lock_deployment_admin(p_user_id integer) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.lock_deployment_users_of(p_user_id integer, p_actor_id integer) RETURNS boolean
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

CREATE OR REPLACE FUNCTION public.lock_referenced_subject_on_update() RETURNS trigger
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
                  HINT = 'A tag or a note is moved onto a subject while it is there.';
    END IF;
    RETURN NULL;
END;
$_$;

CREATE OR REPLACE FUNCTION public.lock_referenced_subjects() RETURNS trigger
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
                      HINT = 'A tag or a note is written while its subject is there.';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$_$;

CREATE OR REPLACE FUNCTION public.lock_referenced_transactions() RETURNS trigger
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
                  HINT = 'A tag or a note on a transaction is written while the transaction is there.';
    END IF;
    RETURN NULL;
END;
$_$;

CREATE OR REPLACE FUNCTION public.maintain_transaction_budget_period_consistency() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.net_worth_as_of(p_as_of date) RETURNS TABLE(total_assets numeric, total_liabilities numeric, net_worth numeric, account_count integer, active_account_count integer)
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

CREATE OR REPLACE FUNCTION public.organization_context_missing() RETURNS integer
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
BEGIN
  RAISE EXCEPTION 'no organization is set for this query (app.current_organization_id)'
    USING HINT = 'Run organization-scoped queries inside withOrganization (getOrgDb() in the backend), or a tenant transaction.';
END
$$;

CREATE OR REPLACE FUNCTION public.populate_taggings_report_root() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.report_root_id := public.get_tag_report_root(NEW.tag_id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_account_hidden_range() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.record_budget_change_event(p_budget_period_item_id integer, p_budget_item_id integer, p_amount numeric, p_previous_amount numeric DEFAULT NULL::numeric, p_description text DEFAULT NULL::text, p_user_id integer DEFAULT NULL::integer, p_batch_id uuid DEFAULT NULL::uuid, p_transaction_type character varying DEFAULT 'budget_update'::character varying) RETURNS uuid
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

CREATE OR REPLACE FUNCTION public.record_transfer_event(p_from_budget_period_item_id integer, p_to_budget_period_item_id integer, p_amount numeric, p_description text, p_user_id integer DEFAULT NULL::integer) RETURNS uuid
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

CREATE OR REPLACE FUNCTION public.refresh_descendant_taggings_on_tag_move() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.remember_cleared_budget_period() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.revoke_deployment_admin(p_user_id integer) RETURNS void
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

CREATE OR REPLACE FUNCTION public.set_annotation_root_id() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.stamp_security_last_composition_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.securities SET last_composition_update_at = NOW() WHERE id = NEW.security_id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.stamp_security_last_price_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.securities SET last_price_update_at = NOW() WHERE id = NEW.security_id;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.starting_balance_period_item(p_budget_item_id integer, p_starting_date date) RETURNS integer
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

CREATE OR REPLACE FUNCTION public.tenant_context_missing() RETURNS integer
    LANGUAGE plpgsql STABLE PARALLEL SAFE
    AS $$
BEGIN
  RAISE EXCEPTION 'no tenant is set for this query (app.current_tenant_id)'
    USING HINT = 'Run tenant-scoped queries inside withTenant (getDb() in the backend).';
END
$$;

CREATE OR REPLACE FUNCTION public.trigger_transaction_auto_tag() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.trim_space(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN btrim(value, '	
                  　﻿'::text);

CREATE OR REPLACE FUNCTION public.update_tag_last_used() RETURNS trigger
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

CREATE OR REPLACE FUNCTION public.update_tag_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF jsonb_exists(to_jsonb(NEW), 'updated_at') THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.wait_for_day_range_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_advisory_xact_lock_shared(1145133394, NEW.tenant_id);
    RETURN NEW;
END;
$$;


-- 4. The baseline's comments.

COMMENT ON FUNCTION public.account_balances_as_of(p_account_ids integer[], p_dates date[]) IS 'calculate_account_balance_as_of(account, date) for each of the accounts at each of the dates, in one pass over their transactions. The same balance definition, for a series.';
COMMENT ON FUNCTION public.app_timezone() IS 'The current tenant''s application_timezone (tenant_settings), else the deployment''s (system_settings), or UTC when that is unset or not a time zone.';
COMMENT ON FUNCTION public.app_today() IS 'Today in the application time zone: use it, not CURRENT_DATE, for the user''s today.';
COMMENT ON FUNCTION public.apply_transaction_auto_tag(p_transaction_id integer) IS 'Applies auto-tag to transaction based on budget_item and merchant rules. Merchant rule overrides budget_item rule.';
COMMENT ON FUNCTION public.apply_transaction_auto_tags(p_transaction_ids integer[]) IS 'Replace the auto tag of each given transaction: its merchant''s transaction_auto_tag_id, else its budget item''s. Returns how many transaction ids it was given.';
COMMENT ON FUNCTION public.calculate_account_balance(p_account_id integer) IS 'Current account balance: calculate_account_balance_as_of(account, app_today()), so a transaction dated after today counts from its date. The only balance definition.';
COMMENT ON FUNCTION public.calculate_account_balance_as_of(p_account_id integer, p_as_of date) IS 'Account balance at the end of p_as_of (NULL = all time): SUM(amount) of the account''s non-child transactions. The only balance definition.';
COMMENT ON FUNCTION public.calculate_remaining_for_period_items(p_budget_period_item_ids integer[]) IS 'calculate_remaining_for_period_item(id) for each of the period items, an envelope''s in one pass over its budget events and spending. The same remaining, for a series.';
COMMENT ON FUNCTION public.current_organization_id() IS 'The organization of the current transaction (app.current_organization_id); raises when none is set. Used by every organization policy and organization_id default.';
COMMENT ON FUNCTION public.current_tenant_id() IS 'The tenant of the current transaction (app.current_tenant_id); raises when none is set. Used by every tenant policy and tenant_id default.';
COMMENT ON FUNCTION public.get_tag_report_root(p_tag_id integer) IS 'Walks ancestors of the given tag and returns the id of the first tag with is_report_root = true, or NULL if none.';
COMMENT ON FUNCTION public.goal_waits_for_day_range_change() IS 'A budget item becoming a goal waits for a change of its tenant''s time zone under way, which then locks it with the goals.';
COMMENT ON FUNCTION public.grant_deployment_admin(p_user_id integer, p_granted_by integer) IS 'Makes a user a deployment admin, if the granter still is one (or, at first-run setup, the deployment has none and they grant themselves). The only way the app role adds a deployment_users row.';
COMMENT ON FUNCTION public.lock_deployment_admin(p_user_id integer) IS 'Share-locks a deployment admin''s row and says whether there is one, for the app role, which has no UPDATE on the table.';
COMMENT ON FUNCTION public.lock_deployment_users_of(p_user_id integer, p_actor_id integer) IS 'Locks the deployment_users rows deleting a user changes and the deleting admin''s, and says whether they are still an admin, for the app role, which has no UPDATE on the table.';
COMMENT ON FUNCTION public.lock_referenced_subject_on_update() IS 'Row trigger on taggings and annotations, after an update that moves the row to another subject: locks the new subject (FOR KEY SHARE) and refuses the row if it does not exist, as a foreign key would. lock_referenced_subjects and lock_referenced_transactions do the same as rows are inserted.';
COMMENT ON FUNCTION public.lock_referenced_subjects() IS 'Statement trigger on taggings and annotations: locks the rows other than transactions that the new rows point at (FOR KEY SHARE, a table at a time, in id order), and refuses a row whose subject does not exist, as a foreign key would. lock_referenced_transactions does the same for transactions.';
COMMENT ON FUNCTION public.lock_referenced_transactions() IS 'Statement trigger on taggings and annotations: locks the transactions the new rows point at (FOR KEY SHARE, in id order), and refuses a row whose transaction does not exist, as a foreign key would.';
COMMENT ON FUNCTION public.maintain_transaction_budget_period_consistency() IS 'Trigger function: sets a transaction''s budget_period_item_id to the budget_period_items row of its budget_item_id and budget_period_id (NULL when there is none), and clears a split parent''s budget_item_id and budget_period_item_id, which its splits carry.';
COMMENT ON FUNCTION public.net_worth_as_of(p_as_of date) IS 'Net worth at the end of p_as_of over net_worth_accounts, from calculate_account_balance_as_of. Liabilities are minus their (pre-signed) balances. The only net-worth definition.';
COMMENT ON FUNCTION public.organization_context_missing() IS 'Raises: called by current_organization_id() when app.current_organization_id is unset or empty.';
COMMENT ON FUNCTION public.record_account_hidden_range() IS 'Records hiding and showing an account in account_hidden_ranges, on the tenant''s today.';
COMMENT ON FUNCTION public.remember_cleared_budget_period() IS 'Keeps transactions.budget_period_cleared_from and _start: the period an update took the row out of and its first day, null once it has one.';
COMMENT ON FUNCTION public.revoke_deployment_admin(p_user_id integer) IS 'Removes a user''s deployment role, keeping at least one admin. The only way the app role removes a deployment_users row.';
COMMENT ON FUNCTION public.tenant_context_missing() IS 'Raises: called by current_tenant_id() when app.current_tenant_id is unset or empty.';
COMMENT ON FUNCTION public.trigger_transaction_auto_tag() IS 'Trigger function that applies auto-tagging when transaction budget_item_id or merchant_id changes';
COMMENT ON FUNCTION public.trim_space(value text) IS 'The text without the characters JavaScript''s trim() removes around it, as the API trims a ticker or an exchange (@nuggets/shared TRIMMED_SPACE_CODE_POINTS).';
COMMENT ON FUNCTION public.wait_for_day_range_change() IS 'A new budget item or account waits for a change of its tenant''s time zone under way, which then sees it.';
COMMENT ON TABLE public.account_hidden_ranges IS 'The days each account was hidden, written by a trigger on accounts.hide_account: a goal doesn''t count an account on a day it was hidden.';
COMMENT ON COLUMN public.account_hidden_ranges.hidden_from IS 'The first day (in the tenant''s time zone) the account was hidden; NULL: hidden since always (created hidden, or hidden before this history was kept).';
COMMENT ON COLUMN public.account_hidden_ranges.hidden_to IS 'The day it was shown again, from which it counts; NULL while it is hidden.';
COMMENT ON COLUMN public.accounts.nuggets_balance IS 'Retired: always 0. The opening balance is a ''starting balance'' transaction; balances come from calculate_account_balance().';
COMMENT ON COLUMN public.accounts.import_auto_review IS 'Automatically mark imported transactions as reviewed';
COMMENT ON COLUMN public.accounts.import_default_assigned_to IS 'Default user ID to assign imported transactions to';
COMMENT ON COLUMN public.accounts.require_zero_balance IS 'Indicates if this account should have a zero balance at month-end for close-out verification';
COMMENT ON COLUMN public.accounts.custom_sort IS 'Custom sort order for account display in UI dropdowns and lists';
COMMENT ON COLUMN public.accounts.instructions IS 'Free-form instructions/context for AI agents. Distinct from user-facing notes.';
COMMENT ON COLUMN public.accounts.default_pay_from_account_id IS 'Default source (asset) account to pre-fill when paying down this liability from Close-Out.';
COMMENT ON TABLE public.budget_alert_tracking IS 'Not used: the overspending alert it tracked was replaced by notification rules, whose notification_deliveries keep an alert from repeating.';
COMMENT ON COLUMN public.budget_alert_tracking.resolution_method IS 'How the alert was resolved, e.g. budget_increased, spending_stopped, manual_clear, period_ended';
COMMENT ON TABLE public.budget_item_accounts IS 'Junction table linking budget items (especially goals) to accounts for total tracking';
COMMENT ON COLUMN public.budget_item_accounts.valid_from IS 'The first day (in the tenant''s time zone) the goal counts the account: the day it was linked.';
COMMENT ON COLUMN public.budget_item_accounts.valid_to IS 'The day the link was removed, from which the goal no longer counts the account; NULL while it is linked.';
COMMENT ON COLUMN public.budget_items.goal_target_amount IS 'For a Savings goal: the amount to reach';
COMMENT ON COLUMN public.budget_items.goal_target_date IS 'For a Savings goal: the date to reach it by';
COMMENT ON COLUMN public.budget_items.image_path IS 'Optional image shown for the item (mostly goals)';
COMMENT ON COLUMN public.budget_items.status IS 'active, completed, paused or archived (used mostly by goals)';
COMMENT ON COLUMN public.budget_items.transaction_auto_tag_id IS 'Tag applied automatically (type=auto) to transactions assigned to this budget item';
COMMENT ON COLUMN public.budget_items.instructions IS 'Free-form instructions/context for AI agents. Distinct from user-facing description.';
COMMENT ON COLUMN public.categories.name_key IS 'The name as uniqueness compares it: lower case, without surrounding spaces.';
COMMENT ON TABLE public.deployment IS 'The install itself (singleton: exactly one row). Global control-plane metadata + FK anchor for deployment_users.';
COMMENT ON COLUMN public.deployment.setup_token_hash IS 'SHA-256 (hex) of the one-time first-run setup token, never the token. NULL once the first admin exists.';
COMMENT ON TABLE public.deployment_users IS 'user <-> deployment. role admin|support; delegated/restricted deployment management. No is_deployment_admin flag exists on users.';
COMMENT ON TABLE public.goal_budget_items IS 'Junction table linking goal budget items to other envelope budget items for total tracking';
COMMENT ON COLUMN public.goal_budget_items.goal_id IS 'The goal: a budget_items row with expense_type = ''Savings''';
COMMENT ON COLUMN public.goal_budget_items.valid_from IS 'The first day (in the tenant''s time zone) the goal counts the envelope: the day it was linked.';
COMMENT ON COLUMN public.goal_budget_items.valid_to IS 'The day the link was removed, from which the goal no longer counts the envelope; NULL while it is linked.';
COMMENT ON COLUMN public.holding_events.adjusted_through_action_id IS 'The last split of the security its figures are already adjusted for, recorded after its date; NULL when they are as of its date.';
COMMENT ON TABLE public.login_throttles IS 'Per-account password sign-in throttling. Keys are HMACs of an email address, or of an address and a trusted device. Control plane: no tenant_id, no RLS.';
COMMENT ON COLUMN public.merchants.transaction_auto_tag_id IS 'Tag applied automatically (type=auto) to transactions assigned to this merchant; overrides the budget item''s auto tag';
COMMENT ON COLUMN public.merchants.instructions IS 'Free-form instructions/context for AI agents. Distinct from user-facing notes.';
COMMENT ON VIEW public.net_worth_accounts IS 'The accounts that count in net worth: not hidden, not excluded from net worth, in dollars (closed accounts count). The only net-worth account set.';
COMMENT ON TABLE public.notifications IS 'Queue and history of the notifications the notification rules send a person: queued pending, then sent by push, email or both, and marked sent or failed.';
COMMENT ON COLUMN public.notifications.notification_type IS 'The kind of the notification rule that queued it (budget_item, transaction, review_reminder, digest, bill)';
COMMENT ON COLUMN public.notifications.template_data IS 'JSON data rendered into the email template';
COMMENT ON COLUMN public.notifications.status IS 'Lifecycle: pending, processing, then sent or failed (delivered and bounced are accepted for delivery tracking)';
COMMENT ON COLUMN public.notifications.ses_message_id IS 'Message-ID the SMTP server returned for the sent email';
COMMENT ON TABLE public.onedrive_tokens IS 'Stores encrypted OneDrive OAuth tokens for backup sync feature';
COMMENT ON COLUMN public.onedrive_tokens.access_token IS 'Microsoft Graph access token, encrypted with a key derived from the data encryption key';
COMMENT ON COLUMN public.onedrive_tokens.refresh_token IS 'Refresh token used to renew the access token, encrypted with a key derived from the data encryption key';
COMMENT ON COLUMN public.onedrive_tokens.expires_at IS 'When the access token expires';
COMMENT ON COLUMN public.onedrive_tokens.folder_path IS 'OneDrive folder that backups are uploaded to (default /Backups/Nuggets)';
COMMENT ON COLUMN public.onedrive_tokens.auto_sync_enabled IS 'Whether backups are uploaded to OneDrive automatically';
COMMENT ON TABLE public.organization_invitations IS 'Invitations to join an organization. Accepted only by a signed-in user with the invited email and the link''s token (stored as token_hash). Control plane: no tenant_id, no RLS.';
COMMENT ON TABLE public.organization_users IS 'user <-> organization. is_admin = Organization Admin ("Family Manager"), who administers every budget in the org.';
COMMENT ON TABLE public.organizations IS 'A family / grouping of budgets. Global control plane; the future billing anchor.';
COMMENT ON TABLE public.passkey_credentials IS 'WebAuthn/passkey credentials for passwordless authentication. Stores public keys and credential data for user passkey devices.';
COMMENT ON COLUMN public.passkey_credentials.credential_id IS 'Base64URL-encoded credential ID from WebAuthn registration';
COMMENT ON COLUMN public.passkey_credentials.public_key IS 'Base64URL-encoded COSE public key';
COMMENT ON COLUMN public.passkey_credentials.counter IS 'Signature counter for replay attack prevention';
COMMENT ON COLUMN public.passkey_credentials.device_name IS 'User-provided name for the passkey (e.g. "My phone", "Work laptop")';
COMMENT ON COLUMN public.passkey_credentials.transports IS 'Supported authenticator transports (usb, nfc, ble, internal, hybrid)';
COMMENT ON COLUMN public.passkey_credentials.aaguid IS 'Authenticator attestation GUID identifying the device type';
COMMENT ON COLUMN public.passkey_credentials.credential_device_type IS 'single_device, or multi_device for cloud-synced passkeys';
COMMENT ON COLUMN public.passkey_credentials.credential_backed_up IS 'Whether the credential is backed up (cloud-synced passkeys)';
COMMENT ON COLUMN public.passkey_credentials.user_handle IS 'WebAuthn user handle (base64url) the passkey answers with: its account''s (users.webauthn_user_id) for a passkey registered under it; for an older passkey, the one it returned at its first sign-in after that, null until then';
COMMENT ON COLUMN public.passkey_credentials.discoverable IS 'Whether the passkey can sign in without an email (a discoverable credential): the browser''s credProps rk at registration, else true (registration requires one); true once it has signed in without one; null when unknown (registered before it was recorded)';
COMMENT ON TABLE public.personal_access_tokens IS 'Long-lived JWTs for non-browser clients (MCP). Revocation is soft (revoked_at), so audit trail is retained.';
COMMENT ON COLUMN public.personal_access_tokens.scope IS 'What the token may do on the routes it reaches: read (GET/HEAD only) or read_write.';
COMMENT ON TABLE public.schema_migrations IS 'Tracks applied database migrations for version control';
COMMENT ON COLUMN public.schema_migrations.version IS 'Migration version in format YYYYMMDDHHMMSS';
COMMENT ON COLUMN public.schema_migrations.checksum IS 'SHA256 checksum of migration file content to detect modifications';
COMMENT ON COLUMN public.securities.ticker_key IS 'The ticker in upper case, as a holdings snapshot looks it up.';
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
COMMENT ON TABLE public.system_settings IS 'Deployment-wide settings, such as SMTP, backups, OneDrive, Web Push and the notification limits; the secrets among them are stored encrypted. A tenant''s own settings, such as its bank import schedule, are in tenant_settings.';
COMMENT ON COLUMN public.taggings.user_id IS 'Audit: the user who created the tagging';
COMMENT ON COLUMN public.taggings.type IS 'manual (a person tagged it) or auto (an auto-tag rule)';
COMMENT ON COLUMN public.taggings.report_root_id IS 'Denormalized pointer to the namespace root for the tag in this tagging. NULL when the tag is not under any report-root namespace. Populated automatically by trigger.';
COMMENT ON COLUMN public.tags.is_active IS 'Inactive tags are kept for history but not offered when tagging transactions';
COMMENT ON COLUMN public.tags.is_report_root IS 'When true, this top-level tag defines a "report namespace" for Sankey reporting. Only meaningful on level-0 tags.';
COMMENT ON COLUMN public.tags.report_flow_measure IS 'Sankey flow measure for the namespace: actual (transactions), allocated (budget events), or effective (hybrid by item characteristics). Only meaningful when is_report_root = true.';
COMMENT ON TABLE public.tenant_settings IS 'A tenant''s own settings: its time zone and its bank import schedule. Deployment-wide settings stay in system_settings.';
COMMENT ON COLUMN public.tenant_settings.setting_key IS 'One of the keys the check constraint lists.';
COMMENT ON TABLE public.tenant_users IS 'user <-> tenant/budget. is_admin = Tenant Admin for that budget.';
COMMENT ON TABLE public.tenants IS 'One budget = the per-budget data isolation unit (RLS lands here in a later phase). Belongs to an organization.';
COMMENT ON COLUMN public.tenants.balance_adjustment_merchant_id IS 'Per-tenant merchant assigned to balance-adjustment transactions (manual Adjust Balance + SimpleFin auto-rebalance). NULL = no merchant.';
COMMENT ON COLUMN public.transactions.transfer_transaction_id IS 'The other side of a transfer (each side points at the other)';
COMMENT ON COLUMN public.transactions.transfer_source_account_id IS 'On the destination side of a transfer: the source account';
COMMENT ON COLUMN public.transactions.parent_transaction_id IS 'On a split child: the transaction it was split from';
COMMENT ON COLUMN public.transactions.is_split_parent IS 'True when the transaction is split into child transactions; its splits add up to it';
COMMENT ON COLUMN public.transactions.import_payee IS 'Payee name as reported by the import provider (e.g. SimpleFin''s pre-cleaned merchant name). Null for manual transactions and providers that omit it.';
COMMENT ON COLUMN public.transactions.budget_period_cleared_from IS 'The budget period an update last took this transaction out of, null once it is in one again: a bank sync doesn''t put it back in one.';
COMMENT ON COLUMN public.transactions.budget_period_cleared_start IS 'The first day of the budget period it was taken out of: deleted, and its month''s period made again, the sync puts it back in that one.';
COMMENT ON COLUMN public.users.password_changed_at IS 'When the password last changed. Sessions created before it are invalid.';
COMMENT ON COLUMN public.users.login_disabled IS 'Service account: interactive login (password/passkey/session) is blocked; token (PAT/MCP) auth still works. Independent of is_locked.';
COMMENT ON COLUMN public.users.must_change_password IS 'An admin set this password (a new account, or a reset): the user must replace it before their session reaches anything else.';
COMMENT ON COLUMN public.users.webauthn_user_id IS 'WebAuthn user handle (32 random bytes, base64url) every passkey of the account is registered under; made at the first passkey registration that records it, never changed';
COMMENT ON COLUMN public.wash_sale_records.replacement_shares IS 'Shares of the replacement lot matched to the loss shares: one per loss share when matched, scaled since by the lot''s splits.';
COMMENT ON COLUMN public.wash_sale_records.loss_shares IS 'Loss shares this record matched, as they were sold.';
COMMENT ON TABLE public.webauthn_challenges IS 'Passkey ceremony challenges, each for the browser that started it (browser_hash: SHA-256 of a random id in its httpOnly cookie). Single use. Control plane: no tenant_id, no RLS.';
