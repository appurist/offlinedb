import assert from "node:assert/strict";
import test from "node:test";
import { OfflineDbClient, IndexedDbPersistence, defineTable } from "../src/index.js";

function okTransport(overrides = {}) {
  return {
    async sync() {
      return { accepted: [], conflicts: [], changes: [], lastGlobalId: 0, ...overrides };
    }
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("overlapping sync calls run one at a time and push each mutation once", async () => {
  const tasks = defineTable({ name: "tasks" });
  const pushed = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync(request) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pushed.push(...request.mutations.map((entry) => entry.localId));
        await new Promise((resolve) => {
          release = resolve;
        });
        inFlight -= 1;
        return {
          accepted: request.mutations.map((entry) => ({ localId: entry.localId, globalId: 1 })),
          conflicts: [],
          changes: [],
          lastGlobalId: 1
        };
      }
    },
    tables: [tasks],
    idFactory: () => "m1"
  });

  await client.mutate({ table: "tasks", key: "task-1", values: { owner_id: "user-1", title: "A" } });
  const first = client.sync();
  const second = client.sync();
  await tick();
  release();
  await first;
  await tick();
  release();
  await second;

  assert.equal(maxInFlight, 1);
  assert.deepEqual(pushed, ["m1"]);
});

test("an edit queued while its row is being pushed survives the accepted echo", async () => {
  const tasks = defineTable({ name: "tasks" });
  const ids = ["m1", "m2"];
  let editDuringPush = null;
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync(request) {
        if (editDuringPush) {
          const edit = editDuringPush;
          editDuringPush = null;
          await edit();
        }
        return {
          accepted: request.mutations.map((entry) => ({
            localId: entry.localId,
            globalId: 5,
            row: { ...entry.values, local_id: entry.localId, global_id: 5 }
          })),
          conflicts: [],
          changes: request.mutations.map((entry) => ({
            table: entry.table,
            key: entry.key,
            row: { ...entry.values, local_id: entry.localId, global_id: 5 }
          })),
          lastGlobalId: 5
        };
      }
    },
    tables: [tasks],
    idFactory: () => ids.shift()
  });

  await client.mutate({ table: "tasks", key: "task-1", values: { owner_id: "user-1", title: "first" } });
  editDuringPush = () => client.mutate({ table: "tasks", key: "task-1", values: { title: "second" } });
  await client.sync();

  const row = await client.get("tasks", "task-1");
  assert.equal(row.title, "second", "the newer local edit is kept");
  assert.equal(row.local_id, "m2");
  const pending = await client.persistence.getPendingMutations();
  assert.deepEqual(pending.map((entry) => entry.localId), ["m2"]);
  assert.equal(pending[0].baseRevision, 1, "the second edit builds on the first");
});

test("sync reports unique violations with the row and keeps the local copy", async () => {
  const tasks = defineTable({ name: "tasks" });
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: okTransport({
      conflicts: [{ localId: "m1", code: "23505", serverRow: null, message: "duplicate key value" }]
    }),
    tables: [tasks],
    idFactory: () => "m1"
  });

  await client.mutate({ table: "tasks", key: "task-1", values: { owner_id: "user-1", title: "dup" } });
  const result = await client.sync();

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].table, "tasks");
  assert.equal(result.conflicts[0].key, "task-1");
  assert.equal(result.conflicts[0].code, "23505");
  assert.equal(result.conflicts[0].message, "duplicate key value");
  assert.equal(result.conflicts[0].resolution, "kept_local");
  assert.equal((await client.get("tasks", "task-1")).title, "dup");
  assert.equal((await client.persistence.getPendingMutations()).length, 0, "the rejected write is not retried");
  const status = await client.getSyncStatus();
  assert.equal(status.errorCount, 1);
  const touched = await client.persistence.listTouchedRows(["tasks"]);
  assert.equal(touched[0].lastError, "23505");
});

test("a deleted conflict removes the stale local row", async () => {
  const tasks = defineTable({ name: "tasks" });
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: okTransport({
      conflicts: [{ localId: "m1", code: "deleted", serverRow: null }]
    }),
    tables: [tasks],
    idFactory: () => "m1"
  });

  await client.persistence.saveRow("tasks", "task-1", { id: "task-1", owner_id: "user-1", title: "old", revision: 3, local_id: null, global_id: 9 });
  await client.mutate({ table: "tasks", key: "task-1", values: { title: "edited offline" } });
  const result = await client.sync();

  assert.equal(result.conflicts[0].resolution, "deleted_local");
  assert.equal(await client.get("tasks", "task-1"), null);
});

