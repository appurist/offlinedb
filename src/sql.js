import { defineTable } from "./schema.js";

/**
 * @param {{schema?: string}=} options
 */
export function createOfflinedbInstallSql(options = {}) {
  const schema = assertIdentifier(options.schema ?? "offlinedb", "schema");

  return `
CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};

CREATE TABLE IF NOT EXISTS ${qualified(schema, "global_mutation")} (
  global_id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  owner_id TEXT,
  local_id TEXT,
  revision BIGINT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  operation TEXT NOT NULL,
  row_data JSONB
);

-- Lets mutate_<table> find a row's delete tombstone without scanning the log.
CREATE INDEX IF NOT EXISTS ${quoteIdentifier("global_mutation_table_row_idx")}
  ON ${qualified(schema, "global_mutation")} (table_name, row_key);

CREATE TABLE IF NOT EXISTS ${qualified(schema, "applied_mutation")} (
  user_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  global_id BIGINT,
  table_name TEXT NOT NULL,
  row_key TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, local_id)
);

CREATE OR REPLACE FUNCTION ${qualified(schema, "current_user_id")}()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims.sub', true), '')
  )::TEXT
$$;

CREATE OR REPLACE FUNCTION ${qualified(schema, "record_change")}()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  next_owner_id TEXT;
  next_revision BIGINT;
  next_key TEXT;
  next_payload JSONB;
  next_local_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    next_owner_id := OLD.owner_id;
    next_revision := OLD.revision;
    next_key := OLD.id::TEXT;
    next_payload := NULL;
    next_local_id := OLD.local_id;
  ELSE
    next_owner_id := NEW.owner_id;
    next_revision := NEW.revision;
    next_key := NEW.id::TEXT;
    next_payload := to_jsonb(NEW) - 'global_id';
    next_local_id := NEW.local_id;
  END IF;

  INSERT INTO ${qualified(schema, "global_mutation")} (
    table_name,
    row_key,
    owner_id,
    local_id,
    revision,
    operation,
    row_data
  )
  VALUES (
    TG_TABLE_NAME,
    next_key,
    next_owner_id,
    next_local_id,
    next_revision,
    lower(TG_OP),
    next_payload
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ${qualified(schema, "pull_changes")}(
  p_last_global_id BIGINT DEFAULT 0,
  p_tables TEXT[] DEFAULT NULL
)
RETURNS JSONB
LANGUAGE SQL
STABLE
AS $$
  WITH selected AS (
    SELECT
      gm.global_id,
      gm.table_name,
      gm.row_key,
      gm.row_data
    FROM ${qualified(schema, "global_mutation")} gm
    WHERE gm.global_id > COALESCE(p_last_global_id, 0)
      AND (p_tables IS NULL OR gm.table_name = ANY(p_tables))
    ORDER BY gm.global_id ASC
  )
  SELECT jsonb_build_object(
    'changes',
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'globalId', selected.global_id,
          'table', selected.table_name,
          'key', selected.row_key,
          'row', selected.row_data
        )
        ORDER BY selected.global_id
      ),
      '[]'::jsonb
    ),
    'lastGlobalId',
    COALESCE(MAX(selected.global_id), COALESCE(p_last_global_id, 0))
  )
  FROM selected
$$;
`.trim();
}

/**
 * @param {{table: ReturnType<typeof defineTable> | string, schema?: string, metadataSchema?: string}} options
 */
export function createSyncedTableSql(options) {
  const schema = assertIdentifier(options.schema ?? "public", "schema");
  const metadataSchema = assertIdentifier(options.metadataSchema ?? "offlinedb", "metadata schema");
  const table = typeof options.table === "string" ? defineTable({ name: options.table }) : options.table;
  const tableName = qualified(schema, table.name);
  const mutateFunctionName = qualified(metadataSchema, `mutate_${table.name}`);
  const touchTriggerName = quoteIdentifier(`offlinedb_touch_${table.name}`);
  const changeTriggerName = quoteIdentifier(`offlinedb_record_${table.name}`);

  return `
ALTER TABLE ${tableName}
  ADD COLUMN IF NOT EXISTS ${quoteIdentifier(table.ownerColumn)} TEXT,
  ADD COLUMN IF NOT EXISTS ${quoteIdentifier(table.revisionColumn)} BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ${quoteIdentifier(table.updatedAtColumn)} TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS ${quoteIdentifier(table.localIdColumn)} TEXT,
  ADD COLUMN IF NOT EXISTS ${quoteIdentifier(table.globalIdColumn)} BIGINT NOT NULL DEFAULT 0;

UPDATE ${tableName}
SET ${quoteIdentifier(table.ownerColumn)} = COALESCE(${quoteIdentifier(table.ownerColumn)}, ${qualified(metadataSchema, "current_user_id")}())
WHERE ${quoteIdentifier(table.ownerColumn)} IS NULL;

ALTER TABLE ${tableName}
  ALTER COLUMN ${quoteIdentifier(table.ownerColumn)} SET NOT NULL;

CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${table.name}_owner_global_id_idx`)}
  ON ${tableName} (${quoteIdentifier(table.ownerColumn)}, ${quoteIdentifier(table.globalIdColumn)});

