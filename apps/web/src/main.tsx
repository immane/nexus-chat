/**
 * Web Client Entry Point
 *
 * Renders the root App component into the DOM.
 * CSS (Tailwind) is imported here for global style injection.
 */
import { createRoot } from "react-dom/client";
import { App } from "./components/App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
