/**
 * Panel Focus Hook — Tracks Active Panel and Selection Indices
 *
 * The TUI uses a 3-panel focus model: sidebar, messages, composer.
 * This hook tracks which panel is active and the selected index within each list.
 *
 * Note: This hook is defined but NOT currently consumed by app.tsx (which manages
 * focus state directly). It is available for future extraction of focus logic.
 */
import { useState } from "react";

export type FocusPanel = "sidebar" | "messages" | "composer";

export const useFocus = () => {
  const [activePanel, setActivePanel] = useState<FocusPanel>("sidebar");
  const [sidebarIndex, setSidebarIndex] = useState(0);
  const [messageIndex, setMessageIndex] = useState(0);

  return {
    activePanel,
    messageIndex,
    setActivePanel,
    setMessageIndex,
    setSidebarIndex,
    sidebarIndex
  };
};
