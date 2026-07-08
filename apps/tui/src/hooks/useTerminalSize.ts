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
