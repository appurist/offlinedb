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
    next_payload := to_jsonb(NEW);
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
    NEW.${table.revisionColumn} := COALESCE(NEW.${table.revisionColumn}, 0) + 1;
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

DROP POLICY IF EXISTS ${quoteIdentifier(`${table.name}_owner_write`)} ON ${tableName};
CREATE POLICY ${quoteIdentifier(`${table.name}_owner_write`)} ON ${tableName}
  FOR UPDATE
  USING (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}())
  WITH CHECK (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}());

DROP POLICY IF EXISTS ${quoteIdentifier(`${table.name}_owner_insert`)} ON ${tableName};
CREATE POLICY ${quoteIdentifier(`${table.name}_owner_insert`)} ON ${tableName}
  FOR INSERT
  WITH CHECK (${quoteIdentifier(table.ownerColumn)} = ${qualified(metadataSchema, "current_user_id")}());

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
  set_clause TEXT;
  upsert_sql TEXT;
  assigned_global_id BIGINT;
BEGIN
  SELECT *
  INTO existing_row
  FROM ${tableName}
  WHERE ${table.primaryKey}::TEXT = p_row_key
  FOR UPDATE;

  IF FOUND AND existing_row.${table.revisionColumn} <> p_base_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'revision_conflict',
      'row', to_jsonb(existing_row)
    );
  END IF;

  INSERT INTO ${qualified(metadataSchema, "applied_mutation")} (user_id, local_id, table_name, row_key)
  VALUES (${qualified(metadataSchema, "current_user_id")}(), p_local_id, ${quoteText(table.name)}, p_row_key)
  ON CONFLICT (user_id, local_id) DO NOTHING;

  INSERT INTO ${qualified(metadataSchema, "global_mutation")} (
    table_name,
    row_key,
    owner_id,
    local_id,
    revision,
    operation,
    row_data
  )
  VALUES (
    ${quoteText(table.name)},
    p_row_key,
    COALESCE(p_values ->> ${quoteText(table.ownerColumn)}, ${qualified(metadataSchema, "current_user_id")}()),
    p_local_id,
    COALESCE((p_values ->> ${quoteText(table.revisionColumn)})::BIGINT, p_base_revision + 1),
    CASE WHEN FOUND THEN 'update' ELSE 'insert' END,
    p_values
  )
  RETURNING global_id INTO assigned_global_id;

  UPDATE ${qualified(metadataSchema, "applied_mutation")}
  SET global_id = assigned_global_id
  WHERE user_id = ${qualified(metadataSchema, "current_user_id")}()
    AND local_id = p_local_id;

  SELECT string_agg(
    format('%1$I = EXCLUDED.%1$I', column_name),
    ', '
    ORDER BY ordinal_position
  )
  INTO set_clause
  FROM information_schema.columns
  WHERE table_schema = ${quoteText(schema)}
    AND table_name = ${quoteText(table.name)}
    AND column_name <> ${quoteText(table.primaryKey)};

  upsert_sql := format(
    'INSERT INTO %1$s SELECT * FROM jsonb_populate_record(NULL::%1$s, $1) ON CONFLICT (%2$I) DO UPDATE SET %3$s RETURNING *',
    ${quoteText(tableName)},
    ${quoteText(table.primaryKey)},
    set_clause
  );

  EXECUTE upsert_sql
    USING jsonb_set(
      jsonb_set(
        jsonb_set(
          p_values,
          ${quoteText(`{${table.localIdColumn}}`)},
          to_jsonb(p_local_id)
        ),
        ${quoteText(`{${table.ownerColumn}}`)},
        to_jsonb(COALESCE(p_values ->> ${quoteText(table.ownerColumn)}, ${qualified(metadataSchema, "current_user_id")}()))
      ),
      ${quoteText(`{${table.globalIdColumn}}`)},
      to_jsonb(assigned_global_id)
    )
    INTO next_row;

  RETURN jsonb_build_object(
    'ok', true,
    'localId', p_local_id,
    'globalId', assigned_global_id,
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
