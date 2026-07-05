import fs from "node:fs";
import path from "node:path";

const envFile = path.join(process.cwd(), ".env.tui");
export let apiBase = process.env.NEXUS_API_BASE ?? "http://localhost:4000";

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

export const getAccessToken = () => token;

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
