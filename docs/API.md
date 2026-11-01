# API Reference

This document describes the current public API exported by `@appurist/offlinedb`.

Current exports from [src/index.js](C:/dev/appurist/offline/offlinedb/src/index.js):

- `OfflineDbClient`
- `IndexedDbPersistence`
- `InMemoryPersistence`
- `LocalStoragePersistence`
- `createNeonHttpTransport`
- `createOdbAuthClient`
- `createOdbDataClient`
- `createOdbSyncTransport`
- `defineTable`
- `createOfflinedbInstallSql`
- `createSyncedTableSql`

All Neon URLs used by these APIs are developer-supplied configuration.
The library does not embed project-specific Neon Auth or Data API endpoints.

## `OfflineDbClient`

Browser-first offline replication client.

### `OfflineDbClient.open(options)`

Initializes the provided persistence layer and returns a client instance.
If `persistence` is omitted, `open(...)` uses the `"indexeddb"` built-in automatically.

```js
const client = await OfflineDbClient.open({
  persistence: "indexeddb",
  databaseName: "app-cache",
  transport,
  tables
});
```

#### `options`

- `persistence`
  Optional persistence selector or persistence object.
  Supported built-in selectors are:
  - `"indexeddb"`
  - `"localstorage"`
  - `"memory"`
  You may also pass an object implementing the persistence contract documented below.
- `databaseName`
  Optional database/storage namespace used by the built-in persistence implementations.
  Defaults to `offlinedb`.
- `indexedDb`
  Optional IndexedDB factory override used by the `"indexeddb"` built-in.
- `localStorage`
  Optional localStorage override used by the `"localstorage"` built-in.
- `transport`
  Object with a `sync(request)` method returning a sync result.
- `tables`
  Array of table definitions created by `defineTable(...)`.
- `now`
  Optional clock function returning a `Date`.
  Used when creating optimistic local writes.
- `idFactory`
  Optional local-id generator.
  Defaults to `crypto.randomUUID()` when available.

### Instance methods

#### `await client.get(table, key)`

Returns one locally stored row or `null`.

```js
const task = await client.get("tasks", "task-1");
```

- `table`
  Registered table name.
- `key`
  Primary key value as a string.

#### `await client.list(table)`

Returns all locally stored rows for one registered table.

```js
const tasks = await client.list("tasks");
```

#### `await client.mutate(args)`

Creates an optimistic local change, applies it to the local replica, and appends it to the pending queue.

```js
const mutation = await client.mutate({
  table: "tasks",
  key: "task-1",
  values: {
    owner_id: "user-1",
    title: "Write docs"
  },
  metadata: {
    source: "ui"
  }
});
```

##### `args`

- `table`
  Registered table name.
- `key`
  Primary key value for the target row.
- `values`
  Full or partial row object to merge into the current local row.
  The client also injects:
  - the table primary key field
  - the next optimistic revision
  - the updated-at column
  - the new local id
  - `global_id = 0`
- `metadata`
  Optional metadata preserved in the queued change object.

##### Return value

Returns a pending change object with:

- `localId`
- `globalId`
- `clientSequence`
- `table`
- `key`
- `baseRevision`
- `values`
- `occurredAt`
- `metadata`

#### `await client.sync(options?)`

Pushes pending local changes and pulls remote changes through the configured transport.

```js
const result = await client.sync();
```

##### `options`

- `tables`
  Optional list of registered table names. They are validated and forwarded
  to the transport, but the pull is never narrowed: the client keeps one
  `lastGlobalId` for all tables, and a pull limited to some tables would
  advance that cursor past changes in the others.

##### Request sent to transport

The client calls:

```js
await transport.sync({
  mutations,
  tables,
  lastGlobalId
});
```

Where:

- `mutations`
  The current pending local-change queue, sorted by `clientSequence`.
- `tables`
  The registered table names for this pass (informational; see above).
- `lastGlobalId`
  The client's last applied global id.

##### Expected transport response

The transport must return:

```js
{
  accepted: [
    {
      localId: "m1",
      globalId: 12
    }
  ],
  conflicts: [
    {
      localId: "m2",
      code: "revision_conflict",
      serverRow: { ... } // or null
    }
  ],
  changes: [
    {
      table: "tasks",
      key: "task-1",
      row: { ... } // or null to delete locally
    }
  ],
  lastGlobalId: 12
}
```

##### Sync behavior

