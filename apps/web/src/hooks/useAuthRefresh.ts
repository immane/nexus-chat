/**
 * Automatic access-token refresh
 *
 * Refreshes the access token before expiry using the stored refresh token.
 * Schedules the next refresh at 50% of token lifetime (default ~7.5 min for 15-min tokens).
 *
 * On mount:
 *   - If the token is already expired or about to expire (within 60s), refresh immediately.
 *   - Otherwise schedule a refresh at mid-lifetime.
 * On unmount: clears the timer.
 */
import { useEffect, useRef } from "react";
import { useAuthStore } from "../stores/domain.js";
import { API_BASE } from "../lib/api.js";

const MIN_TTL_MS = 60_000;

export const useAuthRefresh = () => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const schedule = () => {
      const { accessTokenExpiresAt, refreshToken } = useAuthStore.getState();
      if (!accessTokenExpiresAt || !refreshToken) return;

      const remainingMs = accessTokenExpiresAt - Date.now();

      // Expired or close to expiry — refresh now
      if (remainingMs <= MIN_TTL_MS) {
        void refreshNow();
        return;
      }

      // Schedule at 50% of token lifetime
      const delayMs = Math.floor(remainingMs / 2);
      timerRef.current = setTimeout(() => {
        void refreshNow();
      }, delayMs);
    };

    const refreshNow = async () => {
      const { refreshToken } = useAuthStore.getState();
      if (!refreshToken) return;

      try {
        const resp = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refreshToken })
        });
        const json = (await resp.json()) as {
          ok: boolean;
          data?: { tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number } };
          error?: { message: string };
        };
        if (json.ok && json.data) {
          useAuthStore.getState().refreshSession({
            user: useAuthStore.getState().user!,
            tokens: json.data.tokens
          });
          schedule();
        } else {
          // Refresh failed — clear auth, user will be redirected to login
          useAuthStore.getState().clear();
        }
      } catch {
        // Network error — retry in 30s
        timerRef.current = setTimeout(() => {
          void refreshNow();
        }, 30_000);
      }
    };

    schedule();

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);
};
