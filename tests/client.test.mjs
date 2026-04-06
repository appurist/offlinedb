import assert from "node:assert/strict";
import test from "node:test";
import {
  OfflineDbClient,
  IndexedDbPersistence,
  InMemoryPersistence,
  LocalStoragePersistence,
  defineTable
} from "../src/index.js";

test("mutate stores optimistic row and queues pending mutation", async () => {
  const tasks = defineTable({ name: "tasks" });
  const client = await OfflineDbClient.open({
    persistence: new InMemoryPersistence(),
    transport: {
      async sync() {
        throw new Error("not used");
      }
    },
    tables: [tasks],
    now: () => new Date("2026-04-03T12:00:00.000Z"),
    idFactory: () => "m1"
  });

  const mutation = await client.mutate({
    table: "tasks",
    key: "task-1",
    values: {
      owner_id: "user-1",
      title: "Write docs"
    }
  });

  assert.equal(mutation.baseRevision, 0);
  assert.equal(mutation.localId, "m1");
  assert.equal(mutation.globalId, 0);
  assert.equal(mutation.clientSequence, 1);
  const row = await client.get("tasks", "task-1");
  assert.equal(row.title, "Write docs");
  assert.equal(row.revision, 1);
  assert.equal(row.local_id, "m1");
  assert.equal(row.global_id, 0);
});

test("sync acknowledges accepted mutations and applies remote changes", async () => {
  const tasks = defineTable({ name: "tasks" });
  const persistence = new InMemoryPersistence();
  const requests = [];
  const client = await OfflineDbClient.open({
    persistence,
    transport: {
      async sync(request) {
        requests.push(request);
        return {
          accepted: [
            {
              localId: "m1",
              globalId: 12
            }
          ],
          conflicts: [],
          changes: [
            {
              table: "tasks",
              key: "task-1",
              row: {
                id: "task-1",
                owner_id: "user-1",
                title: "Remote title",
                revision: 2,
                updated_at: "2026-04-03T13:00:00.000Z",
                local_id: null,
                global_id: 12
              }
            }
          ],
          lastGlobalId: 12
        };
      }
    },
    tables: [tasks],
    now: () => new Date("2026-04-03T12:00:00.000Z"),
    idFactory: () => "m1"
  });

  await client.mutate({
    table: "tasks",
    key: "task-1",
    values: {
      owner_id: "user-1",
      title: "Local title"
    }
  });

  const result = await client.sync();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].tables, ["tasks"]);
  assert.equal(requests[0].lastGlobalId, 0);
  assert.equal(result.accepted[0].globalId, 12);
  const row = await client.get("tasks", "task-1");
  assert.equal(row.title, "Remote title");
  assert.equal((await persistence.getPendingMutations()).length, 0);
  assert.equal(await persistence.getLastGlobalId(), 12);
});

test("sync overwrites optimistic row with conflict server row", async () => {
  const tasks = defineTable({ name: "tasks" });
  const client = await OfflineDbClient.open({
    persistence: new InMemoryPersistence(),
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [
            {
              localId: "m1",
              code: "revision_conflict",
              serverRow: {
                id: "task-1",
                owner_id: "user-1",
                title: "Server wins",
                revision: 4,
                updated_at: "2026-04-03T13:00:00.000Z",
                local_id: null,
                global_id: 22
              }
            }
          ],
          changes: [],
          lastGlobalId: 22
        };
      }
    },
    tables: [tasks],
    now: () => new Date("2026-04-03T12:00:00.000Z"),
    idFactory: () => "m1"
  });

  await client.mutate({
    table: "tasks",
    key: "task-1",
    values: {
      owner_id: "user-1",
      title: "Local title"
    }
  });

  await client.sync();

  const row = await client.get("tasks", "task-1");
  assert.equal(row.title, "Server wins");
});

test("open defaults to IndexedDbPersistence when indexedDB is available", async () => {
  const tasks = defineTable({ name: "tasks" });
  const indexedDb = createFakeIndexedDb();
  const client = await OfflineDbClient.open({
    indexedDb,
    databaseName: "test-db",
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 0
        };
      }
    },
    tables: [tasks],
    now: () => new Date("2026-04-03T12:00:00.000Z"),
    idFactory: () => "m-default"
  });

  assert(client.persistence instanceof IndexedDbPersistence);
  await client.mutate({
    table: "tasks",
    key: "task-1",
    values: {
      owner_id: "user-1",
      title: "Persisted"
    }
  });

  const reopened = await OfflineDbClient.open({
    indexedDb,
    databaseName: "test-db",
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 0
        };
      }
    },
    tables: [tasks]
  });

  const row = await reopened.get("tasks", "task-1");
  assert.equal(row.title, "Persisted");
});

test("open accepts memory selector", async () => {
  const tasks = defineTable({ name: "tasks" });
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 0
        };
      }
    },
    tables: [tasks]
  });

  assert(client.persistence instanceof InMemoryPersistence);
});

