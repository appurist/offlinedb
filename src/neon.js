/**
 * Thin fetch-based wrappers for Neon Auth and the Neon Data API.
 *
 * The auth endpoint defaults below are inferred from Better Auth's
 * documented email/password routes because Neon Auth is built on Better Auth.
 * Consumers can override endpoint paths if their Neon project uses different
 * URLs or proxy routing.
 */

/**
 * @param {{
 *   baseUrl: string,
 *   fetchImpl?: typeof fetch,
 *   endpoints?: Partial<{
 *     loginWithPassword: string,
 *     signUpWithPassword: string,
 *     logout: string
 *   }>
 * }} options
 */
export function createOdbAuthClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoints = {
    loginWithPassword: "sign-in/email",
    signUpWithPassword: "sign-up/email",
    logout: "sign-out",
    ...(options.endpoints ?? {})
  };

  return {
    /**
     * @param {{email: string, password: string, rememberMe?: boolean, callbackURL?: string}} args
     */
    async odbLoginWithPassword(args) {
      return odbPostJson(fetchImpl, joinUrl(options.baseUrl, endpoints.loginWithPassword), args);
    },

    /**
     * @param {{email: string, password: string, name?: string, callbackURL?: string, image?: string}} args
     */
    async odbSignUpWithPassword(args) {
      return odbPostJson(fetchImpl, joinUrl(options.baseUrl, endpoints.signUpWithPassword), args);
    },

    async odbLogout() {
      return odbPostJson(fetchImpl, joinUrl(options.baseUrl, endpoints.logout), {});
    }
  };
}

/**
 * @param {{
 *   baseUrl: string,
 *   fetchImpl?: typeof fetch,
 *   getAuthToken?: () => Promise<string | null> | string | null,
 *   headers?: HeadersInit
 * }} options
 */
export function createOdbDataClient(options) {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    /**
     * @param {{path: string, method?: string, body?: unknown, headers?: HeadersInit}} args
     */
    async odbRequest(args) {
      const token = await options.getAuthToken?.();
      const response = await fetchImpl(joinUrl(options.baseUrl, args.path), {
        method: args.method ?? "GET",
        headers: {
          ...(args.body != null ? { "content-type": "application/json" } : {}),
          ...(options.headers ?? {}),
          ...(args.headers ?? {}),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: args.body == null ? undefined : JSON.stringify(args.body)
      });

      if (!response.ok) {
        throw new Error(`Neon Data API request failed with status ${response.status}`);
      }

      return readJsonIfPossible(response);
    },

    /**
     * PostgREST-style RPC call.
     *
     * @param {string} fn
     * @param {Record<string, unknown>=} args
     */
    async odbRpc(fn, args = {}) {
      return this.odbRequest({
        path: `rpc/${fn}`,
        method: "POST",
        body: args
      });
    }
  };
}

/**
 * Direct Neon-native sync transport.
 *
 * It uses PostgREST-style RPC calls against database functions rather than a
 * custom app-owned sync service.
 *
 * @param {{
 *   dataClient: ReturnType<typeof createOdbDataClient>,
 *   mutateFunctionName?: ((table: string) => string) | string,
 *   pullFunctionName?: string
 * }} options
 */
export function createOdbSyncTransport(options) {
  const mutateFunctionName =
    typeof options.mutateFunctionName === "function"
      ? options.mutateFunctionName
      : (table) => options.mutateFunctionName ?? `mutate_${table}`;
  const pullFunctionName = options.pullFunctionName ?? "pull_changes";

  return {
    async sync(request) {
      const accepted = [];
      const conflicts = [];

      for (const mutation of request.mutations) {
        const result = normalizeRpcResult(
          await options.dataClient.odbRpc(mutateFunctionName(mutation.table), {
            p_local_id: mutation.localId,
            p_row_key: mutation.key,
            p_base_revision: mutation.baseRevision,
            p_values: mutation.values
          })
        );

        if (result?.ok === false) {
          conflicts.push({
            localId: mutation.localId,
            code: result.code ?? "revision_conflict",
            serverRow: result.row ?? null
          });
          continue;
        }

        accepted.push({
          localId: result?.localId ?? mutation.localId,
          globalId: Number(result?.globalId ?? 0),
          row: result?.row ?? null
        });
      }

      const pull = normalizeRpcResult(
        await options.dataClient.odbRpc(pullFunctionName, {
          p_last_global_id: request.lastGlobalId,
          p_tables: request.tables?.length ? request.tables : null
        })
      ) ?? { changes: [], lastGlobalId: request.lastGlobalId };

      return {
        accepted,
        conflicts,
        changes: (pull.changes ?? []).map((entry) => ({
          table: entry.table,
          key: entry.key,
          row: entry.row ?? null
        })),
        lastGlobalId: Number(pull.lastGlobalId ?? request.lastGlobalId ?? 0)
      };
    }
  };
}

async function odbPostJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Auth request failed with status ${response.status}`);
  }

  return readJsonIfPossible(response);
}

async function readJsonIfPossible(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

function normalizeRpcResult(value) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function joinUrl(baseUrl, path) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalizedBase);
}