test("a pulled change does not overwrite a row with a queued local change", async () => {
  const tasks = defineTable({ name: "tasks" });
  let calls = 0;
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync() {
        calls += 1;
        return {
          accepted: [],
          conflicts: [],
          changes: calls === 1
            ? [
              { table: "tasks", key: "task-1", row: { id: "task-1", owner_id: "user-1", title: "remote", revision: 2, local_id: null, global_id: 4 } },
              { table: "tasks", key: "task-2", row: { id: "task-2", owner_id: "user-1", title: "other", revision: 1, local_id: null, global_id: 3 } }
            ]
            : [],
          lastGlobalId: 4
        };
      }
    },
    tables: [tasks],
    idFactory: () => "m1"
  });

  // The transport accepts nothing, so m1 stays queued.
  await client.mutate({ table: "tasks", key: "task-1", values: { owner_id: "user-1", title: "local" } });
  await client.sync();

  assert.equal((await client.get("tasks", "task-1")).title, "local");
  assert.equal((await client.get("tasks", "task-2")).title, "other");
  assert.equal(await client.persistence.getLastGlobalId(), 4);
});

test("repairSync resets the cursor inside the sync queue", async () => {
  const tasks = defineTable({ name: "tasks" });
  const cursors = [];
  let release;
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync(request) {
        cursors.push(request.lastGlobalId);
        if (cursors.length === 1) {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return { accepted: [], conflicts: [], changes: [], lastGlobalId: 10 };
      }
    },
    tables: [tasks]
  });
  await client.persistence.setLastGlobalId(10);

  const regular = client.sync();
  await tick();
  const repair = client.repairSync({ includeAllLocalRows: false });
  await tick();
  release();
  await regular;
  await repair;

  assert.deepEqual(cursors, [10, 0], "the repair pull starts from 0 even though a sync was in flight");
  assert.equal(await client.persistence.getLastGlobalId(), 10);
});

test("IndexedDbPersistence keeps one connection, imports snapshots and can be closed", async () => {
  const tasks = defineTable({ name: "tasks" });
  const indexedDb = createFakeIndexedDb();
  let opens = 0;
  const countingIndexedDb = {
    open(name, version) {
      opens += 1;
      return indexedDb.open(name, version);
    }
  };

  const client = await OfflineDbClient.open({
    indexedDb: countingIndexedDb,
    databaseName: "one-connection",
    transport: okTransport(),
    tables: [tasks],
    idFactory: () => "m1"
  });
  await client.mutate({ table: "tasks", key: "task-1", values: { owner_id: "user-1", title: "A" } });
  await client.mutate({ table: "tasks", key: "task-2", values: { owner_id: "user-1", title: "B" } });
  assert.equal(opens, 1, "every read and write reuses the first connection");

  await client.close();
  await client.persistence.saveRow("tasks", "task-3", { id: "task-3" });
  assert.equal(opens, 2, "a closed persistence reopens on demand");

  const snapshot = await IndexedDbPersistence.readSnapshot({ indexedDb, databaseName: "one-connection" });
  assert.equal(snapshot.rows[0][1].length, 3);
  assert.equal(await IndexedDbPersistence.readSnapshot({ indexedDb, databaseName: "never-written" }), null);

  const copy = await OfflineDbClient.open({
    indexedDb,
    databaseName: "copy",
    transport: okTransport(),
    tables: [tasks]
  });
  await copy.persistence.importState({ ...snapshot, lastGlobalId: 0 });
  assert.equal((await copy.list("tasks")).length, 3);
  assert.equal(await copy.persistence.getLastGlobalId(), 0);
  const reopened = await OfflineDbClient.open({ indexedDb, databaseName: "copy", transport: okTransport(), tables: [tasks] });
  assert.equal((await reopened.list("tasks")).length, 3, "the imported state was persisted");
});

function createFakeIndexedDb() {
  const databases = new Map();

  return {
    open(name) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = createFakeDatabase();
          databases.set(name, db);
        }
        request.result = db;
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
}

function createFakeDatabase() {
  const stores = new Map();
  return {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      if (!stores.has(name)) stores.set(name, new Map());
    },
    close() {},
    transaction(name) {
      const store = stores.get(name);
      const tx = { error: null, oncomplete: null, onerror: null };
      tx.objectStore = () => ({
        get(key) {
          const request = { result: null, error: null, onsuccess: null, onerror: null };
          queueMicrotask(() => {
            request.result = store.get(key) ?? null;
            request.onsuccess?.();
            tx.oncomplete?.();
          });
          return request;
        },
        put(value, key) {
          store.set(key, JSON.parse(JSON.stringify(value)));
          queueMicrotask(() => tx.oncomplete?.());
        }
      });
      return tx;
    }
  };
}
