# Decisions

## Chosen defaults

- Neon Auth is the initial auth target.
- Direct client-to-Neon access is the primary data path.
- The library is browser-first.
- The first data model is relational row/table sync, not a document abstraction.
- Every synced table must include a non-null owner column.
- Rows may be private or publicly readable, but only owners write in v1.
- Conflicts are explicit per-row revision conflicts.
- The library owns the mutation RPC path for synced writes.
- Sync is framed as local-id to global-id convergence against a global mutation log.

## Intentional non-goals for this pass

- Full Neon integration tests against a live database
- General-purpose SQL query caching
- Shared workspace role models beyond owner-centric tables
- Automatic conflict merging
