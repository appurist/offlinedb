import assert from "node:assert/strict";
import test from "node:test";
import {
  createOdbAuthClient,
  createOdbDataClient,
  createOdbSyncTransport
} from "../src/index.js";

test("odb auth client posts to email/password endpoints", async () => {
  const calls = [];
  const auth = createOdbAuthClient({
    baseUrl: "https://auth.example.test/api/",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await auth.odbLoginWithPassword({
    email: "user@example.com",
    password: "secret"
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.example.test/api/sign-in/email");
  assert.equal(calls[0].init.method, "POST");
});

test("odb data client sends bearer token and rpc path", async () => {
  const calls = [];
  const client = createOdbDataClient({
    baseUrl: "https://data.example.test/",
    getAuthToken: async () => "jwt-123",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  await client.odbRpc("offlinedb_pull", { lastGlobalId: 0 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://data.example.test/rpc/offlinedb_pull");
  assert.equal(calls[0].init.headers.authorization, "Bearer jwt-123");
});

test("odb sync transport uses direct rpc calls for mutate and paged pull", async () => {
  const calls = [];
  const data = {
    async odbRpc(fn, args) {
      calls.push({ fn, args });
      if (fn === "mutate_tasks") {
        return {
          ok: true,
          localId: args.p_local_id,
          globalId: 7,
          row: {
            id: args.p_row_key,
            global_id: 7,
            local_id: args.p_local_id
          }
        };
      }

      if (fn === "pull_changes_page") {
        return {
          changes: [
            {
              globalId: 7,
              table: "tasks",
              key: "task-1",
              row: {
                id: "task-1",
                global_id: 7,
                local_id: null
              }
            }
          ],
          lastGlobalId: 7,
          hasMore: false
        };
      }

      throw new Error(`Unexpected rpc ${fn}`);
    }
  };

  const transport = createOdbSyncTransport({ dataClient: data });
  const result = await transport.sync({
    mutations: [
      {
        localId: "l1",
        globalId: 0,
        clientSequence: 1,
        table: "tasks",
        key: "task-1",
        baseRevision: 0,
        values: { id: "task-1" },
        occurredAt: "2026-04-03T12:00:00.000Z"
      }
    ],
    tables: ["tasks"],
    lastGlobalId: 0
  });

  assert.equal(calls[0].fn, "mutate_tasks");
  assert.equal(calls[1].fn, "pull_changes_page");
  assert.equal(calls[1].args.p_limit, 500);
  assert.equal(result.accepted[0].globalId, 7);
  assert.equal(result.lastGlobalId, 7);
});

test("odb sync transport falls back to legacy pull when paged rpc is unavailable", async () => {
  const calls = [];
  const data = {
    async odbRpc(fn, args) {
      calls.push({ fn, args });
      if (fn === "pull_changes_page") {
        throw new Error("function offlinedb.pull_changes_page does not exist");
      }

      if (fn === "pull_changes") {
        return {
          changes: [],
          lastGlobalId: 11
        };
      }

      throw new Error(`Unexpected rpc ${fn}`);
    }
  };

  const transport = createOdbSyncTransport({ dataClient: data });
  const result = await transport.sync({
    mutations: [],
    tables: ["tasks"],
    lastGlobalId: 9
  });

  assert.deepEqual(calls.map((call) => call.fn), ["pull_changes_page", "pull_changes"]);
  assert.equal(result.lastGlobalId, 11);
});

test("odb sync transport pulls multiple pages", async () => {
  const calls = [];
  const data = {
    async odbRpc(fn, args) {
      calls.push({ fn, args });
      if (fn !== "pull_changes_page") {
        throw new Error(`Unexpected rpc ${fn}`);
      }

      return {
        changes: [
          {
            globalId: args.p_last_global_id + 1,
            table: "tasks",
            key: `task-${args.p_last_global_id + 1}`,
            row: null
          }
        ],
        lastGlobalId: args.p_last_global_id + 1,
        hasMore: args.p_last_global_id < 1
      };
    }
  };

  const transport = createOdbSyncTransport({ dataClient: data, pullPageSize: 2 });
  const result = await transport.sync({
    mutations: [],
    tables: ["tasks"],
    lastGlobalId: 0
  });

  assert.deepEqual(calls.map((call) => call.args.p_last_global_id), [0, 1]);
  assert.equal(result.changes.length, 2);
  assert.equal(result.lastGlobalId, 2);
});
