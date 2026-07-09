/**
 * HTTP Client & Token Persistence — TUI Transport Layer
 *
 * Responsibilities:
 * - Generic `request<T>()` function that sends JSON HTTP requests with auto-attached Bearer token
 * - Token lifecycle: load from env/file, persist to `.env.tui`, clear on logout
 * - API base URL resolution (env NEXUS_API_BASE → default 127.0.0.1:4000)
 *
 * Token Precedence:
 *   1. `NEXUS_ACCESS_TOKEN` environment variable (highest priority)
 *   2. `NEXUS_ACCESS_TOKEN=<value>` line in `.env.tui` file
 *   3. Empty string (unauthenticated)
 *
 * Error Handling:
 *   - `request<T>()` throws on non-ok responses with the server's error message
 *   - Token file I/O errors are silently caught (best-effort persistence)
 *   - The `.env.tui` file may not exist initially; `setAccessToken` creates it
 *
 * Forbidden Dependencies:
 *   - Must NOT import from `apps/server/` (this is a client-side module)
 */
import fs from "node:fs";
import path from "node:path";

const envFile = path.join(process.cwd(), ".env.tui");
export let apiBase = process.env.NEXUS_API_BASE ?? "http://127.0.0.1:4000";

const loadToken = (): string => {
  if (process.env.NEXUS_ACCESS_TOKEN) return process.env.NEXUS_ACCESS_TOKEN;
  try {
    const content = fs.readFileSync(envFile, "utf-8");
    const match = content.match(/^NEXUS_ACCESS_TOKEN=(.*)$/m);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
};

let token = loadToken();

/** Returns the currently loaded access token. Does NOT re-read from file/env. */
export const getAccessToken = () => token;

/** Persists token to both memory and `.env.tui` file. Creates the file if it doesn't exist. */
export const setAccessToken = (value: string) => {
  token = value;
  try {
    let content = "";
    try { content = fs.readFileSync(envFile, "utf-8"); } catch { /* file may not exist */ }
    if (content.match(/^NEXUS_ACCESS_TOKEN=/m)) {
      content = content.replace(/^NEXUS_ACCESS_TOKEN=.*$/m, `NEXUS_ACCESS_TOKEN=${value}`);
    } else {
      content = `${content}${content.endsWith("\n") ? "" : "\n"}NEXUS_ACCESS_TOKEN=${value}\n`;
    }
    fs.writeFileSync(envFile, content.trimEnd() + "\n", "utf-8");
  } catch {
    // best-effort persistence
  }
};

/** Clears token from both memory and `.env.tui` file. */
export const clearAccessToken = () => {
  token = "";
  try {
    let content = "";
    try { content = fs.readFileSync(envFile, "utf-8"); } catch { return; }
    content = content.replace(/^NEXUS_ACCESS_TOKEN=.*\n?$/m, "");
    fs.writeFileSync(envFile, content.trimEnd() + "\n", "utf-8");
  } catch {
    // best-effort
  }
};

/**
 * Sends a JSON HTTP request to the Nexus Chat API.
 *
 * Automatically attaches `Authorization: Bearer <token>` header if a token is loaded.
 * The API response must follow the `{ ok: boolean; data?: T; error?: { message: string } }` envelope.
 *
 * @throws {Error} If the response `ok` field is false, throws with the server's error message.
 */
export const request = async <T>(restPath: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${apiBase}${restPath}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers
    }
  });
  const json = (await response.json()) as { ok: boolean; data?: T; error?: { message: string } };
  if (!json.ok) throw new Error(json.error?.message ?? "Request failed");
  return json.data as T;
};
