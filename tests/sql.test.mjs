import assert from "node:assert/strict";
import test from "node:test";
import {
  createOfflinedbInstallSql,
  createSyncedTableSql,
  defineTable
} from "../src/index.js";

test("install sql includes metadata schema and helper functions", () => {
  const sql = createOfflinedbInstallSql();

  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS "offlinedb"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "offlinedb"\."global_mutation"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "offlinedb"\."applied_mutation"/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION "offlinedb"\."record_change"/);
  assert.match(sql, /next_payload := to_jsonb\(NEW\) - 'global_id';/);
  assert.match(sql, /INSERT INTO "offlinedb"\."global_mutation" \(/);
  assert.match(sql, /INSERT INTO "offlinedb"\."global_mutation" \(\s*table_name,/);
});

test("synced table sql includes required columns, triggers, RLS, and mutation rpc", () => {
  const sql = createSyncedTableSql({
    table: defineTable({ name: "tasks" })
  });

  assert.match(sql, /ALTER TABLE "public"\."tasks"/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "owner_id" TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "local_id" TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "global_id" BIGINT NOT NULL DEFAULT 0/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE POLICY "tasks_owner_select"/);
  assert.match(sql, /FOR SELECT/);
  assert.match(sql, /CREATE POLICY "tasks_owner_insert"/);
  assert.match(sql, /CREATE POLICY "tasks_owner_write"/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /CREATE POLICY "tasks_owner_delete"/);
  assert.match(sql, /FOR DELETE/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION "offlinedb"\."mutate_tasks"/);
  assert.match(sql, /revision_conflict/);
});


test("synced table sql keeps the client's revision on insert, deletes on a NULL payload, and writes only payload columns", () => {
  const sql = createSyncedTableSql({
    table: defineTable({ name: "tasks" })
  });

  assert.match(sql, /IF COALESCE\(NEW\.revision, 0\) <= 0 THEN\s+NEW\.revision := 1;/);
  assert.doesNotMatch(sql, /NEW\.revision := COALESCE\(NEW\.revision, 0\) \+ 1/);
  assert.match(sql, /row_exists := FOUND;/);
  assert.match(sql, /IF p_values IS NULL THEN\s+IF row_exists THEN\s+DELETE FROM "public"\."tasks"/);
  assert.match(sql, /AND payload \? column_name::TEXT/);
  assert.match(sql, /INSERT INTO %1\$s \(%2\$s\) SELECT %2\$s FROM jsonb_populate_record/);
});
