import { defineTable } from "./schema.js";

/**
 * @typedef {{
 *   localId: string,
 *   globalId: number,
 *   clientSequence: number,
 *   table: string,
  *   key: string,
 *   baseRevision: number,
 *   values: Record<string, unknown>,
 *   occurredAt: string,
 *   metadata?: Record<string, unknown>
 * }} PendingMutation
 */

/**
 * @typedef {{
 *   table: string,
 *   key: string,
 *   operation: "upsert" | "delete",
 *   firstTouchedAt: string,
 *   lastTouchedAt: string,
 *   attemptCount: number,
 *   lastError?: string | null
 * }} TouchedRow
 */

/**
 * @typedef {{
 *   table: string,
 *   key: string,
 *   row: Record<string, unknown> | null
 * }} ChangeRecord
 */

/**
 * @typedef {{
 *   accepted: Array<{localId: string, globalId: number, row?: Record<string, unknown> | null}>,
 *   conflicts: Array<{localId: string, code: "revision_conflict", serverRow: Record<string, unknown> | null}>,
 *   changes: ChangeRecord[],
 *   lastGlobalId: number
 * }} SyncResult
 */

export class OfflineDbClient {
  /**
   * @param {{
   *   persistence?: PersistenceLayer | "indexeddb" | "localstorage" | "memory",
   *   transport: {sync: (request: {mutations: PendingMutation[], tables?: string[], lastGlobalId: number}) => Promise<SyncResult>},
   *   tables: ReturnType<typeof defineTable>[],
   *   databaseName?: string,
   *   indexedDb?: IDBFactory,
   *   localStorage?: StorageLike,
   *   now?: () => Date,
   *   idFactory?: () => string
   * }} options
   */
  constructor(options) {
    this.persistence = options.persistence;
    this.transport = options.transport;
    this.tables = new Map(options.tables.map((table) => [table.name, table]));
    this.now = options.now ?? (() => new Date());
    this.idFactory =
      options.idFactory ??
      (() => {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }

        return `mutation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      });
  }

  /**
   * @param {ConstructorParameters<typeof OfflineDbClient>[0]} options
   */
  static async open(options) {
    const persistence = resolvePersistence(options);
    await persistence.initialize();
    return new OfflineDbClient({
      ...options,
      persistence
    });
  }

  /**
   * @param {string} table
   * @param {string} key
   */
  async get(table, key) {
    this.#requireTable(table);
    return this.persistence.getRow(table, key);
  }

  /**
   * @param {string} table
   */
  async list(table) {
    this.#requireTable(table);
    return this.persistence.listRows(table);
  }

  /**
   * @param {{table: string, key: string, values: Record<string, unknown>, metadata?: Record<string, unknown>}} args
   */
  async mutate(args) {
    const table = this.#requireTable(args.table);
    const current = await this.persistence.getRow(table.name, args.key);
    const revisionColumn = table.revisionColumn;
    const updatedAtColumn = table.updatedAtColumn;
    const localIdColumn = table.localIdColumn;
    const globalIdColumn = table.globalIdColumn;
    const nowIso = this.now().toISOString();
    const baseRevision = Number(current?.[revisionColumn] ?? 0);
    const localId = this.idFactory();
    const mutation = {
      localId,
      globalId: 0,
      clientSequence: await this.persistence.nextClientSequence(),
      table: table.name,
      key: args.key,
      baseRevision,
      values: {
        ...(current ?? {}),
        ...args.values,
        [table.primaryKey]: args.key,
        [revisionColumn]: baseRevision + 1,
        [updatedAtColumn]: nowIso,
        [localIdColumn]: localId,
        [globalIdColumn]: 0
      },
      occurredAt: nowIso,
      metadata: args.metadata
    };

    await this.persistence.saveRow(table.name, args.key, mutation.values);
    await this.persistence.appendPendingMutation(mutation);
    await this.persistence.recordTouchedRow?.({
      table: table.name,
      key: args.key,
      operation: "upsert",
      occurredAt: nowIso
    });
    return mutation;
  }

  /**
   * Queue a delete tombstone and optimistically remove the local row.
   * @param {{table: string, key: string, metadata?: Record<string, unknown>}} args
   */
  async delete(args) {
    const table = this.#requireTable(args.table);
    const current = await this.persistence.getRow(table.name, args.key);
    const nowIso = this.now().toISOString();
    const localId = this.idFactory();
    const mutation = {
      localId,
      globalId: 0,
      clientSequence: await this.persistence.nextClientSequence(),
      table: table.name,
      key: args.key,
      baseRevision: Number(current?.[table.revisionColumn] ?? 0),
      values: null,
      occurredAt: nowIso,
      metadata: args.metadata
    };

    await this.persistence.deleteRow(table.name, args.key);
    await this.persistence.appendPendingMutation(mutation);
    await this.persistence.recordTouchedRow?.({
      table: table.name,
      key: args.key,
      operation: "delete",
      occurredAt: nowIso
    });
    return mutation;
  }

  /**
   * Push every pending local change, then pull the whole replica forward.
   *
   * `tables` only validates the names and is forwarded to the transport; the
   * pull itself is never narrowed. The client keeps one `lastGlobalId` across
   * all tables, so a pull limited to some tables would advance that cursor
   * past changes in the others and they would never be fetched.
   *
   * @param {{tables?: string[]}=} options
   */
  async sync(options = {}) {
    const tableNames = this.#resolveTables(options.tables);
    const [mutations, lastGlobalId] = await Promise.all([
      this.persistence.getPendingMutations(),
      this.persistence.getLastGlobalId()
    ]);
    const result = await this.transport.sync({
      mutations,
      tables: tableNames,
      lastGlobalId
    });

    await this.persistence.acknowledgeMutations(result.accepted.map((entry) => entry.localId));

    for (const accepted of result.accepted) {
      const mutation = mutations.find((entry) => entry.localId === accepted.localId);
      if (!mutation) {
        continue;
      }

      if (accepted.row) {
        await this.persistence.saveRow(mutation.table, mutation.key, accepted.row);
        continue;
      }

      const current = await this.persistence.getRow(mutation.table, mutation.key);
      if (!current) {
        continue;
      }

      const table = this.#requireTable(mutation.table);
      if (current[table.localIdColumn] !== accepted.localId) {
        continue;
      }

      await this.persistence.saveRow(mutation.table, mutation.key, {
        ...current,
        [table.localIdColumn]: null,
        [table.globalIdColumn]: accepted.globalId
      });
    }

    for (const conflict of result.conflicts) {
      const mutation = mutations.find((entry) => entry.localId === conflict.localId);
      if (!mutation) {
        continue;
      }

      await this.persistence.acknowledgeMutations([conflict.localId]);
      if (conflict.serverRow) {
        await this.persistence.saveRow(mutation.table, mutation.key, conflict.serverRow);
      }
    }

    for (const change of result.changes) {
      // The pull covers every table in the log; keep only the ones this client replicates.
      if (!this.tables.has(change.table)) {
        continue;
      }
      if (change.row == null) {
        await this.persistence.deleteRow(change.table, change.key);
        continue;
      }

      await this.persistence.saveRow(change.table, change.key, change.row);
    }

    await this.persistence.setLastGlobalId(result.lastGlobalId);
    return result;
  }

  /**
   * Requeue touched rows, optionally every local row, then run normal bidirectional sync.
   * @param {{tables?: string[], includeAllLocalRows?: boolean, onProgress?: (progress: {phase: string, current: number, total: number, label?: string}) => void}=} options
   */
  async repairSync(options = {}) {
    const tableNames = this.#resolveTables(options.tables);
    const nowIso = this.now().toISOString();
    const touched = await this.persistence.listTouchedRows?.(tableNames) ?? [];
    const touchedKeys = new Set(touched.map((entry) => `${entry.table}:${entry.key}`));
    const candidates = [...touched];

    if (options.includeAllLocalRows) {
      for (const table of tableNames) {
        const rows = await this.persistence.listRows(table);
        for (const row of rows) {
          const tableDef = this.#requireTable(table);
          const key = String(row?.[tableDef.primaryKey] ?? row?.id ?? "");
          if (!key || touchedKeys.has(`${table}:${key}`)) {
            continue;
          }
          candidates.push({
            table,
            key,
            operation: "upsert",
            firstTouchedAt: nowIso,
            lastTouchedAt: nowIso,
            attemptCount: 0,
            lastError: null
          });
        }
      }
    }

    options.onProgress?.({ phase: "queue", current: 0, total: candidates.length, label: "Queueing local changes..." });
    let queued = 0;
    const queuedTouched = [];
    for (const entry of candidates) {
      const table = this.#requireTable(entry.table);
      try {
        if (entry.operation === "delete") {
          await this.delete({ table: table.name, key: entry.key });
        } else {
          const row = await this.persistence.getRow(table.name, entry.key);
          if (!row) {
            await this.persistence.clearTouchedRows?.([entry]);
            queued += 1;
            options.onProgress?.({ phase: "queue", current: queued, total: candidates.length, label: `Queued ${queued} of ${candidates.length}` });
            continue;
          }
          await this.mutate({ table: table.name, key: entry.key, values: row });
        }
        queuedTouched.push(entry);
      } catch (error) {
        await this.persistence.markTouchedRowError?.(entry.table, entry.key, error.message);
      }
      queued += 1;
      options.onProgress?.({ phase: "queue", current: queued, total: candidates.length, label: `Queued ${queued} of ${candidates.length}` });
    }

    options.onProgress?.({ phase: "sync", current: 0, total: 1, label: "Syncing with cloud..." });
    const originalLastGlobalId = await this.persistence.getLastGlobalId();
    await this.persistence.setLastGlobalId(0);
    let result;
    try {
      result = await this.sync({ tables: tableNames });
    } catch (error) {
      await this.persistence.setLastGlobalId(originalLastGlobalId);
      throw error;
    }
    const pending = await this.persistence.getPendingMutations();
    const pendingKeys = new Set(pending.map((mutation) => `${mutation.table}:${mutation.key}`));
    const clearable = queuedTouched.filter((entry) => !pendingKeys.has(`${entry.table}:${entry.key}`));
    await this.persistence.clearTouchedRows?.(clearable);
    options.onProgress?.({ phase: "sync", current: 1, total: 1, label: "Repair sync complete" });

    return {
      ...result,
      touched: touched.length,
      queued: queuedTouched.length,
      clearedTouched: clearable.length,
      pending: pending.length
    };
  }

  async getSyncStatus(options = {}) {
    const tableNames = this.#resolveTables(options.tables);
    const [pending, touched] = await Promise.all([
      this.persistence.getPendingMutations(),
      this.persistence.listTouchedRows?.(tableNames) ?? []
    ]);
    const tableSet = new Set(tableNames);
    return {
      pendingCount: pending.filter((entry) => tableSet.has(entry.table)).length,
      touchedCount: touched.length,
      lastGlobalId: await this.persistence.getLastGlobalId()
    };
  }

  async exportState() {
    return this.persistence.exportState();
  }

  #requireTable(name) {
    const table = this.tables.get(name);
    if (!table) {
      throw new Error(`Unknown table: ${name}`);
    }

    return table;
  }

  #resolveTables(tableNames) {
    if (!tableNames || tableNames.length === 0) {
      return [...this.tables.keys()];
    }

    return tableNames.map((name) => this.#requireTable(name).name);
  }
}

export class IndexedDbPersistence {
  /**
   * @param {{databaseName?: string, indexedDb?: IDBFactory}=} options
   */
  constructor(options = {}) {
    this.databaseName = options.databaseName ?? "offlinedb";
    this.indexedDb = options.indexedDb ?? globalThis.indexedDB;
    this.memory = new InMemoryPersistence();
  }

  async initialize() {
    if (!this.indexedDb) {
      throw new Error("IndexedDB persistence requires indexedDB to be available or injected.");
    }

    const snapshot = await this.#readSnapshot();
    if (snapshot) {
      await this.memory.importState(snapshot);
    }
  }

  async nextClientSequence() {
    const value = await this.memory.nextClientSequence();
    await this.#persist();
    return value;
  }

  async getRow(table, key) {
    return this.memory.getRow(table, key);
  }

  async listRows(table) {
    return this.memory.listRows(table);
  }

  async saveRow(table, key, row) {
    await this.memory.saveRow(table, key, row);
    await this.#persist();
  }

  async deleteRow(table, key) {
    await this.memory.deleteRow(table, key);
    await this.#persist();
  }

  async appendPendingMutation(mutation) {
    await this.memory.appendPendingMutation(mutation);
    await this.#persist();
  }

  async recordTouchedRow(entry) {
    await this.memory.recordTouchedRow(entry);
    await this.#persist();
  }

  async listTouchedRows(tableNames = []) {
    return this.memory.listTouchedRows(tableNames);
  }

  async clearTouchedRows(entries) {
    await this.memory.clearTouchedRows(entries);
    await this.#persist();
  }

  async markTouchedRowError(table, key, error) {
    await this.memory.markTouchedRowError(table, key, error);
    await this.#persist();
  }

  async getPendingMutations() {
    return this.memory.getPendingMutations();
  }

  async acknowledgeMutations(mutationIds) {
    await this.memory.acknowledgeMutations(mutationIds);
    await this.#persist();
  }

  async getLastGlobalId() {
    return this.memory.getLastGlobalId();
  }

  async setLastGlobalId(lastGlobalId) {
    await this.memory.setLastGlobalId(lastGlobalId);
    await this.#persist();
  }

  async exportState() {
    return this.memory.exportState();
  }

  async #persist() {
    const db = await this.#openDatabase();
    const snapshot = await this.memory.exportState();

    await new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(snapshot, "snapshot");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
    });
  }

  async #readSnapshot() {
    const db = await this.#openDatabase();

    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readonly");
      const request = tx.objectStore("state").get("snapshot");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed."));
    });
  }

  async #openDatabase() {
    return new Promise((resolve, reject) => {
      const request = this.indexedDb.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("state")) {
          request.result.createObjectStore("state");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    });
  }
}

export class LocalStoragePersistence {
  /**
   * @param {{storageKey?: string, localStorage?: StorageLike}=} options
   */
  constructor(options = {}) {
    this.storageKey = options.storageKey ?? "offlinedb:snapshot";
    this.localStorage = options.localStorage ?? globalThis.localStorage;
    this.memory = new InMemoryPersistence();
  }

  async initialize() {
    if (!this.localStorage) {
      throw new Error("LocalStorage persistence requires localStorage to be available or injected.");
    }

    const raw = this.localStorage.getItem(this.storageKey);
    if (!raw) {
      return;
    }

    await this.memory.importState(JSON.parse(raw));
  }

  async nextClientSequence() {
    const value = await this.memory.nextClientSequence();
    await this.#persist();
    return value;
  }

  async getRow(table, key) {
    return this.memory.getRow(table, key);
  }

  async listRows(table) {
    return this.memory.listRows(table);
  }

  async saveRow(table, key, row) {
    await this.memory.saveRow(table, key, row);
    await this.#persist();
  }

  async deleteRow(table, key) {
    await this.memory.deleteRow(table, key);
    await this.#persist();
  }

  async appendPendingMutation(mutation) {
    await this.memory.appendPendingMutation(mutation);
    await this.#persist();
  }

  async recordTouchedRow(entry) {
    await this.memory.recordTouchedRow(entry);
    await this.#persist();
  }

  async listTouchedRows(tableNames = []) {
    return this.memory.listTouchedRows(tableNames);
  }

  async clearTouchedRows(entries) {
    await this.memory.clearTouchedRows(entries);
    await this.#persist();
  }

  async markTouchedRowError(table, key, error) {
    await this.memory.markTouchedRowError(table, key, error);
    await this.#persist();
  }

  async getPendingMutations() {
    return this.memory.getPendingMutations();
  }

  async acknowledgeMutations(mutationIds) {
    await this.memory.acknowledgeMutations(mutationIds);
    await this.#persist();
  }

  async getLastGlobalId() {
    return this.memory.getLastGlobalId();
  }

  async setLastGlobalId(lastGlobalId) {
    await this.memory.setLastGlobalId(lastGlobalId);
    await this.#persist();
  }

  async exportState() {
    return this.memory.exportState();
  }

  async #persist() {
    const snapshot = await this.memory.exportState();
    this.localStorage.setItem(this.storageKey, JSON.stringify(snapshot));
  }
}

export class InMemoryPersistence {
  constructor() {
    this.rows = new Map();
    this.pending = new Map();
    this.touched = new Map();
    this.lastGlobalId = 0;
    this.clientSequence = 0;
  }

  async initialize() {}

  async nextClientSequence() {
    this.clientSequence += 1;
    return this.clientSequence;
  }

  async getRow(table, key) {
    return this.#bucket(table).get(key) ?? null;
  }

  async listRows(table) {
    return [...this.#bucket(table).values()];
  }

  async saveRow(table, key, row) {
    this.#bucket(table).set(key, clone(row));
  }

  async deleteRow(table, key) {
    this.#bucket(table).delete(key);
  }

  async appendPendingMutation(mutation) {
    this.pending.set(mutation.localId, clone(mutation));
  }

  async recordTouchedRow(entry) {
    const key = `${entry.table}:${entry.key}`;
    const existing = this.touched.get(key);
    const occurredAt = entry.occurredAt ?? new Date().toISOString();
    this.touched.set(key, {
      table: entry.table,
      key: entry.key,
      operation: entry.operation ?? existing?.operation ?? "upsert",
      firstTouchedAt: existing?.firstTouchedAt ?? occurredAt,
      lastTouchedAt: occurredAt,
      attemptCount: Number(existing?.attemptCount ?? 0),
      lastError: null
    });
  }

  async listTouchedRows(tableNames = []) {
    const tableSet = new Set(Array.isArray(tableNames) ? tableNames : [tableNames]);
    return [...this.touched.values()]
      .filter((entry) => tableSet.size === 0 || tableSet.has(entry.table))
      .sort((left, right) => left.lastTouchedAt.localeCompare(right.lastTouchedAt))
      .map(clone);
  }

  async clearTouchedRows(entries) {
    for (const entry of entries ?? []) {
      this.touched.delete(`${entry.table}:${entry.key}`);
    }
  }

  async markTouchedRowError(table, key, error) {
    const mapKey = `${table}:${key}`;
    const existing = this.touched.get(mapKey);
    if (!existing) {
      return;
    }
    this.touched.set(mapKey, {
      ...existing,
      attemptCount: Number(existing.attemptCount ?? 0) + 1,
      lastError: error ?? "Sync failed"
    });
  }

  async getPendingMutations() {
    return [...this.pending.values()].sort((left, right) => left.clientSequence - right.clientSequence);
  }

  async acknowledgeMutations(mutationIds) {
    for (const mutationId of mutationIds) {
      this.pending.delete(mutationId);
    }
  }

  async getLastGlobalId() {
    return this.lastGlobalId;
  }

  async setLastGlobalId(lastGlobalId) {
    this.lastGlobalId = Number(lastGlobalId ?? 0);
  }

  async exportState() {
    return {
      clientSequence: this.clientSequence,
      lastGlobalId: this.lastGlobalId,
      pending: await this.getPendingMutations(),
      touched: await this.listTouchedRows(),
      rows: [...this.rows.entries()].map(([table, bucket]) => [table, [...bucket.entries()].map(([key, row]) => [key, clone(row)])])
    };
  }

  async importState(state) {
    this.clientSequence = Number(state?.clientSequence ?? 0);
    this.lastGlobalId = Number(state?.lastGlobalId ?? state?.watermark ?? state?.cursors?.global ?? 0);
    this.pending.clear();
    this.touched.clear();
    this.rows.clear();

    for (const mutation of state?.pending ?? []) {
      this.pending.set(mutation.localId ?? mutation.mutationId, clone(mutation));
    }

    for (const entry of state?.touched ?? []) {
      this.touched.set(`${entry.table}:${entry.key}`, clone(entry));
    }

    for (const [table, entries] of state?.rows ?? []) {
      const bucket = this.#bucket(table);
      for (const [key, row] of entries) {
        bucket.set(key, clone(row));
      }
    }
  }

  #bucket(table) {
    if (!this.rows.has(table)) {
      this.rows.set(table, new Map());
    }

    return this.rows.get(table);
  }
}

/**
 * @param {ConstructorParameters<typeof OfflineDbClient>[0]} options
 */
function resolvePersistence(options) {
  if (!options.persistence || options.persistence === "indexeddb") {
    return new IndexedDbPersistence({
      databaseName: options.databaseName ?? "offlinedb",
      indexedDb: options.indexedDb
    });
  }

  if (options.persistence === "memory") {
    return new InMemoryPersistence();
  }

  if (options.persistence === "localstorage") {
    return new LocalStoragePersistence({
      storageKey: `${options.databaseName ?? "offlinedb"}:snapshot`,
      localStorage: options.localStorage
    });
  }

  return options.persistence;
}

/**
 * @typedef {{
 *   initialize: () => Promise<void>,
 *   nextClientSequence: () => Promise<number>,
 *   getRow: (table: string, key: string) => Promise<Record<string, unknown> | null>,
 *   listRows: (table: string) => Promise<Record<string, unknown>[]>,
 *   saveRow: (table: string, key: string, row: Record<string, unknown>) => Promise<void>,
 *   deleteRow: (table: string, key: string) => Promise<void>,
 *   appendPendingMutation: (mutation: PendingMutation) => Promise<void>,
 *   recordTouchedRow?: (entry: {table: string, key: string, operation?: "upsert" | "delete", occurredAt?: string}) => Promise<void>,
 *   listTouchedRows?: (tableNames?: string[]) => Promise<TouchedRow[]>,
 *   clearTouchedRows?: (entries: TouchedRow[]) => Promise<void>,
 *   markTouchedRowError?: (table: string, key: string, error: string) => Promise<void>,
 *   getPendingMutations: () => Promise<PendingMutation[]>,
 *   acknowledgeMutations: (mutationIds: string[]) => Promise<void>,
 *   getLastGlobalId: () => Promise<number>,
 *   setLastGlobalId: (lastGlobalId: number) => Promise<void>,
 *   exportState: () => Promise<unknown>
 * }} PersistenceLayer
 *
 * @typedef {{
 *   open: (name: string, version: number) => IDBOpenDBRequest
 * }} IDBFactory
 *
 * @typedef {{
 *   getItem: (key: string) => string | null,
 *   setItem: (key: string, value: string) => void
 * }} StorageLike
 */

/**
 * @param {{baseUrl: string, fetchImpl?: typeof fetch, getAuthToken?: () => Promise<string | null> | string | null, syncPath?: string}} options
 */
export function createNeonHttpTransport(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const syncPath = options.syncPath ?? "rpc/offlinedb_sync";

  return {
    async sync(request) {
      const token = await options.getAuthToken?.();
      const response = await fetchImpl(joinUrl(options.baseUrl, syncPath), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify(request)
      });

      if (!response.ok) {
        throw new Error(`Sync failed with status ${response.status}`);
      }

      return response.json();
    }
  };
}

function joinUrl(baseUrl, path) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase);
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
