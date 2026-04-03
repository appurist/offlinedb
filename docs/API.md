# API Reference

This document describes the current public API exported by `@appurist/offlinedb`.

Current exports from [src/index.js](C:/dev/appurist/offline/offlinedb/src/index.js):

- `OfflineDbClient`
- `IndexedDbPersistence`
- `InMemoryPersistence`
- `LocalStoragePersistence`
- `createNeonHttpTransport`
- `defineTable`
- `createOfflinedbInstallSql`
- `createSyncedTableSql`

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
  Optional list of registered table names to include in this sync pass.
  When omitted, the client syncs all registered tables.

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
  Optional table-name filter for the current sync pass.
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

- Accepted local ids are removed from the pending queue.
- Conflicted local ids are removed from the pending queue.
- If a conflict includes `serverRow`, that row replaces the local optimistic row.
- Incoming `changes` are applied to the local replica.
- A `null` row in `changes` deletes the local row.
- The returned `lastGlobalId` becomes the client's new high-water mark.

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

Creates a simple HTTP transport for the sync RPC endpoint.

```js
const transport = createNeonHttpTransport({
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
- Delete operations are only represented through remote `changes` entries with `row: null`; there is no dedicated local delete helper.
