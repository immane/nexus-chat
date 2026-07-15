/**
 * Login route: email/password authentication against the REST API.
 * On success, persists the JWT session via the auth store.
 */
import { useState, type FormEvent } from "react";
import type { User } from "@nexus-chat/shared";
import { useAuthStore } from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";

const LoginRoute = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const resp = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const json = (await resp.json()) as {
        ok: boolean;
        data?: { user: User; tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number } };
        error?: { message: string };
      };
      if (!json.ok || !json.data) { setError(json.error?.message ?? "Login failed"); return; }
      useAuthStore.getState().setSession({ user: json.data.user, tokens: json.data.tokens });
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <main className="grid h-screen place-items-center bg-[radial-gradient(circle_at_top_left,#164e63,#020617_45%)] p-6 pb-8 sm:pb-0 text-slate-100">
      <div className="w-full max-w-md">
        <form className="rounded-3xl border border-white/10 bg-slate-950/85 p-8 shadow-2xl" onSubmit={handleSubmit}>
          <p className="text-sm font-medium uppercase tracking-[0.3em] text-emerald-300">Nexus Chat</p>
          <h1 className="mt-3 text-3xl font-semibold">Sign in to your workspace</h1>
          {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
          <label className="mt-6 block text-sm text-slate-300" htmlFor="email">Email</label>
          <input id="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none ring-emerald-400 transition focus:ring-2" value={email} onChange={(e) => setEmail(e.target.value)} />
          <label className="mt-4 block text-sm text-slate-300" htmlFor="password">Password</label>
          <input id="password" type="password" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none ring-emerald-400 transition focus:ring-2" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="mt-6 w-full rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-300" type="submit">Continue</button>
        </form>
      </div>
    </main>
  );
};

export default LoginRoute;
