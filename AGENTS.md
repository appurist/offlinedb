# Repository Guidelines

## Project Structure & Module Organization

This is an ESM JavaScript package for browser-first offline database sync. Core library code lives in `src/`:

- `src/index.js` exports the public API.
- `src/client.js`, `src/schema.js`, `src/sql.js`, and `src/neon.js` contain the client, table definitions, SQL generation, and Neon transport helpers.
- `tests/*.test.mjs` contains Node test runner coverage for client behavior, SQL generation, and Neon integration helpers.
- `scripts/` contains schema installation utilities.
- `docs/` contains API, architecture, SQL, and design-decision notes.
- `offlinedb.schema.json` is the default synced-table config used by the schema scripts.

## Build, Test, and Development Commands

Use `pnpm` for package scripts.

- `pnpm test` runs all tests with `node --test --test-isolation=none`.
- `pnpm run db:print-sql` prints generated install SQL from `offlinedb.schema.json`.
- `pnpm run db:apply` applies generated SQL with `psql`; set `DATABASE_URL` first.
- `pnpm publish --access public` is wrapped by `pnpm run release` for package publication.

Example on Windows PowerShell:

```powershell
$env:DATABASE_URL="postgresql://..."
pnpm run db:apply
```

## Coding Style & Naming Conventions

Write modern ESM JavaScript. Use two-space indentation, double quotes, semicolons, and named exports matching existing source files. Prefer small functions and plain objects over heavy abstractions. Public API names use clear PascalCase for classes such as `OfflineDbClient` and camelCase for functions such as `defineTable`.

Keep runtime code browser-compatible unless a file is explicitly a Node-only script or test. Avoid adding dependencies unless they materially simplify a shared behavior.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Place tests in `tests/` with the `*.test.mjs` suffix. Name test cases by behavior, for example `sync acknowledges accepted mutations and applies remote changes`.

Add or update focused tests for client state transitions, SQL output changes, schema parsing, and transport contracts. Run `pnpm test` before submitting changes.

## Commit & Pull Request Guidelines

Recent commits use short imperative or descriptive summaries, for example `Fixed the mutation trigger...` and `Add Neon-native auth...`. Keep commit messages concise and specific to the behavior changed.

Pull requests should include a brief summary, testing performed, and any schema or SQL migration impact. Link related issues when available. For database changes, include generated SQL notes or point reviewers to affected docs.

## Security & Configuration Tips

Never commit real `DATABASE_URL` values, Neon tokens, or application secrets. Admin connection strings are for schema installation only and must not be used by browser runtime code. Review RLS policy changes carefully and document app-specific grants in `docs/`.