test("open accepts localstorage selector", async () => {
  const tasks = defineTable({ name: "tasks" });
  const storage = createFakeLocalStorage();
  const client = await OfflineDbClient.open({
    persistence: "localstorage",
    localStorage: storage,
    databaseName: "local-test",
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 0
        };
      }
    },
    tables: [tasks]
  });

  assert(client.persistence instanceof LocalStoragePersistence);

  await client.mutate({
    table: "tasks",
    key: "task-1",
    values: {
      owner_id: "user-1",
      title: "Stored locally"
    }
  });

  const reopened = await OfflineDbClient.open({
    persistence: "localstorage",
    localStorage: storage,
    databaseName: "local-test",
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 0
        };
      }
    },
    tables: [tasks]
  });

  const row = await reopened.get("tasks", "task-1");
  assert.equal(row.title, "Stored locally");
});

test("sync accepts optional table filtering", async () => {
  const tasks = defineTable({ name: "tasks" });
  const notes = defineTable({ name: "notes" });
  let requestBody = null;
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync(request) {
        requestBody = request;
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 5
        };
      }
    },
    tables: [tasks, notes]
  });

  await client.sync({ tables: ["notes"] });
  assert.deepEqual(requestBody.tables, ["notes"]);
});

test("getSyncStatus reports pending and touched rows", async () => {
  const tasks = defineTable({ name: "tasks" });
  const client = await OfflineDbClient.open({
    persistence: "memory",
    transport: {
      async sync() {
        return {
          accepted: [],
          conflicts: [],
          changes: [],
          lastGlobalId: 0
        };
      }
    },
    tables: [tasks],
    now: () => new Date("2026-04-03T12:00:00.000Z"),
    idFactory: () => "m1"
  });

  await client.mutate({
    table: "tasks",
    key: "task-1",
    values: { title: "Touched" }
  });

  const status = await client.getSyncStatus({ tables: ["tasks"] });
  assert.equal(status.pendingCount, 1);
  assert.equal(status.touchedCount, 1);
});

test("repairSync can queue all local rows and reset pull cursor for catch-up", async () => {
  const tasks = defineTable({ name: "tasks" });
  const persistence = new InMemoryPersistence();
  const requests = [];
  const client = await OfflineDbClient.open({
    persistence,
    transport: {
      async sync(request) {
        requests.push(request);
        return {
          accepted: request.mutations.map((mutation, index) => ({
            localId: mutation.localId,
            globalId: index + 1,
            row: {
              ...mutation.values,
              local_id: null,
              global_id: index + 1
            }
          })),
          conflicts: [],
          changes: [],
          lastGlobalId: 33
        };
      }
    },
    tables: [tasks],
    now: () => new Date("2026-04-03T12:00:00.000Z"),
    idFactory: (() => {
      let id = 0;
      return () => `m${++id}`;
    })()
  });

  await persistence.saveRow("tasks", "task-1", {
    id: "task-1",
    title: "Local only",
    revision: 1,
    local_id: null,
    global_id: 0
  });
  await persistence.setLastGlobalId(99);

  const result = await client.repairSync({ tables: ["tasks"], includeAllLocalRows: true });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].lastGlobalId, 0);
  assert.equal(requests[0].mutations.length, 1);
  assert.equal(requests[0].mutations[0].key, "task-1");
  assert.equal(result.queued, 1);
  assert.equal(result.pending, 0);
  assert.equal((await client.getSyncStatus({ tables: ["tasks"] })).touchedCount, 0);
  assert.equal(await persistence.getLastGlobalId(), 33);
});

function createFakeIndexedDb() {
  const databases = new Map();

  return {
    open(name) {
      const request = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };

      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (!db) {
          db = createFakeDatabase();
          databases.set(name, db);
        }

        request.result = db;
        if (isNew && typeof request.onupgradeneeded === "function") {
          request.onupgradeneeded();
        }
        if (typeof request.onsuccess === "function") {
          request.onsuccess();
        }
      });

      return request;
    }
  };
}

function createFakeDatabase() {
  const stores = new Map();
  const objectStoreNames = {
    contains(name) {
      return stores.has(name);
    }
  };

  return {
    objectStoreNames,
    createObjectStore(name) {
      if (!stores.has(name)) {
        stores.set(name, new Map());
      }
    },
    transaction(name) {
      const store = stores.get(name);
      const tx = {
        error: null,
        oncomplete: null,
        onerror: null,
        objectStore() {
          return {
            get(key) {
              const request = {
                result: null,
                error: null,
                onsuccess: null,
                onerror: null
              };
              queueMicrotask(() => {
                request.result = store.get(key);
                if (typeof request.onsuccess === "function") {
                  request.onsuccess();
                }
              });
              return request;
            },
            put(value, key) {
              store.set(key, structuredClone(value));
              queueMicrotask(() => {
                if (typeof tx.oncomplete === "function") {
                  tx.oncomplete();
                }
              });
            }
          };
        }
      };

      return tx;
    }
  };
}

function createFakeLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    }
  };
}
