# SQL Helpers

`src/sql.js` currently generates two SQL bundles.

## `createOfflinedbInstallSql()`

Creates metadata objects under the `offlinedb` schema:

- `global_mutation`
- `applied_mutation`
- `current_user_id()`
- `record_change()`

## `createSyncedTableSql()`

Generates per-table SQL for:

- required sync metadata columns
- revision/update trigger
- global-mutation trigger
- owner-scoped RLS policies for `SELECT`, `INSERT`, `UPDATE`, and `DELETE`
- a table-specific mutation RPC function

## Caveats

This is the first scaffold, not the final migration system.
The generated SQL is intentionally narrow:

- it assumes owner-centric tables
- it assumes a single primary key column
- it generates a table-specific mutation function
- it expects the mutation payload to contain the full next row image
- it uses `local_id` and `global_id` columns to represent unsynced and globally accepted writes
- it does not yet generate public-read, admin-read, or admin-write policies automatically
- it does not configure grants, exposed schemas, CORS, or other Neon platform settings



