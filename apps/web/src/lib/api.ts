export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

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
