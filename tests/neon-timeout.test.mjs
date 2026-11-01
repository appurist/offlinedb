import assert from "node:assert/strict";
import test from "node:test";
import { createOdbDataClient, createOdbSyncTransport } from "../src/index.js";

test("odb data client aborts a request that exceeds timeoutMs", async () => {
  const client = createOdbDataClient({
    baseUrl: "https://data.example.test/",
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })
  });

  await assert.rejects(
    () => client.odbRpc("pull_changes", {}),
    (error) => {
      assert.equal(error.name, "OdbTimeoutError");
      assert.match(error.message, /timed out after 20ms/);
      return true;
    }
  );
});

test("odb data client passes no signal when timeoutMs is 0", async () => {
  let seenInit = null;
  const client = createOdbDataClient({
    baseUrl: "https://data.example.test/",
    timeoutMs: 0,
    fetchImpl: async (url, init) => {
      seenInit = init;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  await client.odbRpc("pull_changes", {});
  assert.equal(seenInit.signal, undefined);
});

test("odb sync transport includes the database message on rejected writes", async () => {
  const data = {
    async odbRpc(fn) {
      if (fn === "mutate_tasks") {
        const error = new Error("Neon Data API request failed with status 409");
        error.name = "OdbHttpError";
        error.status = 409;
        error.body = {
          code: "23505",
          message: "duplicate key value violates unique constraint",
          details: "Key (owner_id, title)=(u1, x) already exists."
        };
        throw error;
      }
      return { changes: [], lastGlobalId: 1, hasMore: false };
    }
  };

  const transport = createOdbSyncTransport({ dataClient: data });
  const result = await transport.sync({
    mutations: [{
      localId: "l1",
      globalId: 0,
      clientSequence: 1,
      table: "tasks",
      key: "t1",
      baseRevision: 0,
      values: { id: "t1" },
      occurredAt: "2026-04-03T12:00:00.000Z"
    }],
    lastGlobalId: 0
  });

  assert.equal(result.conflicts[0].message, "Key (owner_id, title)=(u1, x) already exists.");
});
