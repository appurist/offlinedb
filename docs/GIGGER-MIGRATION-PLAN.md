# Gigger Offlinedb Migration Plan

## Summary

Replace Gigger's current LokiDB plus API-driven offline sync for user-owned data with `offlinedb`, while preserving Gigger's existing frontend service surface during the first migration.

The first migration covers:

- `user_songs`
- `user_setlists`
- `user_gigs`
- new `user_views`

It does not replicate `master_songs` offline. Master-song lookup remains online-only and is used only to prime `user_songs` rows when a user adds a song.

Gigger will move from "cloud authoritative, local cache" for these entities to "local primary replica with direct Neon sync," using Neon Auth plus direct Neon Data API calls through `offlinedb`.

## Key Changes

### Data model and database

- Add `offlinedb` metadata and sync functions to the Gigger Neon project.
- Adapt `user_songs`, `user_setlists`, and `user_gigs` to the `offlinedb` contract by adding the required sync metadata columns:
  - owner column remains `user_id`
  - revision column
  - updated-at column
  - local-id column
  - global-id column
- Add a new `user_views` table as a user-owned synced table with:
  - `id`
  - `user_id`
  - `name`
  - `config JSONB`
  - `created_at`
  - `updated_at`
  - `revision`
  - `local_id`
  - `global_id`
- Generate and install `offlinedb` mutate/pull functions for all four user-owned tables.
- Keep existing public/master tables such as `master_songs` outside `offlinedb` for now.

### Gigger frontend integration

- Preserve `gigger/src/services/database.js` as the migration seam.
- Reimplement the user-data portions of `database.js` on top of `offlinedb` instead of Loki collections and Pages CRUD calls.
- `database.js` remains the API consumed by pages during the first migration, so page churn stays low.
- Replace LokiDB persistence for migrated entities with `offlinedb` IndexedDB persistence.
- Remove the current user-data sync routines from the primary path:
  - `syncSongsWithCloud`
  - `syncSetlistsWithCloud`
  - `syncGigsWithCloud`
- Replace them with `offlinedb`-backed load/mutate/sync behavior while keeping function names or equivalent service-level semantics stable where needed for existing pages.

### Auth and Neon access

- Keep Gigger's existing Neon Auth service as the source of identity.
- Wire `database.js` to use `offlinedb` with:
  - developer-supplied Neon Auth URL
  - developer-supplied Neon Data API URL
  - JWT token from the existing auth service
- Do not add an app-owned sync backend.
- Keep current Cloudflare Pages CRUD endpoints for `user-songs`, `user-setlists`, and `user-gigs` temporarily, but remove them from the frontend's primary CRUD path.

### Entity-specific behavior

- `user_songs`
  - Treat the row as the single synced record.
  - Fold current song-adjacent editable data into the song row for the first migration rather than introducing extra synced tables.
  - Master-song selection remains online-only; adding a master song creates or updates a local `user_songs` row with the selected data.
- `user_setlists`
  - Continue storing ordered `song_ids` in the row.
  - Sync setlists as standalone owned rows.
- `user_gigs`
  - Continue storing `setlist_id` as a row reference.
  - Sync gigs as standalone owned rows.
- `user_views`
  - Move current local-only views into the new synced user table.
- Leave current purely public/shared read flows outside this migration:
  - master-song search and fetch
  - profile/subscription/roles
  - admin flows
  - library/discogs data

### Conflict handling

- Use library-managed auto-retry with the latest server row as the new base.
- The library should attempt deterministic reconciliation internally and keep conflicts out of normal Gigger page UX.
- `database.js` may retain a structured internal result shape for diagnostics, but the first migration should not require user-facing conflict UI.
- Do not preserve Gigger's current timestamp last-write-wins logic as the primary sync rule.

## Public Interfaces and Service Contracts

- `offlinedb` remains the underlying runtime and direct-Neon sync layer.
- Gigger keeps its existing `database.js` facade as the app-level API for the first migration.
- The `database.js` contract should remain stable for the main page consumers of:
  - song list/detail load
  - song create/update/delete
  - setlist create/update/delete
  - gig create/update/delete
  - view create/update/delete
- `database.js` should become the place that:
  - opens the `offlinedb` client
  - maps Gigger entities to `offlinedb` tables
  - triggers sync
  - performs online master-song priming into `user_songs`
- Gigger auth should continue to expose token access usable by `offlinedb` Neon data calls.

## Test Plan

- Database migration tests or verification:
  - `user_songs`, `user_setlists`, `user_gigs` gain required `offlinedb` metadata columns
  - `user_views` is created with correct ownership and sync metadata
  - RLS still enforces owner-only writes
  - `offlinedb` mutate/pull functions exist for all migrated tables
- Frontend service tests:
  - `database.js` loads songs/setlists/gigs/views from `offlinedb`
  - local mutations persist offline in IndexedDB
  - sync assigns global IDs and clears pending mutations
  - adding a master song online primes a `user_songs` row without requiring offline master-song replication
- Integration scenarios:
  - user edits songs offline, reconnects, and sync completes
  - two devices edit the same user row and library auto-retry converges without page-level conflict UI
  - setlist reorder and gig edits sync correctly
  - views created on one device appear on another after sync
- Regression checks:
  - existing pages using `database.js` continue to function without direct page-level `offlinedb` adoption
  - current auth flow still provides the JWT needed for direct Neon access
  - Pages CRUD endpoints can remain deployed without being the primary frontend path

## Assumptions and Defaults

- First migration is limited to user-owned data, not public/master data replication.
- `master_songs` remains online-only and is only used to seed `user_songs`.
- `database.js` is preserved as the Gigger integration seam for the first migration.
- LokiDB is retired for migrated entities rather than mirrored alongside `offlinedb`.
- Song-adjacent editable data is folded into `user_songs` for now.
- `user_views` is added as a new synced Neon table in the first migration.
- Existing Pages CRUD endpoints remain temporarily but are no longer the primary frontend data path.
- Conflict resolution is handled internally by the library via auto-retry, not by user-facing conflict UI.