CREATE OR REPLACE FUNCTION ${qualified(metadataSchema, `touch_${table.name}`)}()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.${table.updatedAtColumn} := NOW();
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.${table.globalIdColumn}, 0) <= 0 THEN
      NEW.${table.globalIdColumn} := nextval(pg_get_serial_sequence('${qualified(metadataSchema, "global_mutation")}', 'global_id'));
    END IF;
  ELSE
    IF COALESCE(NEW.${table.globalIdColumn}, 0) <= COALESCE(OLD.${table.globalIdColumn}, 0) THEN
      NEW.${table.globalIdColumn} := nextval(pg_get_serial_sequence('${qualified(metadataSchema, "global_mutation")}', 'global_id'));
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    -- The client inserts at revision 1 and keeps that number locally; adding
    -- one here would leave the server a revision ahead, so the client's next
    -- queued change for the row would be rejected as a conflict.
    IF COALESCE(NEW.${table.revisionColumn}, 0) <= 0 THEN
      NEW.${table.revisionColumn} := 1;
    END IF;
  ELSE
    NEW.${table.revisionColumn} := OLD.${table.revisionColumn} + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ${touchTriggerName} ON ${tableName};
CREATE TRIGGER ${touchTriggerName}
BEFORE INSERT OR UPDATE ON ${tableName}
FOR EACH ROW
EXECUTE FUNCTION ${qualified(metadataSchema, `touch_${table.name}`)}();

DROP TRIGGER IF EXISTS ${changeTriggerName} ON ${tableName};
CREATE TRIGGER ${changeTriggerName}
AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
FOR EACH ROW
EXECUTE FUNCTION ${qualified(metadataSchema, "record_change")}();

ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ${quoteIdentifier(`${table.name}_owner_select`)} ON ${tableName};
CREATE POLICY ${quoteIdentifier(`${table.name}_owner_select`)} ON ${tableName}
  FOR SELECT
  USING (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}());

DROP POLICY IF EXISTS ${quoteIdentifier(`${table.name}_owner_insert`)} ON ${tableName};
CREATE POLICY ${quoteIdentifier(`${table.name}_owner_insert`)} ON ${tableName}
  FOR INSERT
  WITH CHECK (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}());

DROP POLICY IF EXISTS ${quoteIdentifier(`${table.name}_owner_write`)} ON ${tableName};
CREATE POLICY ${quoteIdentifier(`${table.name}_owner_write`)} ON ${tableName}
  FOR UPDATE
  USING (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}())
  WITH CHECK (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}());

DROP POLICY IF EXISTS ${quoteIdentifier(`${table.name}_owner_delete`)} ON ${tableName};
CREATE POLICY ${quoteIdentifier(`${table.name}_owner_delete`)} ON ${tableName}
  FOR DELETE
  USING (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}());

