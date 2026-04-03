# Architecture

`offlinedb` is a browser-first offline replication library for Neon Auth and Postgres RLS.

## Core model

- App tables remain ordinary Postgres tables.
- Every synced table has a non-null owner column.
- Security is enforced by Postgres RLS, not by a separate library ACL layer.
- Writes flow through library-owned SQL functions so revision checks and local-id/global-id assignment stay consistent.
- The default client model is a full local replica for all synced tables the user can read.
- Sync can be limited to selected tables as an optimization, but whole-replica sync is the default.

## Runtime flow

1. App code defines synced tables.
2. The client stores a local replica plus a pending local-change log.
3. Local writes apply optimistically to the replica and receive a client-assigned `localId`.
4. `sync()` sends pending changes plus the client's `lastGlobalId`.
5. Server-side SQL functions validate each change, assign accepted changes a global `globalId`, and record them in the global mutation log.
6. The remote side returns accepted local/global id mappings, conflicts, changed rows, and a new `lastGlobalId`.
7. The client updates the local replica, clears acknowledged local changes, and advances its global high-water mark.

## Security boundary

- Neon Auth session state identifies the current user.
- Database functions resolve the current user from JWT claims.
- RLS policies decide row visibility and writability.
- The library assumes owner-write behavior and optional public readability.