- Syncs run one at a time per client. A `sync()` or `repairSync()` call made while another is in flight waits for it, so the same pending mutations are never pushed twice.
- Accepted local ids are removed from the pending queue.
- Conflicted local ids are removed from the pending queue.
- If a conflict includes `serverRow`, that row replaces the local optimistic row.
- A conflict with `code: "deleted"` (the server already deleted the row) removes the local row.
- A conflict with any other code and no `serverRow` (for example a Postgres `23505` unique violation) leaves the local row as it is; it is marked as a touched row with `lastError` set to the code, and `getSyncStatus().errorCount` counts such rows.
- A row that received a newer local change while the push was in flight is not overwritten by the server's echo of the older change, nor by a conflict for it; the newer change settles the row when it is pushed.
- Incoming `changes` are applied to the local replica; changes for tables this client did not register, and changes for rows that still have a pending local mutation, are ignored.
- A `null` row in `changes` deletes the local row.
- The returned `lastGlobalId` becomes the client's new high-water mark.

##### Return value

The transport's result, with each conflict extended by `table`, `key` and `resolution`:

- `"server_row"`: the server's row replaced the local one
- `"deleted_local"`: the local row was removed
- `"kept_local"`: the local row was left unchanged (the write was rejected without a server row)
- `"superseded"`: a newer local change for the row is still queued

#### `await client.getSyncStatus(options?)`

Returns `{ pendingCount, touchedCount, errorCount, lastGlobalId }` for the given `tables` (default: all).

#### `await client.close()`

Releases the persistence layer's resources (the IndexedDB connection). The client must not be used afterwards.

#### `await client.exportState()`

Returns the persistence snapshot from the configured persistence layer.
With the built-in persistence implementations this includes:

- `clientSequence`
- `lastGlobalId`
- `pending`
- `rows`

## Persistence Contract

The client currently expects a persistence object with these async methods:

- `initialize()`
- `nextClientSequence()`
- `getRow(table, key)`
- `listRows(table)`
- `saveRow(table, key, row)`
- `deleteRow(table, key)`
- `appendPendingMutation(mutation)`
- `getPendingMutations()`
- `acknowledgeMutations(localIds)`
- `getLastGlobalId()`
- `setLastGlobalId(lastGlobalId)`
- `exportState()`

The behavior expected from that contract is:

- rows are stored by table name and row key
- pending mutations are returned sorted by `clientSequence`
- `acknowledgeMutations()` removes queued mutation ids
- `setLastGlobalId()` replaces the current high-water mark
- `exportState()` returns a serializable snapshot of the persistence layer

## `IndexedDbPersistence`

Browser persistence implementation backing the `"indexeddb"` built-in.

```js
const persistence = new IndexedDbPersistence({
  databaseName: "app-cache"
});
```

### Constructor options

- `databaseName`
  Optional IndexedDB database name.
  Defaults to `offlinedb`.
- `indexedDb`
  Optional IndexedDB factory override.

### Behavior

- wraps an in-memory working set and persists snapshots into IndexedDB
- creates a single object store named `state`
- stores the full persistence snapshot under the key `snapshot`
- loads the snapshot during `initialize()`
- persists after every mutating operation
- keeps one open connection, reopened on demand after `close()` or after another tab asks for a version change

### Additional methods

- `await persistence.importState(snapshot)`
  Replaces the whole local state with a snapshot and persists it.
- `await persistence.close()`
  Closes the IndexedDB connection.
- `await IndexedDbPersistence.readSnapshot({ databaseName, indexedDb? })`
  Static. Reads the stored snapshot of a database without keeping it open; `null` when nothing was stored. Together with `importState` this moves a replica from one database name to another (for example from a shared database to a per-user one).

`IndexedDbPersistence` is the default because it matches the browser-first, local-replica model of the library more closely than an in-memory-only store.

## `LocalStoragePersistence`

Simple browser persistence implementation backing the `"localstorage"` built-in.

```js
const persistence = new LocalStoragePersistence({
  storageKey: "app-cache:snapshot"
});
```

### Constructor options

- `storageKey`
  Optional localStorage key used for the serialized snapshot.
  Defaults to `offlinedb:snapshot`.
- `localStorage`
  Optional localStorage-compatible override.

### Behavior

- wraps an in-memory working set
- serializes the full snapshot into one localStorage entry
- loads the snapshot during `initialize()`
- persists after every mutating operation

This is simpler than IndexedDB but less suitable for larger local replicas.

