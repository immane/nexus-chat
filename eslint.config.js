import eslint from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", "docs/site/**"]
  },
  eslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        Request: "readonly",
        Response: "readonly",
        RequestInit: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        document: "readonly",
        window: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        RTCPeerConnection: "readonly",
        RTCSessionDescription: "readonly",
        RTCIceCandidate: "readonly",
        RTCDataChannel: "readonly",
        RTCConfiguration: "readonly",
        RTCIceServer: "readonly",
        RTCSessionDescriptionInit: "readonly",
        RTCIceCandidateInit: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        React: "readonly",
        HTMLDivElement: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        Node: "readonly",
        File: "readonly",
        AbortController: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLImageElement: "readonly",
        HTMLElement: "readonly",
        Notification: "readonly"
      }
    }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { sourceType: "module" }
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  prettier
];
