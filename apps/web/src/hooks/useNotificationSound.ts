/**
 * useNotificationSound — Audio Notification
 *
 * Plays a short sine-wave chime (880→1100 Hz, 150ms) when enabled.
 * Uses the Web Audio API (AudioContext + OscillatorNode) rather than
 * an audio file to avoid loading external assets.
 *
 * Design Decision:
 * We create the AudioContext lazily on first use (not on mount) to comply
 * with browser autoplay policies — AudioContexts must be created/resumed
 * after a user gesture.
 *
 * Does NOT:
 * - Play sounds for message content (only notification events)
 * - Use preloaded audio files (all sounds are synthesized)
 */
import { useCallback, useRef } from "react";

export const useNotificationSound = (enabled: boolean) => {
  const ctxRef = useRef<AudioContext | undefined>(undefined);

  const play = useCallback(() => {
    if (!enabled) return;
    try {
      if (!ctxRef.current) ctxRef.current = new AudioContext();
      const ctx = ctxRef.current;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = "sine";
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);

      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.07);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch {
      // Audio not available
    }
  }, [enabled]);

  return { play };
};
