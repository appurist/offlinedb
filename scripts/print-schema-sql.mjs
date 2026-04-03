import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createOfflinedbInstallSql, createSyncedTableSql, defineTable } from "../src/index.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(root, "offlinedb.schema.json");
const config = JSON.parse(await readFile(configPath, "utf8"));

const sqlParts = [
  createOfflinedbInstallSql({
    schema: config.metadataSchema ?? "offlinedb"
  })
];

for (const tableConfig of config.tables ?? []) {
  sqlParts.push(`
CREATE TABLE IF NOT EXISTS "${config.schema ?? "public"}"."${tableConfig.name}" (
  "${tableConfig.primaryKey ?? "id"}" TEXT PRIMARY KEY
);`.trim());
  sqlParts.push(createSyncedTableSql({
    schema: config.schema ?? "public",
    metadataSchema: config.metadataSchema ?? "offlinedb",
    table: defineTable(tableConfig)
  }));
}

process.stdout.write(`${sqlParts.join("\n\n")}\n`);
