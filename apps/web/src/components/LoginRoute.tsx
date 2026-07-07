import { useState, type FormEvent } from "react";
import type { User } from "@nexus-chat/shared";
import { useAuthStore } from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";
import { seedDemoSession } from "./demo-data.js";

const LoginRoute = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"demo" | "server">("demo");
  const [error, setError] = useState("");

  const demoSubmit = (event: FormEvent) => {
    event.preventDefault();
    seedDemoSession();
  };

  const serverSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      const resp = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const json = (await resp.json()) as { ok: boolean; data?: { user: User; tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number } }; error?: { message: string } };
      if (!json.ok || !json.data) { setError(json.error?.message ?? "Login failed"); return; }
      useAuthStore.getState().setSession({ user: json.data.user, tokens: json.data.tokens });
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top_left,#164e63,#020617_45%)] p-6 text-slate-100">
      <div className="w-full max-w-md">
        <div className="mb-4 flex gap-2">
          <button className={`rounded-xl px-4 py-2 text-sm font-medium ${mode === "demo" ? "bg-sky-400 text-slate-950" : "bg-slate-800 text-slate-300"}`} type="button" onClick={() => setMode("demo")}>Demo</button>
          <button className={`rounded-xl px-4 py-2 text-sm font-medium ${mode === "server" ? "bg-emerald-400 text-slate-950" : "bg-slate-800 text-slate-300"}`} type="button" onClick={() => setMode("server")}>Real Server</button>
        </div>
        {mode === "demo" ? (
          <form className="rounded-3xl border border-white/10 bg-slate-950/85 p-8 shadow-2xl" onSubmit={demoSubmit}>
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-sky-300">Nexus Chat</p>
            <h1 className="mt-3 text-3xl font-semibold">Demo Mode</h1>
            <p className="mt-2 text-sm text-slate-400">Pre-loaded with sample data. No server required.</p>
            <button className="mt-6 w-full rounded-xl bg-sky-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-sky-300" type="submit">Enter Demo</button>
          </form>
        ) : (
          <form className="rounded-3xl border border-white/10 bg-slate-950/85 p-8 shadow-2xl" onSubmit={serverSubmit}>
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-emerald-300">Nexus Chat</p>
            <h1 className="mt-3 text-3xl font-semibold">Sign in to your workspace</h1>
            {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
            <label className="mt-6 block text-sm text-slate-300" htmlFor="email">Email</label>
            <input id="email" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none ring-emerald-400 transition focus:ring-2" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label className="mt-4 block text-sm text-slate-300" htmlFor="password">Password</label>
            <input id="password" type="password" className="mt-2 w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 outline-none ring-emerald-400 transition focus:ring-2" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button className="mt-6 w-full rounded-xl bg-emerald-400 px-4 py-3 font-semibold text-slate-950 transition hover:bg-emerald-300" type="submit">Continue</button>
          </form>
        )}
      </div>
    </main>
  );
};

export default LoginRoute;
