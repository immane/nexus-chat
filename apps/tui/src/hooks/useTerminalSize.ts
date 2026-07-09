/**
 * Terminal Dimensions Hook
 *
 * Tracks `process.stdout.columns` and `process.stdout.rows` via the TTY resize event.
 * Falls back to 120×40 when stdout is not a TTY (e.g., in non-interactive mode).
 *
 * Side Effects:
 * - Subscribes to `process.stdout.on("resize")` and cleans up on unmount.
 */
import { useState, useEffect } from "react";

export const useTerminalSize = () => {
  const [size, setSize] = useState({ columns: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 });

  useEffect(() => {
    const onResize = () => {
      setSize({ columns: process.stdout.columns ?? 120, rows: process.stdout.rows ?? 40 });
    };
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  return size;
};
