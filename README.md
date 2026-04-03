# @appurist/offlinedb

Browser-first offline table client for Neon Auth and Postgres Row Level Security.

- IndexedDB-friendly local replica abstraction
- Full local replica model with optional table-filtered sync
- Optimistic local changes with local ids and server-assigned global ids
- Neon-oriented HTTP transport contract
- SQL generators for mutation-log tables, triggers, RLS helpers, and per-table mutation RPCs

## Status

This repository is the first implementation scaffold for the new `offlinedb` direction.
It replaces the old client/server split for the Neon path with:

- direct authenticated client access
- Postgres RLS as the security model
- library-owned mutation RPCs as the consistency model
- local ids for offline writes and global ids for accepted replicated writes

## Install

```bash
pnpm add @appurist/offlinedb
```

## Usage

```js
import {
  OfflineDbClient,
  createNeonHttpTransport,
  defineTable
} from "@appurist/offlinedb";

const tasks = defineTable({
  name: "tasks",
  primaryKey: "id"
});

const client = await OfflineDbClient.open({
  persistence: "indexeddb",
  databaseName: "app-cache",
  transport: createNeonHttpTransport({
    baseUrl: "https://example.neon.tech/sql",
    getAuthToken: async () => "jwt"
  }),
  tables: [tasks]
});

await client.mutate({
  table: "tasks",
  key: "task-1",
  values: {
    title: "Write docs",
    done: false,
    owner_id: "user-1"
  }
});

await client.sync();
```

`sync()` now represents whole-replica convergence by default:

- local pending writes are sent with `localId`
- the remote side assigns `globalId` values to accepted writes
- the client advances `lastGlobalId` after applying accepted and remote changes
- `tables: [...]` is optional and only narrows one sync pass

## Public API

- `OfflineDbClient`
- `IndexedDbPersistence`
- `InMemoryPersistence`
- `LocalStoragePersistence`
- `defineTable`
- `createNeonHttpTransport`
- `createOfflinedbInstallSql`
- `createSyncedTableSql`

The full API reference lives in [`docs/API.md`](./docs/API.md).
That document describes:

- constructor/open options
- the persistence contract and the built-in `"indexeddb"`, `"localstorage"`, and `"memory"` selectors
- local-id/global-id mutation and sync request/response shapes
- table definition objects and full-replica sync behavior
- transport expectations
- SQL generator inputs and outputs

## Docs

- [`docs/API.md`](./docs/API.md)
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- [`docs/DECISIONS.md`](./docs/DECISIONS.md)
- [`docs/SQL.md`](./docs/SQL.md)

## Development

```bash
pnpm test
```
