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

