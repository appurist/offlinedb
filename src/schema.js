/**
 * @typedef {{
 *   name: string,
 *   primaryKey?: string,
 *   ownerColumn?: string,
 *   revisionColumn?: string,
 *   updatedAtColumn?: string,
 *   localIdColumn?: string,
 *   globalIdColumn?: string
 * }} TableDefinitionInput
 */

/**
 * @param {TableDefinitionInput} input
 */
export function defineTable(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Table definition must be an object.");
  }

  const name = assertIdentifier(input.name, "table name");
  return Object.freeze({
    kind: "table",
    name,
    primaryKey: assertIdentifier(input.primaryKey ?? "id", "primary key"),
    ownerColumn: assertIdentifier(input.ownerColumn ?? "owner_id", "owner column"),
    revisionColumn: assertIdentifier(input.revisionColumn ?? "revision", "revision column"),
    updatedAtColumn: assertIdentifier(input.updatedAtColumn ?? "updated_at", "updated_at column"),
    localIdColumn: assertIdentifier(input.localIdColumn ?? "local_id", "local id column"),
    globalIdColumn: assertIdentifier(input.globalIdColumn ?? "global_id", "global id column")
  });
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }

  return value;
}