## `InMemoryPersistence`

Reference in-memory persistence implementation used by the current tests and examples.

```js
const persistence = new InMemoryPersistence();
```

### Behavior

- keeps one global sync `lastGlobalId` in process memory
- keeps one `lastGlobalId` value in process memory
- keeps all rows and pending mutations in process memory
- does not survive page reloads or process restarts
- remains useful for tests, examples, and non-browser flows

## `createNeonHttpTransport(options)`

Creates a simple HTTP transport for a developer-supplied HTTP sync endpoint.

This helper still exists in the scaffold, but the intended Neon-native direction is direct Neon Auth and Data API calls via the `odb*` clients below rather than an app-owned sync service.

```js
const transport = createNeonHttpTransport({
  // Supplied by the app.
  baseUrl: "https://example.neon.tech/sql",
  getAuthToken: async () => sessionToken
});
```

### `options`

- `baseUrl`
  Base URL used to build the sync endpoint URL.
- `fetchImpl`
  Optional fetch implementation.
  Defaults to global `fetch`.
- `getAuthToken`
  Optional function or value used to populate the `Authorization` header.
  When it returns a token, the transport sends `Authorization: Bearer <token>`.
- `syncPath`
  Optional relative path appended to `baseUrl`.
  Defaults to `rpc/offlinedb_sync`.

### Behavior

- Sends `POST` with `content-type: application/json`
- Serializes the sync request body as JSON
- Throws when the HTTP response is not `2xx`
- Returns `await response.json()`

## `createOdbAuthClient(options)`

Creates direct Neon Auth wrappers using `odb*` method names.

```js
const auth = createOdbAuthClient({
  baseUrl: appConfig.neonAuthUrl
});
```

### `options`

- `baseUrl`
  Developer-supplied Neon Auth base URL.
- `fetchImpl`
  Optional fetch implementation.
- `endpoints`
  Optional endpoint overrides for auth routes.

### Methods

- `odbLoginWithPassword({ email, password, rememberMe?, callbackURL? })`
- `odbSignUpWithPassword({ email, password, name?, callbackURL?, image? })`
- `odbLogout()`

## `createOdbDataClient(options)`

Creates direct Neon Data API wrappers using `odb*` method names.

```js
const data = createOdbDataClient({
  baseUrl: appConfig.neonDataUrl,
  getAuthToken: async () => sessionToken
});
```

### `options`

- `baseUrl`
  Developer-supplied Neon Data API or SQL base URL.
- `fetchImpl`
  Optional fetch implementation.
- `getAuthToken`
  Optional async token provider.
- `headers`
  Optional default headers.
- `timeoutMs`
  Optional request timeout in milliseconds, default `30000`. A request that has not answered in time is aborted and rejects with an `OdbTimeoutError`, so a stalled connection fails the sync instead of hanging it. `0` disables the timeout.

### Methods

- `odbRequest({ path, method?, body?, headers? })`
- `odbRpc(functionName, args?)`

## `createOdbSyncTransport(options)`

Creates a direct-Neon sync transport that calls database RPC functions through `createOdbDataClient()`.

```js
const data = createOdbDataClient({
  baseUrl: appConfig.neonDataUrl,
  getAuthToken: async () => sessionToken
});

const transport = createOdbSyncTransport({
  dataClient: data
});
```

### `options`

- `dataClient`
  Data client created by `createOdbDataClient()`.
- `mutateFunctionName`
  Optional function-name override or name resolver for per-table mutate RPCs.
  Defaults to `mutate_<table>`.
- `pullFunctionName`
  Optional pull RPC name.
  Defaults to `pull_changes`.

### Behavior

- calls `mutate_<table>` once per pending local change
- an RPC answer with `ok: false` becomes a conflict with its `code` (`revision_conflict`, `deleted`, `forbidden`)
- an HTTP 409 or a `23505` unique violation from the database becomes a conflict with the SQLSTATE as `code` and the database's `details` or `message` as `message`; the rest of the queue is still pushed
- any other HTTP error aborts the sync
- then calls `pull_changes_page(lastGlobalId)` (falling back to `pull_changes`) for every table, never narrowed by `tables`
- returns the normalized sync result expected by `OfflineDbClient`

This is the intended browser runtime path for the Neon-native version of the library.

## `defineTable(input)`

Creates a normalized table definition object.

