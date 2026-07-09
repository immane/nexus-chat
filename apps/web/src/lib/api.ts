/**
 * API Client
 *
 * Thin fetch wrapper with:
 * - Base URL from VITE_API_BASE env var (default: http://127.0.0.1:4000)
 * - Automatic Bearer token injection
 * - JSON response parsing with error extraction
 *
 * Design Decision:
 * We deliberately keep this minimal rather than using a generated SDK because
 * the API surface changes frequently during Phase 1. The 60+ endpoints are
 * called directly via fetch in the components/hooks, and this utility is only
 * used for the most common patterns.
 */
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:4000";

export const apiRequest = async <T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> => {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...options.headers
    }
  });
  const json = (await response.json()) as { ok: boolean; data?: T; error?: { message: string } };
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
};