CREATE OR REPLACE FUNCTION ${mutateFunctionName}(
  p_local_id TEXT,
  p_row_key TEXT,
  p_base_revision BIGINT,
  p_values JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  existing_row ${tableName}%ROWTYPE;
  next_row ${tableName}%ROWTYPE;
  row_exists BOOLEAN;
  applied_global_id BIGINT;
  payload JSONB;
  column_list TEXT;
  set_clause TEXT;
  upsert_sql TEXT;
BEGIN
  SELECT *
  INTO existing_row
  FROM ${tableName}
  WHERE ${table.primaryKey}::TEXT = p_row_key
  FOR UPDATE;
  -- Captured now: every later INSERT/UPDATE/DELETE statement resets FOUND.
  row_exists := FOUND;

  -- A retry of a mutation that already committed (the client never saw the
  -- response). Report the same outcome again instead of applying it twice.
  SELECT global_id INTO applied_global_id
  FROM ${qualified(metadataSchema, "applied_mutation")}
  WHERE user_id = ${qualified(metadataSchema, "current_user_id")}()
    AND local_id = p_local_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'localId', p_local_id,
      'globalId', COALESCE(applied_global_id, 0),
      'row', CASE WHEN row_exists THEN to_jsonb(existing_row) ELSE NULL END
    );
  END IF;

  -- A delete is applied whatever the row's revision: the user asked for the
  -- row to go, and a stale base revision must not resurrect it on the client.
  IF row_exists AND p_values IS NOT NULL AND existing_row.${table.revisionColumn} <> p_base_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'revision_conflict',
      'row', to_jsonb(existing_row)
    );
  END IF;

  -- The client is editing a row it once held (base revision above 0) that the
  -- server has since deleted. Re-inserting it would resurrect the row on every
  -- other client; the client drops its stale copy instead.
  IF NOT row_exists AND p_values IS NOT NULL AND COALESCE(p_base_revision, 0) > 0 AND EXISTS (
    SELECT 1
    FROM ${qualified(metadataSchema, "global_mutation")} gm
    WHERE gm.table_name = ${quoteText(table.name)}
      AND gm.row_key = p_row_key
      AND gm.operation = 'delete'
  ) THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'deleted',
      'row', NULL
    );
  END IF;

  INSERT INTO ${qualified(metadataSchema, "applied_mutation")} (user_id, local_id, table_name, row_key)
  VALUES (${qualified(metadataSchema, "current_user_id")}(), p_local_id, ${quoteText(table.name)}, p_row_key)
  ON CONFLICT (user_id, local_id) DO NOTHING;

  -- A NULL payload is the delete tombstone queued by client.delete(). Deleting
  -- a row that is already gone is accepted so the client's queue drains.
  IF p_values IS NULL THEN
    IF row_exists THEN
      DELETE FROM ${tableName}
      WHERE ${table.primaryKey}::TEXT = p_row_key;
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'localId', p_local_id,
      'globalId', 0,
      'row', NULL
    );
  END IF;

  payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          p_values,
          ${quoteText(`{${table.primaryKey}}`)},
          to_jsonb(p_row_key)
        ),
        ${quoteText(`{${table.localIdColumn}}`)},
        to_jsonb(p_local_id)
      ),
      ${quoteText(`{${table.ownerColumn}}`)},
      to_jsonb(COALESCE(p_values ->> ${quoteText(table.ownerColumn)}, ${qualified(metadataSchema, "current_user_id")}()))
    ),
    ${quoteText(`{${table.globalIdColumn}}`)},
    COALESCE(
      p_values -> ${quoteText(table.globalIdColumn)},
      '0'::jsonb
    )
  );

  -- Only the columns present in the payload are written. Columns the client
  -- does not know about keep their table default on insert and their current
  -- value on update, instead of being set to NULL by a positional INSERT.
  SELECT
    string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
    string_agg(format('%1$I = EXCLUDED.%1$I', column_name), ', ' ORDER BY ordinal_position)
      FILTER (WHERE column_name <> ${quoteText(table.primaryKey)})
  INTO column_list, set_clause
  FROM information_schema.columns
  WHERE table_schema = ${quoteText(schema)}
    AND table_name = ${quoteText(table.name)}
    AND payload ? column_name::TEXT;

  upsert_sql := format(
    'INSERT INTO %1$s (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::%1$s, $1) ON CONFLICT (%3$I) DO UPDATE SET %4$s RETURNING *',
    ${quoteText(tableName)},
    column_list,
    ${quoteText(table.primaryKey)},
    set_clause
  );

  EXECUTE upsert_sql
    USING payload
    INTO next_row;

  UPDATE ${qualified(metadataSchema, "applied_mutation")}
  SET global_id = next_row.${table.globalIdColumn}
  WHERE user_id = ${qualified(metadataSchema, "current_user_id")}()
    AND local_id = p_local_id;

  RETURN jsonb_build_object(
    'ok', true,
    'localId', p_local_id,
    'globalId', next_row.${table.globalIdColumn},
    'row', to_jsonb(next_row)
  );
END;
$$;
`.trim();
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }

  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteText(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function qualified(schema, name) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