```js
const tasks = defineTable({
  name: "tasks",
  primaryKey: "id",
  ownerColumn: "owner_id",
  revisionColumn: "revision",
  updatedAtColumn: "updated_at",
  localIdColumn: "local_id",
  globalIdColumn: "global_id"
});
```

### `input`

- `name`
  Required SQL-style identifier.
- `primaryKey`
  Optional, defaults to `id`.
- `ownerColumn`
  Optional, defaults to `owner_id`.
- `revisionColumn`
  Optional, defaults to `revision`.
- `updatedAtColumn`
  Optional, defaults to `updated_at`.
- `localIdColumn`
  Optional, defaults to `local_id`.
- `globalIdColumn`
  Optional, defaults to `global_id`.

### Return value

Returns a frozen object:

```js
{
  kind: "table",
  name,
  primaryKey,
  ownerColumn,
  revisionColumn,
  updatedAtColumn,
  localIdColumn,
  globalIdColumn
}
```

All identifiers must match the current validation rule:

```txt
/^[A-Za-z_][A-Za-z0-9_]*$/
```

## `createOfflinedbInstallSql(options?)`

Generates SQL for the shared metadata schema.

```js
const sql = createOfflinedbInstallSql();
```

```js
const sql = createOfflinedbInstallSql({
  schema: "offlinedb"
});
```

### `options`

- `schema`
  Metadata schema name.
  Defaults to `offlinedb`.

### Generated objects

The current output includes:

- metadata schema creation
- `global_mutation` table
- `applied_mutation` table
- `current_user_id()` function
- `record_change()` trigger function

### Current assumptions

- `current_user_id()` resolves the user from JWT claim settings in Postgres.
- `record_change()` expects synced tables to expose:
  - `id`
  - `local_id`
  - `owner_id`
  - `revision`

That expectation is important because the helper is intentionally narrow in this first scaffold.

## `createSyncedTableSql(options)`

Generates SQL to prepare one app table for `offlinedb`.

```js
const sql = createSyncedTableSql({
  table: defineTable({ name: "tasks" })
});
```

```js
const sql = createSyncedTableSql({
  schema: "public",
  metadataSchema: "offlinedb",
  table: defineTable({
    name: "tasks",
    primaryKey: "id"
  })
});
```

### `options`

- `table`
  Required table definition object or table name string.
- `schema`
  App-table schema name.
  Defaults to `public`.
- `metadataSchema`
  Metadata schema containing helper functions.
  Defaults to `offlinedb`.

### Generated SQL responsibilities

The current generator emits SQL for:

- required sync metadata columns
- owner/global-id index
- revision and updated-at trigger function
- global-mutation capture trigger
- owner-write insert/update RLS policies
- a table-specific mutation RPC function named like `offlinedb.mutate_tasks`

The mutation RPC:

- answers a retry of a mutation it has already applied (same user and `localId`, found in `applied_mutation`) with the same `ok` result instead of applying it again
- rejects an upsert whose `p_base_revision` differs from the row's current revision with `revision_conflict` and the current row
- applies a delete (`NULL` payload) whatever the row's revision, and accepts a delete of a row that is already gone
- rejects an upsert for a row the client once held (`p_base_revision` above 0) that the server has since deleted with `code: "deleted"`, so the client drops its stale copy instead of resurrecting the row
- writes only the columns present in the payload, so columns the client does not send keep their defaults

### Current caveats

- The table must use a single primary key column.
- The generated mutation RPC expects a full next-row payload in `p_values`.
- Accepted writes are assigned a server-side `globalId`.
- Public-read policies are not yet generated automatically.
- The shared `record_change()` helper currently assumes column names compatible with the default owner/id/local_id/revision pattern.

## Current limitations of the public API

These are real current limits of the implementation:

- There is no built-in subscription API yet.
- There is no exported TypeScript typing surface.
- There is no finalized live Neon wire contract in this repo yet.
- `client.delete()` removes the row locally and queues a `NULL`-payload mutation; the generated `mutate_<table>` RPC applies it as a delete, and other clients receive it as a `changes` entry with `row: null`.
- The built-in persistence layers write the whole snapshot on every change and hold one snapshot per database name. Two tabs open on the same database overwrite each other's snapshot; give each user their own `databaseName` and keep one tab active per database.
- The pull cursor is the highest `global_id` seen. Two writers committing at the same moment can commit out of `global_id` order, so a change with a lower id than one already pulled is missed until the next `repairSync()`. Single-user data (one writer at a time per owner) is not affected.
