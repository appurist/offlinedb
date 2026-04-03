import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createOfflinedbInstallSql, createSyncedTableSql, defineTable } from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

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

const sql = `${sqlParts.join("\n\n")}\n`;

await new Promise((resolvePromise, rejectPromise) => {
  const child = spawn("psql", [databaseUrl, "-v", "ON_ERROR_STOP=1"], {
    stdio: ["pipe", "inherit", "inherit"]
  });
  child.stdin.end(sql);
  child.on("error", rejectPromise);
  child.on("exit", (code) => {
    if (code === 0) {
      resolvePromise();
      return;
    }

    rejectPromise(new Error(`psql exited with code ${code}`));
  });
});

console.log(`Applied offlinedb schema from ${configPath}`);
