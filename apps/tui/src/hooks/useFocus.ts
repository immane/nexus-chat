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
