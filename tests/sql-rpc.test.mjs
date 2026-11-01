import assert from "node:assert/strict";
import test from "node:test";
import { createOfflinedbInstallSql, createSyncedTableSql } from "../src/index.js";

test("mutation rpc replays committed retries, deletes regardless of revision, and rejects edits to deleted rows", () => {
  const sql = createSyncedTableSql({ table: "tasks" });

  assert.match(sql, /SELECT global_id INTO applied_global_id\s+FROM "offlinedb"\."applied_mutation"/);
  assert.match(sql, /IF row_exists AND p_values IS NOT NULL AND existing_row\.revision <> p_base_revision THEN/);
  assert.match(sql, /gm\.operation = 'delete'/);
  assert.match(sql, /'code', 'deleted'/);
  assert.ok(sql.indexOf("applied_global_id") < sql.indexOf("'revision_conflict'"), "a replayed retry answers before the revision check");
  assert.ok(sql.indexOf("'code', 'deleted'") < sql.indexOf('INSERT INTO "offlinedb"."applied_mutation"'), "a rejected edit is not recorded as applied");

  const install = createOfflinedbInstallSql();
  assert.match(install, /CREATE INDEX IF NOT EXISTS "global_mutation_table_row_idx"/);
});
