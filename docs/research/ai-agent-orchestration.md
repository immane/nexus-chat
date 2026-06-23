---
lang: en
---

# AI Agent Orchestration & Streaming Interaction Design — Research Report

> nexus-chat · Slack-like IM platform
> Research date: June 2026 · Status: Draft v1.0
> References: Bot Engine Design, Gateway Layer Design, Base Bot Catalog

---

## Table of Contents

1. [Streaming Message Design for IM](#1-streaming-message-design-for-im)
2. [AI Agent Orchestration Architecture](#2-ai-agent-orchestration-architecture)
3. [Context & Memory Management](#3-context--memory-management)
4. [Tool Calling & SDK Integration](#4-tool-calling--sdk-integration)
5. [Multi-Provider LLM Abstraction](#5-multi-provider-llm-abstraction)
6. [Prompt Engineering for IM Context](#6-prompt-engineering-for-im-context)
7. [Performance & Cost Optimization](#7-performance--cost-optimization)
8. [Privacy & Compliance](#8-privacy--compliance)
9. [User Experience Design](#9-user-experience-design)

---

## 1. Streaming Message Design for IM

### 1.1 Problem Statement

IM platforms are **message-at-a-time**: a user sends a message, the system delivers a complete message atomically. LLMs produce output **token-by-token** via Server-Sent Events (SSE) over HTTP, with latencies of 5–40s for full responses. Bridging these two paradigms requires a streaming protocol that converts a token stream into progressive message updates visible in the chat UI.

```
Traditional IM:           User ──[full message]──> Server ──[full message]──> Recipients
LLM Streaming:            User ──[prompt]──> LLM ──[t1][t2][t3]...[tN]──> Client
nexus-chat needs:  User ──[prompt]──> AI Bot ──[chunk1][chunk2]...[chunkN]──> Channel (visible to all)
```

### 1.2 Streaming WebSocket Protocol Extension

nexus-chat already uses Socket.IO v4 with a typed event envelope (`GatewayMessage`). We extend the existing protocol with three new event types to support streaming partial message updates.

#### 1.2.1 New Event Types

```typescript
// packages/shared/src/events/streaming.ts

export const StreamingEvents = {
  // --- Server → Client ---

  /** Sent when AI begins generating a response. Creates a placeholder message in the UI. */
  "message.stream_start": (data: {
    streamId: string;           // Unique stream identifier (UUID v7)
    channelId: string;
    workspaceId: string;
    botId: string;
    parentMessageId?: string;    // The user message that triggered this response
    threadId?: string;           // Thread context if replying in thread
    /** Initial metadata: the message ID placeholder */
    placeholderMessageId: string; // Pre-allocated message ID for the final message
    estimatedTokens?: number;    // Optional: estimated total tokens for progress bar
  }) => void,

  /** Carries a chunk of generated content. Appended to the placeholder message. */
  "message.stream_chunk": (data: {
    streamId: string;
    channelId: string;
    /** 0-based index of this chunk in the stream */
    chunkIndex: number;
    /** The text delta for this chunk (token or batched tokens) */
    content: string;
    /** Cumulative token count so far */
    tokenCount: number;
    /** Signals the model is calling a tool (interrupts text generation) */
    toolCall?: {
      toolCallId: string;
      toolName: string;
      arguments: string;        // Partial JSON — assembled across multiple chunks
    };
    /** Signals tool call result is being streamed back */
    toolResult?: {
      toolCallId: string;
      result: string;
    };
  }) => void,

  /** Sent when the stream completes (success, error, or user cancellation). */
  "message.stream_end": (data: {
    streamId: string;
    channelId: string;
    /** Final message ID (same as placeholderMessageId) */
    messageId: string;
    status: "completed" | "cancelled" | "error";
    /** Final token usage */
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    error?: {
      code: string;
      message: string;
    };
    /** Any tool calls that were executed during generation */
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>;
  }) => void,

  // --- Client → Server ---

  /** User cancels an in-progress generation. */
  "message.stream_cancel": (data: {
    streamId: string;
    channelId: string;
    reason?: string;
  }) => void,

  /** User approves/rejects a tool call that requires confirmation. */
  "message.stream_tool_response": (data: {
    streamId: string;
    toolCallId: string;
    approved: boolean;
    /** Optional user modification to the tool arguments */
    modifiedArguments?: Record<string, unknown>;
  }) => void,
} as const;
```

#### 1.2.2 Stream Lifecycle State Machine

```
                    ┌──────────┐
         start ────>│ STREAMING│── chunk ──> STREAMING (loop)
                    └────┬─────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
          ▼              ▼              ▼
     ┌─────────┐   ┌──────────┐   ┌────────┐
     │COMPLETED│   │CANCELLED │   │ ERROR  │
     └─────────┘   └──────────┘   └────────┘
```

**Key design decisions:**

1. **Pre-allocated message ID**: The `stream_start` event carries a `placeholderMessageId` (UUID v7). The client creates a skeleton message immediately, enabling it to appear in the correct chronological position in the message list. This avoids reordering when the full response arrives later.

2. **Chunk-by-chunk append**: Each `stream_chunk` is an append operation, not a replace. The client concatenates the `content` field to the existing message body. This eliminates the need for diff/patch semantics.

3. **Tool call interlacing**: Tool calls are embedded within the stream. When the LLM requests a tool, a `stream_chunk` carries `toolCall` data. The UI shows an interstitial "Using tool: X…" indicator. When the tool result returns, another chunk carries `toolResult`.

4. **Bidirectional control**: The client can cancel (`stream_cancel`) or respond to tool confirmation prompts (`stream_tool_response`) on the same WebSocket connection — a key advantage of WebSocket over SSE (see §1.3).

5. **Garbage collection**: If a stream is cancelled or errors, the placeholder message is replaced with an error notice. If the WebSocket disconnects mid-stream, the stream is cancelled server-side after a 10s timeout.

#### 1.2.3 Why WebSocket, Not SSE

The nexus-chat client already maintains a persistent WebSocket connection. Adding SSE would require a second HTTP connection. More importantly, WebSocket provides capabilities that SSE cannot:

| Capability | WebSocket | SSE |
|---|---|---|
| Cancellation (client → server) | Native bidirectional | Requires separate HTTP request |
| Tool confirmation | Same connection | Separate HTTP request + correlation |
| Backpressure (slow consumer) | TCP flow control + app-level pause/resume | None |
| Reconnection with state recovery | Socket.IO built-in reconnect | `EventSource` reconnect loses generation state |
| Single connection model | Yes (nexus-chat already has WS) | No (second connection required) |

**Reference**: The WebSocket.org analysis (March 2026) identifies that "SSE breaks for agentic workflows" because it lacks bidirectionality, backpressure, and durable session state. The Vercel AI SDK deprecated its SSE-based `StreamingTextResponse` in favor of a pluggable `ChatTransport` interface. Anthropic's MCP deprecated HTTP+SSE entirely, replacing it with Streamable HTTP. All major frameworks are converging on transport-agnostic abstractions that favor bidirectional protocols.

### 1.3 Chunk Delivery & Rate Limiting

#### 1.3.1 Throttling Strategy

LLMs can produce tokens at 50–200 tokens/sec depending on the model and provider. Sending every token as a separate WebSocket message would overwhelm the client's rendering pipeline and waste bandwidth. The recommended strategy:

```typescript
// packages/ai-bot/src/streaming/chunk-batcher.ts

export class ChunkBatcher {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chunkIndex = 0;

  constructor(
    private emit: (chunk: StreamingChunk) => void,
    private config: {
      /** Maximum interval between chunk emissions (ms) */
      maxIntervalMs: number;        // default: 100
      /** Minimum characters before forced flush */
      minChars: number;             // default: 1
      /** Flush on newline (for natural break points) */
      flushOnNewline: boolean;      // default: true
    } = { maxIntervalMs: 100, minChars: 1, flushOnNewline: true },
  ) {}

  push(token: string): void {
    this.buffer.push(token);

    // Flush immediately on natural break points
    if (this.config.flushOnNewline && token.includes("\n")) {
      this.flush();
      return;
    }

    // Start or reset the timer
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.config.maxIntervalMs);
    }
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;

    const content = this.buffer.join("");
    this.buffer = [];
    this.emit({ chunkIndex: this.chunkIndex++, content });
  }
}
```

**Throttling parameters:**

| Parameter | Value | Rationale |
|---|---|---|
| Max chunk interval | 100ms | Human perception of smoothness; <100ms feels instantaneous |
| Min characters per chunk | 1 | Don't hold single chars too long; the timer enforces the ceiling |
| Flush on newline | Yes | Natural break points for progressive markdown rendering |
| Max chunk size | 500 chars | Prevents oversized chunks on very fast models |

#### 1.3.2 Generation Limits

| Limit | Value | Rationale |
|---|---|---|
| Max output tokens per generation | 4096 | Covers most IM use cases (summaries, translations, Q&A); prevents runaway |
| Max generation time (wall clock) | 60s | Hard deadline; cancels the stream if exceeded |
| Max concurrent streams per workspace | 10 | Prevents abuse; queued beyond this |
| Max streams per user | 3 | One per channel/thread is reasonable |
| Max total input tokens (context) | 32K | Balances context richness with cost |

### 1.4 UI Patterns for Streaming Messages

#### 1.4.1 The Three-Phase Rendering Model

```
Phase 1: PLACEHOLDER (stream_start)
  ┌──────────────────────────────────────────┐
  │ @AIBot                                    │
  │ ┌──────────────────────────────────────┐  │
  │ │  ● Thinking…                         │  │
  │ │  ═══════════════════════ (animated)  │  │
  │ └──────────────────────────────────────┘  │
  │                         [ Cancel ]        │
  └──────────────────────────────────────────┘

Phase 2: STREAMING (stream_chunk × N)
  ┌──────────────────────────────────────────┐
  │ @AIBot                                    │
  │ ┌──────────────────────────────────────┐  │
  │ │  The current weather in Tokyo is     │  │
  │ │  22°C with partly cloudy skies.      │  │
  │ │  Expect light rain in the evening. █ │  │ ← blinking cursor
  │ └──────────────────────────────────────┘  │
  │                         [ Cancel ]        │
  └──────────────────────────────────────────┘

Phase 3: COMPLETE (stream_end)
  ┌──────────────────────────────────────────┐
  │ @AIBot                                    │
  │ ┌──────────────────────────────────────┐  │
  │ │  The current weather in Tokyo is     │  │
  │ │  22°C with partly cloudy skies.      │  │
  │ │  Expect light rain in the evening.   │  │
  │ └──────────────────────────────────────┘  │
  │  12:34 PM  ·  142 tokens                 │
  └──────────────────────────────────────────┘
```

#### 1.4.2 Progressive Markdown Rendering

As chunks arrive, the client incrementally renders markdown. This requires a markdown renderer that handles partial/incomplete syntax gracefully:

```typescript
// apps/web/src/lib/streaming-markdown.ts

/**
 * Renders partial markdown from a streaming source.
 * Handles incomplete code fences, partial lists, and mid-token text.
 */
export class StreamingMarkdownRenderer {
  private buffer = "";
  private renderer: MarkdownIt;

  constructor() {
    this.renderer = new MarkdownIt({
      html: false,          // No HTML in streaming (security)
      linkify: true,
      typographer: true,
    });
  }

  /** Append a chunk and return rendered HTML */
  append(chunk: string): string {
    this.buffer += chunk;

    // Strategy: render the buffer, but strip trailing incomplete blocks
    // to prevent flickering (e.g., a half-written code fence)
    return this.renderer.render(this.sanitizeBuffer());
  }

  private sanitizeBuffer(): string {
    let text = this.buffer;

    // If we're inside an unclosed code fence, temporarily close it
    const openFences = (text.match(/```/g) || []).length;
    if (openFences % 2 !== 0) {
      text += "\n```"; // Close temporarily — will be reopened by next chunk
    }

    return text;
  }

  /** Get the final rendered HTML when stream completes */
  final(): string {
    return this.renderer.render(this.buffer);
  }
}
```

**Key techniques from ChatGPT and Claude chat UIs:**

1. **Cursor blinking**: A CSS `@keyframes blink` on a `█` character appended to the streaming content. Removed when `stream_end` arrives.
2. **Scroll lock**: When the user scrolls up to read previous messages, auto-scroll is paused. Resumes when they scroll to the bottom or a new user message is sent.
3. **Token count display**: Shows `142 tokens` on completion. During generation, shows `Generating…` with an animated progress bar based on `estimatedTokens`.
4. **Cancel button**: Visible during generation. Sends `message.stream_cancel`. The partial message remains in the channel with a note: `[Generation cancelled]`.

#### 1.4.3 Tool Call Visualization

When the AI calls a tool (e.g., web search, database query), the UI shows an interstitial:

```
┌──────────────────────────────────────────┐
│ @AIBot                                    │
│ ┌──────────────────────────────────────┐  │
│ │  Let me check the latest data…       │  │
│ │                                      │  │
│ │  🔍 Searching channel history…       │  │ ← Tool indicator
│ │  ═══════════════════════ (animated)  │  │
│ └──────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

After the tool returns, the stream continues with the result incorporated.

### 1.5 Comparison with Existing Implementations

| Platform | Streaming Model | Key Characteristics | Relevance to nexus-chat |
|---|---|---|---|
| **Slack (Slackbot AI)** | Block Kit streaming (experimental) | Message updates via `chat.update`; no native token-level streaming. Uses Block Kit elements for progressive reveal. | Low — Slack does not offer true token streaming in its public API; uses message replacement |
| **Discord (Clyde, deprecated)** | Message replacement | Clyde posted a placeholder then edited the message with content. Not true streaming — full edits at intervals. | Low — deprecated; approach is similar to Phase 1 fallback |
| **GitHub Copilot Chat** | SSE over HTTP | Token-level streaming in the chat panel; inline code suggestions. VS Code extension uses custom protocol, not IM-style. | Medium — good reference for code-block streaming but not IM-native |
| **ChatGPT / Claude** | SSE over HTTP | Token-level streaming with markdown rendering. Cursor animation, progressive code blocks, tool call interludes. Gold standard for UX. | High — direct reference for UI patterns, progressive rendering, tool call visualization |
| **Grok (X/Twitter)** | WebSocket + SSE hybrid | Streaming responses appear inline in the X timeline. Uses WebSocket for real-time delivery. | Medium — closest to IM-native streaming; shows streaming in a message feed |

**Key takeaway**: No major IM platform has a mature, publicly documented streaming message protocol. nexus-chat has the opportunity to **define a first-class streaming message primitive** in its WebSocket protocol, which would be a differentiator for both the AI Assistant Bot and third-party bots.

---

## 2. AI Agent Orchestration Architecture

### 2.1 Agent Models

#### 2.1.1 Model Spectrum

```
Simple ───────────────────────────────────────────────────> Complex

Single LLM Call      LLM + Tools        Multi-Agent         Autonomous Loop
   │                     │                   │                    │
   │  System prompt      │  Function calling  │  Supervisor-worker  │  Plan→Execute→Observe
   │  + user message     │  + SDK API tools   │  Debate pattern     │  →Reflect→Replan
   │  → response         │  → response        │  Chain decomposition│  (AutoGPT/BabyAGI)
   │                     │                    │                     │
   ▼                     ▼                    ▼                     ▼
  /ai ask              /ai summarize       /ai research          (Future: Phase 3+)
  /ai translate        /ai search          Complex multi-step
                       /ai draft           workflows
```

**Recommendation for nexus-chat Phase 2**: Start with **Single Agent + Tools** (LLM + function calling). This covers 90% of use cases (summarize, translate, ask, search, draft). Multi-agent orchestration should be deferred to Phase 3 when the tool ecosystem and observability infrastructure are mature.

#### 2.1.2 Single Agent with Tools (Recommended Starting Point)

```
User: "/ai search Q3 roadmap discussion"
        │
        ▼
┌──────────────────────────────────────────┐
│               AI Assistant Bot             │
│                                            │
│  1. System prompt + user message          │
│  2. LLM decides: need to search channels  │
│  3. Tool call: searchChannels("Q3 roadmap")│
│  4. SDK API → PostgreSQL full-text search │
│  5. Results injected into context         │
│  6. LLM synthesizes response             │
│  7. Stream response back to channel       │
└──────────────────────────────────────────┘
```

#### 2.1.3 Multi-Agent Patterns (Future: Phase 3+)

**Supervisor-Worker Pattern** (LangGraph Supervisor):

```
                    ┌──────────────┐
                    │  Supervisor  │
                    │  (Router)    │
                    └──┬───┬───┬──┘
                       │   │   │
          ┌────────────┘   │   └────────────┐
          ▼                ▼                ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Research │    │  Coding  │    │  Review  │
    │  Agent   │    │  Agent   │    │  Agent   │
    └──────────┘    └──────────┘    └──────────┘
```

Use case: `/ai research "Compare our Q1 vs Q2 deployment incidents"` — supervisor delegates to a search agent (find incidents), an analysis agent (compare patterns), and a report agent (synthesize findings).

**Debate/Collaboration Pattern**:

```
Agent A ──[proposes solution]──> Agent B ──[critiques]──> Agent A ──[revises]──> Output
```

Use case: `/ai draft "Q3 engineering blog post"` — one agent drafts, another critiques for clarity and accuracy.

### 2.2 Agent Frameworks Survey

#### 2.2.1 Framework Comparison Table

| Framework | Language | Streaming | Multi-Agent | Self-Hosted | Complexity | MCP Support | Recommendation |
|---|---|---|---|---|---|---|---|
| **Vercel AI SDK** | TypeScript | First-class (`streamText`, `useChat`) | Basic (subagents via `generateText`) | Yes (open source, MIT) | Low-Medium | Yes (native) | **Primary recommendation** — streaming-first, TypeScript-native, excellent for IM chatbot use case |
| **LangChain / LangGraph** | Python + TS | Yes (`streamEvents`) | Full (LangGraph: stateful, cyclic, supervisor, hierarchical) | Yes (open source, MIT) | High | Yes | **Strong for multi-agent (Phase 3)** — most mature multi-agent orchestration; TS support is less polished than Python |
| **Mastra** | TypeScript | Yes (built-in) | Yes (workflows, agents) | Partial (Apache 2.0 core; Enterprise license for ee/) | Medium | Yes | **Promising alternative** — TypeScript-first, batteries-included (workflows + memory + Studio); younger ecosystem |
| **CrewAI** | Python only | Limited (documented pain points) | Yes (role-based crews) | Yes (open source, MIT) | Medium | Yes | **Not recommended** — Python-only conflicts with nexus-chat's TypeScript stack |
| **AutoGPT / BabyAGI** | Python | No (batch-oriented) | Autonomous loop | Yes (open source) | High | No | **Not recommended** — autonomous loops are not suitable for IM context; high cost and unpredictability |
| **Anthropic MCP** | Protocol (language-agnostic) | N/A (protocol) | N/A (protocol) | Yes (open standard) | Low (for tool definition) | N/A (defines the standard) | **Adopt as tool standard** — use MCP for tool declaration; not an agent framework itself |
| **OpenAI Assistants API** | REST API (managed) | Yes | Thread-based single agent | No (SaaS only) | Low | No (proprietary) | **Not recommended** — vendor lock-in, no self-hosting, cost at scale; use only as a provider |
| **OpenAI Agents SDK** | Python only | Via API | Yes (handoff, delegation) | Yes (open source, MIT) | Low-Medium | Yes | **Not recommended** — Python-only; good reference for handoff patterns |
| **Microsoft Agent Framework** | Python + .NET | Yes | Full (sequential, concurrent, handoff, group chat) | Yes (open source, MIT) | High | Yes (native) | **Not recommended** — .NET/Python focus; strong but wrong ecosystem for nexus-chat |

#### 2.2.2 Detailed Framework Analysis

**Vercel AI SDK (v6, 2026)** — Primary recommendation for Phase 2

- **Streaming**: `streamText()` returns `AsyncGenerator<Chunk>`. Built-in support for streaming tool calls, structured output, and multi-step generations. The `useChat()` hook handles all streaming UI state (messages, status, error, reload).
- **Provider abstraction**: `generateText({ model: openai('gpt-4o') })` → swap to `anthropic('claude-sonnet-4-20250514')` with one line change. 20+ built-in providers.
- **Tools**: Declarative tool definitions with Zod schemas. `tool({ description: '...', parameters: z.object({...}), execute: async (args) => {...} })`.
- **MCP integration**: Native `mcpTools()` client that connects to MCP servers and exposes their tools.
- **Agent primitives**: `generateText()` with `maxSteps` for multi-step tool-calling loops. `subagents` for delegation. Memory abstraction.
- **Licensing**: MIT, fully open source.

**LangChain / LangGraph** — Recommended for Phase 3 multi-agent

- **Strengths**: 134K GitHub stars, 1,000+ integrations, most mature multi-agent orchestration (LangGraph). Python ecosystem is richer than TypeScript.
- **Weaknesses**: TypeScript support lags behind Python. Heavy abstraction can obscure failure modes. Version churn has been a community complaint.
- **When to use**: If Phase 3 requires complex multi-agent workflows (supervisor pattern, debate pattern, hierarchical routing), LangGraph is the most battle-tested choice. Consider wrapping it as a microservice behind a TypeScript API.

**Mastra** — Monitor for maturity

- **Strengths**: TypeScript-first, built by the Gatsby team. Bundles workflows, memory (Memory Gateway), observability (Studio), and MCP support in one package. Integrates with Vercel AI SDK UI.
- **Weaknesses**: Younger ecosystem (23K stars). Partial open source (Enterprise license for ee/). Opinionated defaults can be restrictive.
- **When to consider**: If by Phase 3 Mastra has matured and the team wants a single-vendor TypeScript solution covering agent orchestration + memory + observability.

### 2.3 Recommended Architecture for nexus-chat AI Assistant Bot

```
                              ┌─────────────────────────────────────┐
                              │          nexus-chat Client           │
                              │  ┌────────────────────────────────┐  │
                              │  │  Chat UI (react-virtuoso)       │  │
                              │  │  ├── Streaming message renderer │  │
                              │  │  ├── Cancel button              │  │
                              │  │  └── Tool call confirmation UI  │  │
                              │  └────────────────────────────────┘  │
                              │  ┌────────────────────────────────┐  │
                              │  │  WebSocket Client (Socket.IO)   │  │
                              │  │  ├── message.stream_start       │  │
                              │  │  ├── message.stream_chunk       │  │
                              │  │  ├── message.stream_end         │  │
                              │  │  └── message.stream_cancel      │  │
                              │  └────────────────────────────────┘  │
                              └──────────────┬──────────────────────┘
                                             │ WSS
┌────────────────────────────────────────────┼──────────────────────────┐
│                           Gateway Layer    │                          │
│  ┌─────────────────────────────────────────┴────────────────────────┐ │
│  │  Socket.IO Server + Redis Adapter                                 │ │
│  │  ├── Auth middleware (JWT for users, nxbot_v1 tokens for bots)   │ │
│  │  ├── Room routing (channel:{id})                                  │ │
│  │  └── Stream event relay                                           │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘
                                             │
┌────────────────────────────────────────────┼──────────────────────────┐
│                           AI Bot Engine    │                          │
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────────┐│
│  │  Command Parser  │───>│   Agent Router  │───>│   LLM Provider      ││
│  │                  │    │                 │    │   (Abstraction)     ││
│  │  /ai ask         │    │  Intent → Agent │    │                     ││
│  │  /ai summarize   │    │  Selection      │    │  ┌───────────────┐  ││
│  │  /ai search      │    │                 │    │  │ OpenAI GPT-4o │  ││
│  │  /ai translate   │    │                 │    │  │ Anthropic      │  ││
│  │  /ai draft       │    │                 │    │  │   Claude 4    │  ││
│  │  @ai mention     │    │                 │    │  │ Gemini 2.5 Pro│  ││
│  └─────────────────┘    └────────┬────────┘    │  │ OpenRouter    │  ││
│                                  │             │  │ Ollama (local) │  ││
│                                  ▼             │  └───────────────┘  ││
│  ┌─────────────────────────────────────────┐   └─────────────────────┘│
│  │            Tool Executor                 │                         │
│  │                                          │                         │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │                         │
│  │  │ SDK API  │ │ Web      │ │ Code     │ │                         │
│  │  │ Calls    │ │ Fetch    │ │ Execution│ │                         │
│  │  │          │ │          │ │          │ │                         │
│  │  │ sendMsg  │ │ HTTP GET │ │ Sandbox  │ │                         │
│  │  │ getChan  │ │ to URLs  │ │ (E2B /   │ │                         │
│  │  │ searchMsgs│ │         │ │  Docker) │ │                         │
│  │  │ listUsers│ │          │ │          │ │                         │
│  │  └──────────┘ └──────────┘ └──────────┘ │                         │
│  └─────────────────────────────────────────┘                         │
│                                                                       │
│  ┌─────────────────────────────────────────┐                         │
│  │            Memory Manager               │                         │
│  │                                          │                         │
│  │  ┌──────────────┐ ┌──────────────────┐  │                         │
│  │  │ Conversation │ │ Vector Store     │  │                         │
│  │  │ History      │ │ (pgvector)       │  │                         │
│  │  │ (Sliding     │ │                  │  │                         │
│  │  │  Window)     │ │ Semantic search  │  │                         │
│  │  │              │ │ over channel     │  │                         │
│  │  │ Summarization│ │ history          │  │                         │
│  │  │ (Redis cache)│ │                  │  │                         │
│  │  └──────────────┘ └──────────────────┘  │                         │
│  └─────────────────────────────────────────┘                         │
│                                                                       │
│  ┌─────────────────────────────────────────┐                         │
│  │            Stream Manager               │                         │
│  │                                          │                         │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ │                         │
│  │  │ Chunk    │ │ Chunk    │ │ Cancel   │ │                         │
│  │  │ Batcher  │ │ Emitter  │ │ Handler  │ │                         │
│  │  │ (100ms)  │ │ (WS)     │ │          │ │                         │
│  │  └──────────┘ └──────────┘ └──────────┘ │                         │
│  └─────────────────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────────────┘
```

#### 2.3.1 Core TypeScript Types

```typescript
// packages/ai-bot/src/types.ts

import { type Tool as VercelTool } from "ai";

// ── Agent Definition ──────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  /** System prompt template with {variables} */
  systemPrompt: string;
  /** Tools available to this agent */
  tools: Record<string, Tool>;
  /** LLM model to use */
  model: string;
  /** Maximum steps for tool-calling loops */
  maxSteps?: number;
  /** Context strategy */
  context: {
    maxMessages: number;
    includeThreadHistory: boolean;
    includeChannelTopic: boolean;
    includeUserProfile: boolean;
  };
}

// ── Tool Definition ───────────────────────────────

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for parameters */
  parameters: Record<string, unknown>;
  /** Execution function */
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  /** Requires user confirmation before execution */
  requiresConfirmation?: boolean;
  /** Confirmation message template */
  confirmationMessage?: string;
}

// ── Execution Context ─────────────────────────────

export interface ToolContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  /** Bot SDK API client (scoped to this bot) */
  api: BotApiClient;
}

// ── Stream Chunk (internal to AI Bot Engine) ──────

export type StreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; arguments: string }
  | { type: "tool_result"; toolCallId: string; result: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: TokenUsage };

// ── Token Usage ────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── LLM Provider Interface ─────────────────────────

export interface LLMProvider {
  /** Chat completion returning an async generator of chunks */
  chat(
    messages: ChatMessage[],
    tools?: Tool[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamChunk>;

  /** Generate embeddings for a text */
  embeddings(text: string): Promise<number[]>;

  /** Maximum context window in tokens */
  maxContextTokens: number;

  /** Provider name for logging/cost tracking */
  providerName: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;      // For 'tool' role
  toolCalls?: ToolCall[];   // For 'assistant' role
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}
```

#### 2.3.2 Command Parser & Agent Router

```typescript
// packages/ai-bot/src/router.ts

import { parseSlashCommand } from "@nexus-chat/bot-engine";

const AI_COMMANDS: Record<string, AgentDefinition> = {
  "ask": askAgent,
  "summarize": summarizeAgent,
  "translate": translateAgent,
  "draft": draftAgent,
  "search": searchAgent,
};

export class AiCommandRouter {
  route(message: IncomingMessage): AgentInvocation | null {
    // Case 1: /ai slash command
    const parsed = parseSlashCommand(message.text);
    if (parsed?.botName === "ai") {
      const agent = AI_COMMANDS[parsed.command];
      if (!agent) return null; // Unknown subcommand
      return {
        agent,
        intent: parsed.command,
        input: parsed.args.join(" "),
        channelId: message.channelId,
        threadId: message.threadId,
        userId: message.userId,
      };
    }

    // Case 2: @ai mention in a message
    const mentionMatch = message.text.match(/^@ai\s+(.+)/s);
    if (mentionMatch) {
      return {
        agent: askAgent, // Default: Q&A agent for mentions
        intent: "mention",
        input: mentionMatch[1],
        channelId: message.channelId,
        threadId: message.threadId,
        userId: message.userId,
      };
    }

    // Case 3: @ai mention in a thread reply
    if (message.threadId && message.text.includes("@ai")) {
      const threadMatch = message.text.match(/@ai\s+(.+)/s);
      if (threadMatch) {
        return {
          agent: askAgent,
          intent: "thread_mention",
          input: threadMatch[1],
          channelId: message.channelId,
          threadId: message.threadId,
          userId: message.userId,
        };
      }
    }

    return null;
  }
}
```

---

## 3. Context & Memory Management

### 3.1 Context Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   LLM Context Window                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Layer 1: System Prompt (~500 tokens)              │  │
│  │  - Bot persona, workspace info, user role           │  │
│  │  - Channel topic, current date/time                 │  │
│  ├───────────────────────────────────────────────────┤  │
│  │  Layer 2: Conversation Window (~N recent messages) │  │
│  │  - Sliding window of recent channel messages        │  │
│  │  - Thread history (if in thread)                    │  │
│  ├───────────────────────────────────────────────────┤  │
│  │  Layer 3: RAG Context (semantic search results)    │  │
│  │  - Top-K relevant messages from channel history     │  │
│  │  - Injected when user asks historical questions     │  │
│  ├───────────────────────────────────────────────────┤  │
│  │  Layer 4: User Input (~N tokens)                   │  │
│  │  - The user's current message/question              │  │
│  ├───────────────────────────────────────────────────┤  │
│  │  Layer 5: Generation Budget (remaining)            │  │
│  │  - Reserved for LLM output                          │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Conversation Sliding Window

```typescript
// packages/ai-bot/src/memory/conversation-window.ts

export class ConversationWindow {
  constructor(
    private config: {
      maxMessages: number;     // default: 50
      maxTokens: number;       // default: 24_000 (reserves 8K for output on 32K model)
    },
  ) {}

  async buildContext(
    channelId: string,
    threadId?: string,
    userMessage?: string,
  ): Promise<ChatMessage[]> {
    // Fetch recent messages
    const messages = await this.fetchRecentMessages(channelId, threadId, this.config.maxMessages);

    // Convert to ChatMessage format
    let chatMessages = messages.map(toChatMessage);

    // Truncate to token budget (oldest first removed)
    chatMessages = this.truncateToBudget(chatMessages, this.config.maxTokens);

    // Prepend summarization of truncated messages if any were removed
    if (messages.length > chatMessages.length) {
      const truncated = messages.slice(0, messages.length - chatMessages.length);
      const summary = await this.summarizeMessages(truncated);
      chatMessages.unshift({
        role: "system",
        content: `[Earlier conversation summary]: ${summary}`,
      });
    }

    return chatMessages;
  }
}
```

### 3.3 Conversation Summarization

When the conversation exceeds the context window, older messages are summarized rather than discarded:

```typescript
// packages/ai-bot/src/memory/summarizer.ts

const SUMMARIZE_PROMPT = `Summarize this conversation excerpt concisely. 
Include key decisions, action items, and important facts. 
Omit small talk, greetings, and redundant information.

Conversation:
{messages}

Summary:`;

export async function summarizeConversation(
  messages: Message[],
  provider: LLMProvider,
): Promise<string> {
  const text = messages
    .map((m) => `[${m.userName}]: ${m.content}`)
    .join("\n");

  const chunks: string[] = [];
  const generator = provider.chat([
    { role: "user", content: SUMMARIZE_PROMPT.replace("{messages}", text) },
  ], undefined, { maxTokens: 500 });

  for await (const chunk of generator) {
    if (chunk.type === "text") chunks.push(chunk.content);
  }

  return chunks.join("");
}
```

**Implementation strategy:**

1. Track a `summarized_until` cursor per channel — messages before this are summarized.
2. When a new summarization is needed, summarize the `[summarized_until, oldest_in_window)` range.
3. Concatenate: `[summary_N, summary_N-1, ..., summary_1, recent_message_1, ... recent_message_K]`.
4. Store summaries in Redis: `ai:summary:{channelId}:{rangeStart}:{rangeEnd}`.
5. Re-summarize when summaries exceed a certain count (summarize summaries).

### 3.4 RAG: Semantic Search over Channel History

#### 3.4.1 Vector Database Selection

| Option | Pros | Cons | Recommendation |
|---|---|---|---|
| **pgvector (PostgreSQL)** | Already in stack; zero additional ops; ACID; join with message data; filtering by channel/workspace | Slower than dedicated vector DBs at >10M vectors; IVF index needed for scale | **Primary recommendation** — simplest, already deployed |
| **Pinecone** | Fully managed; fastest at scale; hybrid search (dense + sparse) | Additional cost; data leaves your infra; vendor lock-in | Phase 3 if pgvector hits limits |
| **Weaviate** | Self-hosted or cloud; hybrid search; GraphQL API | Additional infra to manage | Alternative to Pinecone for self-hosted |
| **Qdrant** | Rust-based; fast; self-hosted or cloud; filtering | Additional infra to manage | Alternative for performance-critical deployments |
| **Redis (with vector search)** | Already in stack; fast; TTL support | Requires Redis Stack license (SSPL); less mature than pgvector | Consider if using Redis Stack already |

#### 3.4.2 Embedding Strategy

```typescript
// packages/ai-bot/src/memory/vector-index.ts

import { sql } from "drizzle-orm";

export class ChannelVectorIndex {
  constructor(
    private db: DrizzleClient,
    private provider: LLMProvider,
  ) {}

  /** Index a new message for semantic search */
  async indexMessage(message: Message): Promise<void> {
    const embedding = await this.provider.embeddings(
      `[${message.userName}]: ${message.content}`,
    );

    await this.db.execute(sql`
      INSERT INTO message_embeddings (message_id, channel_id, workspace_id, embedding)
      VALUES (${message.id}, ${message.channelId}, ${message.workspaceId}, ${JSON.stringify(embedding)}::vector)
    `);
  }

  /** Semantic search across channel history */
  async search(
    query: string,
    channelId: string,
    options?: { limit?: number; threshold?: number },
  ): Promise<ScoredMessage[]> {
    const queryEmbedding = await this.provider.embeddings(query);
    const limit = options?.limit ?? 10;
    const threshold = options?.threshold ?? 0.7;

    const results = await this.db.execute<ScoredMessage>(sql`
      SELECT 
        m.id, m.content, m.user_id, m.created_at,
        1 - (me.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) AS similarity
      FROM message_embeddings me
      JOIN messages m ON m.id = me.message_id
      WHERE me.channel_id = ${channelId}
        AND 1 - (me.embedding <=> ${JSON.stringify(queryEmbedding)}::vector) > ${threshold}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `);

    return results;
  }
}
```

#### 3.4.3 RAG Injection Strategy

```typescript
// packages/ai-bot/src/memory/rag-injector.ts

export async function injectRagContext(
  userQuery: string,
  channelId: string,
  conversationMessages: ChatMessage[],
  vectorIndex: ChannelVectorIndex,
): Promise<ChatMessage[]> {
  // Determine if the query is historical/referential
  const needsHistory = detectHistoricalIntent(userQuery);
  if (!needsHistory) return conversationMessages;

  // Search for relevant past messages
  const results = await vectorIndex.search(userQuery, channelId, { limit: 5 });

  if (results.length === 0) return conversationMessages;

  // Format search results as context
  const contextBlock = [
    "[Relevant past messages from this channel]:",
    ...results.map((r, i) =>
      `[${i + 1}] ${r.userName} (${r.createdAt}): ${r.content}`
    ),
  ].join("\n");

  // Inject after system prompt, before conversation history
  return [
    conversationMessages[0], // System prompt
    { role: "system", content: contextBlock },
    ...conversationMessages.slice(1),
  ];
}

/** Heuristic to detect if a query needs historical context */
function detectHistoricalIntent(query: string): boolean {
  const patterns = [
    /what did .* say about/i,
    /earlier.*discussion/i,
    /previous.*conversation/i,
    /mentioned.*before/i,
    /last (week|month).*discussed/i,
    /remember when/i,
    /recap/i,
    /what was decided/i,
    /past.*decision/i,
  ];
  return patterns.some((p) => p.test(query));
}
```

### 3.5 Context Injection Templates

```
┌─────────────────────────────────────────────┐
│ Layer 1: System Prompt                       │
│                                              │
│ Workspace: Acme Corp (Engineering)           │
│ Channel:   #backend-discussion               │
│ Topic:     "Backend architecture & API design"│
│ Current user: @alice (Role: Admin)           │
│ Date:      2026-06-24                        │
│                                              │
│ Layer 2: Conversation Window                 │
│ [Last 20 messages in #backend-discussion]    │
│                                              │
│ Layer 3: RAG Injection (conditional)         │
│ [Top 5 semantically relevant past messages]  │
│                                              │
│ Layer 4: Thread Context (if in thread)       │
│ Parent: @bob: "Should we use Redis Streams?" │
│ Thread replies: [5 most recent in thread]    │
│                                              │
│ Layer 5: User Input                          │
│ @alice: "/ai ask what did we decide about    │
│          the event bus?"                     │
└─────────────────────────────────────────────┘
```

---

## 4. Tool Calling & SDK Integration

### 4.1 Tool Declaration Format

nexus-chat should use **OpenAI function calling format** as the canonical tool declaration (it is the de facto standard, supported by OpenAI, Anthropic (tool_use), Google Gemini, and OpenRouter):

```typescript
// packages/ai-bot/src/tools/registry.ts

export const NEXUS_CHAT_TOOLS: Tool[] = [
  {
    name: "sendMessage",
    description: "Send a message to the current channel",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The message text (supports markdown)",
        },
      },
      required: ["content"],
    },
    requiresConfirmation: false,
    execute: async (args, ctx) => {
      return ctx.api.sendMessage(ctx.channelId, args.content as string);
    },
  },

  {
    name: "searchChannelHistory",
    description: "Search for messages in the current channel by keyword",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (keywords or natural language)",
        },
        limit: {
          type: "number",
          description: "Max results (default 10, max 50)",
        },
        fromDate: {
          type: "string",
          description: "Start date in ISO format (optional)",
        },
      },
      required: ["query"],
    },
    execute: async (args, ctx) => {
      return ctx.api.searchMessages(ctx.channelId, {
        query: args.query as string,
        limit: (args.limit as number) || 10,
        fromDate: args.fromDate as string | undefined,
      });
    },
  },

  {
    name: "getChannelInfo",
    description: "Get information about the current channel",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_args, ctx) => {
      return ctx.api.getChannelInfo(ctx.channelId);
    },
  },

  {
    name: "listChannelMembers",
    description: "List members of the current channel",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_args, ctx) => {
      return ctx.api.listChannelMembers(ctx.channelId);
    },
  },

  {
    name: "getUserProfile",
    description: "Get a user's profile information",
    parameters: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "The user's ID or @username mention",
        },
      },
      required: ["userId"],
    },
    execute: async (args, ctx) => {
      return ctx.api.getUserProfile(args.userId as string);
    },
  },

  {
    name: "archiveChannel",
    description: "Archive (close) the current channel. THIS IS DESTRUCTIVE.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Reason for archiving",
        },
      },
      required: ["reason"],
    },
    requiresConfirmation: true,
    confirmationMessage: "Archive this channel? All members will lose access.",
    execute: async (args, ctx) => {
      return ctx.api.archiveChannel(ctx.channelId, args.reason as string);
    },
  },

  {
    name: "webFetch",
    description: "Fetch content from a URL (web page, API, documentation)",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
      },
      required: ["url"],
    },
    requiresConfirmation: true,
    confirmationMessage: "Fetch content from {url}? External URLs may not be trusted.",
    execute: async (args, _ctx) => {
      const response = await fetch(args.url as string);
      const text = await response.text();
      // Truncate to avoid overflowing context
      return text.slice(0, 8000);
    },
  },
];
```

### 4.2 Tool Execution Sandbox

| Execution Model | Description | Safety | Recommendation |
|---|---|---|---|
| **Server-side (SDK API)** | Tools execute within the Bot Engine using the SDK client (same process). | High — memory-isolated, same network boundary | **Default for all SDK API tools** |
| **Server-side (HTTP)** | Web fetch and external API calls from within the Bot Engine. | Medium — needs URL allowlisting, rate limiting, timeout | Use with domain allowlisting |
| **Server-side (Code sandbox)** | Execute AI-generated code. Uses E2B or Docker container. | Medium-High — E2B provides gVisor-based isolation | Phase 3: for `/ai code` command |
| **Bot-side** | Tool execution logic lives in the bot's own process (the LLM SDK executor runs server-side but calls out to bot). | N/A — not applicable for built-in AI Bot | For third-party bots only |

**Tool safety classification:**

```
GREEN (auto-execute):
  - searchChannelHistory     (READ-ONLY)
  - getChannelInfo           (READ-ONLY)
  - listChannelMembers       (READ-ONLY)
  - getUserProfile           (READ-ONLY)

YELLOW (auto-execute, logged):
  - sendMessage              (WRITE — but expected for AI responses)
  - webFetch                 (READ — but external)

RED (requires user confirmation):
  - archiveChannel           (DESTRUCTIVE)
  - deleteMessage            (DESTRUCTIVE)
  - removeMember             (DESTRUCTIVE)
  - createChannel            (WRITE — medium impact)
```

### 4.3 User Confirmation for Destructive Actions

When the AI proposes a destructive tool call, the streaming message includes an interactive confirmation:

```typescript
// Example: AI proposes archiving a channel

// 1. AI generates text: "I recommend archiving this channel because..."
// 2. AI emits tool_call: { name: "archiveChannel", arguments: { reason: "..." } }
// 3. Server detects requiresConfirmation: true
// 4. Server sends a special stream_chunk with a confirmation UI:

{
  type: "message.stream_chunk",
  streamId: "str_abc123",
  channelId: "ch_xyz",
  chunkIndex: 5,
  content: "", // No text — this chunk is a confirmation request
  toolCall: {
    toolCallId: "call_123",
    toolName: "archiveChannel",
    arguments: '{"reason": "Channel has been inactive for 6 months"}',
  },
}

// 5. Client renders the confirmation block:
//    ┌──────────────────────────────────────────┐
//    │  "I recommend archiving this channel     │
//    │   because it has been inactive for       │
//    │   6 months and all discussions have       │
//    │   moved to #backend-2026."               │
//    │                                          │
//    │  ⚠️ Archive this channel?                 │
//    │  All members will lose access.           │
//    │                                          │
//    │  [ Confirm ]  [ Cancel ]                 │
//    └──────────────────────────────────────────┘

// 6. User clicks [Confirm]:
//    Client sends: { type: "message.stream_tool_response",
//                    toolCallId: "call_123", approved: true }

// 7. Server executes archiveChannel and sends result as a stream_chunk:
//    { type: "message.stream_chunk", toolResult: { toolCallId: "call_123",
//      result: '{"status":"archived","archivedAt":"2026-06-24T12:00:00Z"}' } }
```

### 4.4 MCP Integration (Future)

Anthropic's Model Context Protocol (MCP) is an open standard for tool declaration and execution. Once the nexus-chat Bot SDK stabilizes, the AI Bot could expose its tools as an MCP server, allowing external MCP-compatible clients to use nexus-chat tools, and conversely, consume external MCP servers' tools:

```
nexus-chat AI Bot                    External MCP Server
(MCP Client)                          (e.g., GitHub MCP)
     │                                       │
     │── listTools() ───────────────────────>│
     │<── [createIssue, searchCode, ...] ────│
     │                                       │
     │── callTool("searchCode", {q: "bug"}) >│
     │<── { results: [...] } ────────────────│
```

MCP should be adopted as the **standard tool declaration format** for third-party bots, while the built-in AI Bot uses the simpler OpenAI function calling format internally for Phase 2.

---

## 5. Multi-Provider LLM Abstraction

### 5.1 Provider Interface

```typescript
// packages/ai-bot/src/providers/types.ts

export interface LLMProvider {
  /** Unique provider identifier */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** Chat completion with streaming */
  chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamChunk>;

  /** Generate text embeddings */
  embeddings(model: string, text: string | string[]): Promise<number[][]>;

  /** Maximum context window size in tokens for a given model */
  maxContextTokens(model: string): number;

  /** Estimate token count for a message array */
  countTokens(messages: ChatMessage[]): Promise<number>;

  /** List available models */
  listModels(): Promise<ModelInfo[]>;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  /** Enable prompt caching (Anthropic-specific) */
  enableCaching?: boolean;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Cost per 1M input tokens (USD) */
  inputCostPer1M: number;
  /** Cost per 1M output tokens (USD) */
  outputCostPer1M: number;
  /** Supports tool/function calling */
  supportsTools: boolean;
  /** Supports vision/image input */
  supportsVision: boolean;
}
```

### 5.2 Provider Implementations

#### 5.2.1 OpenAI Provider

```typescript
// packages/ai-bot/src/providers/openai.ts

import OpenAI from "openai";

export class OpenAIProvider implements LLMProvider {
  readonly id = "openai";
  readonly name = "OpenAI";
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: tools?.map((t) => ({
        type: "function" as const,
        function: t.function,
      })),
      stream: true,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      top_p: options?.topP,
    });

    let toolCallBuffer: Map<number, { id: string; name: string; arguments: string }> = new Map();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // Text content
      if (delta?.content) {
        yield { type: "text", content: delta.content };
      }

      // Tool calls (streamed as partial JSON)
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallBuffer.get(tc.index) || { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallBuffer.set(tc.index, existing);
        }
      }

      // Finish reason: emit tool calls
      if (chunk.choices[0]?.finish_reason === "tool_calls") {
        for (const [, tc] of toolCallBuffer) {
          yield { type: "tool_call", toolCallId: tc.id, toolName: tc.name, arguments: tc.arguments };
        }
        toolCallBuffer.clear();
      }

      // Finish reason: done
      if (chunk.choices[0]?.finish_reason === "stop") {
        if (chunk.usage) {
          yield {
            type: "done",
            usage: {
              promptTokens: chunk.usage.prompt_tokens,
              completionTokens: chunk.usage.completion_tokens,
              totalTokens: chunk.usage.total_tokens,
            },
          };
        }
      }
    }
  }

  async embeddings(model: string, text: string | string[]): Promise<number[][]> {
    const texts = Array.isArray(text) ? text : [text];
    const response = await this.client.embeddings.create({
      model: model || "text-embedding-3-small",
      input: texts,
    });
    return response.data.map((d) => d.embedding);
  }

  maxContextTokens(model: string): number {
    const limits: Record<string, number> = {
      "gpt-4o": 128_000,
      "gpt-4o-mini": 128_000,
      "gpt-4-turbo": 128_000,
      "o3-mini": 200_000,
    };
    return limits[model] ?? 128_000;
  }

  async countTokens(messages: ChatMessage[]): Promise<number> {
    // Use tiktoken for accurate counting; fallback to ~4 chars/token
    let count = 0;
    for (const msg of messages) {
      count += 4; // Role overhead
      count += Math.ceil(msg.content.length / 3.5); // ~3.5 chars per token for English
    }
    return count;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", contextWindow: 128_000, maxOutputTokens: 16384, inputCostPer1M: 2.50, outputCostPer1M: 10.00, supportsTools: true, supportsVision: true },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai", contextWindow: 128_000, maxOutputTokens: 16384, inputCostPer1M: 0.15, outputCostPer1M: 0.60, supportsTools: true, supportsVision: true },
      { id: "o3-mini", name: "o3-mini", provider: "openai", contextWindow: 200_000, maxOutputTokens: 100_000, inputCostPer1M: 1.10, outputCostPer1M: 4.40, supportsTools: true, supportsVision: false },
    ];
  }
}
```

#### 5.2.2 Anthropic Provider

```typescript
// packages/ai-bot/src/providers/anthropic.ts

import Anthropic from "@anthropic-ai/sdk";

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly name = "Anthropic";
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async *chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamChunk> {
    // Extract system message (Anthropic handles it separately)
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    const stream = await this.client.messages.stream({
      model,
      system: systemMsg?.content,
      messages: chatMessages,
      tools: tools?.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
      })),
      max_tokens: options?.maxTokens ?? 4096,
    });

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_delta":
          if (event.delta.type === "text_delta") {
            yield { type: "text", content: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            yield { type: "tool_call", toolCallId: "", toolName: "", arguments: event.delta.partial_json };
          }
          break;

        case "content_block_start":
          if (event.content_block.type === "tool_use") {
            yield {
              type: "tool_call",
              toolCallId: event.content_block.id,
              toolName: event.content_block.name,
              arguments: "",
            };
          }
          break;

        case "message_stop":
          yield {
            type: "done",
            usage: {
              promptTokens: (stream as any).usage?.input_tokens ?? 0,
              completionTokens: (stream as any).usage?.output_tokens ?? 0,
              totalTokens: ((stream as any).usage?.input_tokens ?? 0) + ((stream as any).usage?.output_tokens ?? 0),
            },
          };
          break;
      }
    }
  }

  async embeddings(model: string, text: string | string[]): Promise<number[][]> {
    // Anthropic does not offer embeddings API — delegate to OpenAI or Voyage AI
    throw new Error("Anthropic does not provide embeddings. Use OpenAI or Voyage AI.");
  }

  maxContextTokens(model: string): number {
    const limits: Record<string, number> = {
      "claude-sonnet-4-20250514": 200_000,
      "claude-3-5-sonnet-20241022": 200_000,
      "claude-3-5-haiku-20241022": 200_000,
      "claude-opus-4-20250514": 200_000,
    };
    return limits[model] ?? 200_000;
  }

  async countTokens(messages: ChatMessage[]): Promise<number> {
    const result = await this.client.messages.countTokens({
      model: "claude-sonnet-4-20250514",
      messages: messages.filter((m) => m.role !== "system").map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    });
    return result.input_tokens;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet", provider: "anthropic", contextWindow: 200_000, maxOutputTokens: 16384, inputCostPer1M: 3.00, outputCostPer1M: 15.00, supportsTools: true, supportsVision: true },
      { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", provider: "anthropic", contextWindow: 200_000, maxOutputTokens: 8192, inputCostPer1M: 0.80, outputCostPer1M: 4.00, supportsTools: true, supportsVision: false },
    ];
  }
}
```

#### 5.2.3 Provider Registry & Routing

```typescript
// packages/ai-bot/src/providers/registry.ts

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Route a model ID to the correct provider */
  resolve(modelId: string): { provider: LLMProvider; model: string } {
    // Fully qualified: "openai/gpt-4o" or "anthropic/claude-sonnet-4-20250514"
    const [providerId, ...modelParts] = modelId.split("/");
    if (modelParts.length > 0) {
      const provider = this.providers.get(providerId);
      if (!provider) throw new Error(`Unknown provider: ${providerId}`);
      return { provider, model: modelParts.join("/") };
    }

    // Bare model ID: resolve by prefix convention
    if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3")) {
      return { provider: this.providers.get("openai")!, model: modelId };
    }
    if (modelId.startsWith("claude-")) {
      return { provider: this.providers.get("anthropic")!, model: modelId };
    }
    if (modelId.startsWith("gemini-")) {
      return { provider: this.providers.get("google")!, model: modelId };
    }

    throw new Error(`Cannot resolve model: ${modelId}`);
  }

  /** Get all available models across all providers */
  async listAllModels(): Promise<ModelInfo[]> {
    const allModels: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      allModels.push(...(await provider.listModels()));
    }
    return allModels;
  }
}
```

### 5.3 Provider Selection Strategy

```
Default routing:
  Fast/simple queries (translate, draft, ask) → GPT-4o Mini or Claude 3.5 Haiku
  Complex reasoning (summarize, search synthesis) → GPT-4o or Claude 4 Sonnet
  Very large context (>100K tokens) → Gemini 2.5 Pro (1M context) or Claude (200K)

Fallback chain:
  1. Try primary provider
  2. If rate-limited (429) → exponential backoff + retry (max 3 attempts)
  3. If timeout (>60s) → try fallback provider
  4. If all fail → return cached/graceful degradation response
```

### 5.4 Cost Tracking

```typescript
// packages/ai-bot/src/cost-tracker.ts

export interface CostRecord {
  workspaceId: string;
  channelId: string;
  userId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUSD: number;
  timestamp: Date;
}

export class CostTracker {
  constructor(private db: DrizzleClient) {}

  async record(
    usage: TokenUsage,
    provider: string,
    model: string,
    context: { workspaceId: string; channelId: string; userId: string },
  ): Promise<void> {
    const modelInfo = await this.getModelPricing(provider, model);
    const costUSD =
      (usage.promptTokens / 1_000_000) * modelInfo.inputCostPer1M +
      (usage.completionTokens / 1_000_000) * modelInfo.outputCostPer1M;

    await this.db.insert(costRecords).values({
      ...context,
      provider,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUSD,
      timestamp: new Date(),
    });

    // Emit metric for Prometheus
    aiCostCounter.inc({ workspaceId: context.workspaceId, provider, model }, costUSD);
  }

  /** Get workspace cost summary for the current billing period */
  async getWorkspaceCost(workspaceId: string): Promise<{
    totalCost: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
  }> {
    // Aggregate from cost_records table
    // ...
  }
}
```

---

## 6. Prompt Engineering for IM Context

### 6.1 System Prompt Template

```typescript
// packages/ai-bot/src/prompts/system.ts

export const SYSTEM_PROMPT_TEMPLATE = `You are the AI Assistant for {workspaceName}, an instant messaging workspace. 
You help users by answering questions, summarizing conversations, drafting messages, translating text, and searching channel history.

## Your Identity
- Name: @AIBot
- Workspace: {workspaceName}
- Current channel: #{channelName}
- Channel topic: {channelTopic}
- Your role: Helpful AI assistant embedded in the chat

## Current User
- Name: {userName}
- Role: {userRole}

## Context
- Current date: {currentDate}
- Active channel members: {memberList}

## Capabilities
You have access to the following tools:
{toolDescriptions}

## Important Rules
1. Be CONCISE. IM is for quick communication. Avoid long paragraphs unless asked.
2. Use markdown formatting: **bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`, bullet lists.
3. When searching channel history, cite specific messages with timestamps.
4. NEVER access or reference messages from channels the requesting user cannot access.
5. If you don't know something, say so. Don't fabricate information.
6. Respect privacy: don't share user emails, phone numbers, or other PII.
7. For destructive actions (archive, delete, remove), ALWAYS ask for confirmation.
8. When summarizing, include key decisions, action items, and named people.
9. When drafting, match the tone and style of the workspace/team.
10. Keep responses under {maxResponseTokens} tokens unless the user asks for detail.

## Response Format
- For simple answers: direct text
- For lists: markdown bullet points
- For code: fenced code blocks with language
- For data: markdown tables
- For searches: numbered list with timestamps`;
```

### 6.2 Thread Summarization Prompt

```typescript
// packages/ai-bot/src/prompts/summarize.ts

export const THREAD_SUMMARIZE_PROMPT = `Summarize the following thread conversation. 
Include:
- The original question or topic
- Key points raised by participants (name the people)
- Any decisions made
- Action items and who they're assigned to
- Open questions that still need resolution

Format:
**Topic:** <one-line summary>
**Participants:** <list of names>
**Key Points:**
- Point 1
- Point 2
**Decisions:**
- Decision 1
**Action Items:**
- @person: task (by date if mentioned)
**Open Questions:**
- Question 1

Thread messages:
{threadMessages}`;
```

### 6.3 Channel Context Injection Prompt

```typescript
// packages/ai-bot/src/prompts/context.ts

export const CHANNEL_CONTEXT_PROMPT = `The following are relevant past messages from this channel that may help answer the user's question. Use these as context only if they are directly relevant.

{contextMessages}

Based on the above context and the conversation so far, respond to the user's query.`;
```

### 6.4 Translation Prompt

```typescript
// packages/ai-bot/src/prompts/translate.ts

export const TRANSLATE_PROMPT = `Translate the following text from {sourceLanguage} to {targetLanguage}.
Preserve formatting, code blocks, and markdown. Keep technical terms untranslated if they have no standard equivalent.

Text to translate:
{text}`;
```

### 6.5 Tone/Style Customization per Workspace

```typescript
// packages/ai-bot/src/prompts/style.ts

export interface WorkspaceStyle {
  /** Communication style */
  tone: "professional" | "casual" | "technical" | "friendly";
  /** Emoji usage */
  emojiLevel: "none" | "minimal" | "moderate" | "expressive";
  /** Response length preference */
  verbosity: "concise" | "balanced" | "detailed";
  /** Custom instructions */
  customInstructions?: string;
}

export function buildStylePrompt(style: WorkspaceStyle): string {
  const toneMap = {
    professional: "Use a professional, business-appropriate tone. Avoid slang and casual language.",
    casual: "Use a casual, conversational tone. Slang and informal language are acceptable.",
    technical: "Use precise technical language. Assume the audience has technical expertise.",
    friendly: "Use a warm, approachable tone. Feel free to be encouraging and supportive.",
  };

  const emojiMap = {
    none: "Do not use emojis.",
    minimal: "Use emojis sparingly (1-2 per message at most).",
    moderate: "Use emojis naturally where appropriate.",
    expressive: "Feel free to use emojis expressively.",
  };

  const verbosityMap = {
    concise: "Keep responses brief. Prefer bullet points over paragraphs.",
    balanced: "Provide balanced responses — enough detail without being verbose.",
    detailed: "Provide thorough, detailed responses. Include examples when helpful.",
  };

  return [
    toneMap[style.tone],
    emojiMap[style.emojiLevel],
    verbosityMap[style.verbosity],
    style.customInstructions,
  ].filter(Boolean).join("\n");
}
```

---

## 7. Performance & Cost Optimization

### 7.1 Latency Targets

| Metric | Target | Measurement |
|---|---|---|
| Time to first token (TTFT) | < 200ms | From LLM request sent to first `stream_chunk` emitted |
| Inter-chunk interval | < 30ms | 100ms batching window — chunks arrive every 100ms |
| Total generation time (short response) | < 3s | For responses < 200 tokens |
| Total generation time (long response) | < 30s | For responses up to 2000 tokens |
| Tool call round-trip | < 500ms | From tool call emitted to tool result rendered |
| Command parse to stream_start | < 100ms | Pre-generation overhead |

### 7.2 Token Budgeting

```typescript
// packages/ai-bot/src/optimization/token-budget.ts

export class TokenBudget {
  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  /**
   * Allocate tokens across context layers.
   * Returns the messages that fit within the budget.
   */
  allocate(
    systemPrompt: string,
    conversation: ChatMessage[],
    ragContext?: string,
    maxInputTokens?: number,
  ): ChatMessage[] {
    const totalBudget = maxInputTokens ?? Math.floor(this.provider.maxContextTokens(this.model) * 0.5);
    const systemTokens = this.estimateTokens(systemPrompt);
    const ragTokens = ragContext ? this.estimateTokens(ragContext) : 0;

    // Remaining budget for conversation
    const conversationBudget = totalBudget - systemTokens - ragTokens - 500; // 500 buffer

    const result: ChatMessage[] = [
      { role: "system", content: systemPrompt },
    ];

    if (ragContext) {
      result.push({ role: "system", content: ragContext });
    }

    // Sliding window: include most recent messages first
    let usedTokens = 0;
    const included: ChatMessage[] = [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens(conversation[i].content);
      if (usedTokens + msgTokens > conversationBudget) break;
      included.unshift(conversation[i]);
      usedTokens += msgTokens;
    }

    result.push(...included);
    return result;
  }

  private estimateTokens(text: string): number {
    // Quick estimation: ~3.5 chars per token for English
    return Math.ceil(text.length / 3.5);
  }
}
```

### 7.3 Caching Strategies

```typescript
// packages/ai-bot/src/optimization/cache.ts

export class ContextCache {
  constructor(private redis: Redis) {}

  /** Cache summarization results (TTL: 1 hour) */
  async getSummary(channelId: string, rangeStart: string, rangeEnd: string): Promise<string | null> {
    return this.redis.get(`ai:summary:${channelId}:${rangeStart}:${rangeEnd}`);
  }

  async setSummary(channelId: string, rangeStart: string, rangeEnd: string, summary: string): Promise<void> {
    await this.redis.setex(`ai:summary:${channelId}:${rangeStart}:${rangeEnd}`, 3600, summary);
  }

  /** Cache embeddings for frequently searched content (TTL: 24 hours) */
  async getEmbedding(textHash: string): Promise<number[] | null> {
    const data = await this.redis.get(`ai:emb:${textHash}`);
    return data ? JSON.parse(data) : null;
  }

  async setEmbedding(textHash: string, embedding: number[]): Promise<void> {
    await this.redis.setex(`ai:emb:${textHash}`, 86400, JSON.stringify(embedding));
  }

  /** Cache system prompts after template variable substitution (TTL: 1 hour) */
  async getSystemPrompt(workspaceId: string, channelId: string): Promise<string | null> {
    return this.redis.get(`ai:sysprompt:${workspaceId}:${channelId}`);
  }

  async setSystemPrompt(workspaceId: string, channelId: string, prompt: string): Promise<void> {
    await this.redis.setex(`ai:sysprompt:${workspaceId}:${channelId}`, 3600, prompt);
  }

  /** Anthropic-style prompt caching: mark system prompt as cacheable */
  getCacheControl(): Record<string, unknown> {
    return { cache_control: { type: "ephemeral" } };
  }
}
```

**Layered caching approach:**

```
Layer 1: Prompt Caching (Anthropic native)
  - Mark system prompt with cache_control
  - Anthropic caches it server-side for 5 minutes
  - 90% cost reduction on cached tokens

Layer 2: Redis Summary Cache
  - Summarization results cached for 1 hour
  - Channel history doesn't change frequently enough to warrant re-summarization

Layer 3: Redis Embedding Cache
  - Embedding vectors cached by content hash
  - Same message content produces same embedding

Layer 4: Redis System Prompt Cache
  - Rendered system prompt templates cached per workspace/channel
  - Invalidate when workspace settings or channel topic changes
```

### 7.4 Degradation & Fallback Strategy

```
Priority 1: Full AI response
  → LLM streaming with tools

Priority 2: Degraded — LLM without tools
  → If tool execution fails: respond without tools, note limitations

Priority 3: Degraded — Smaller model
  → If primary model is slow/unavailable: fall back to fast model (Haiku/Mini)
  → Add prefix: "[Using fast mode — responses may be less detailed]"

Priority 4: Degraded — Cached response
  → For repeated queries: return cached response
  → Add suffix: "[Cached response from {timestamp}]"

Priority 5: Static fallback
  → If all LLM providers are unavailable:
  → "AI Assistant is temporarily unavailable. Please try again in a moment."
  → Log error, alert on-call, increment error counter

Priority 6: Silent failure
  → If AI Bot crashes entirely:
  → The user's message still appears in the channel (it's a normal message)
  → No AI response is generated
  → System sends a DM to the user: "Your AI request could not be processed."
```

### 7.5 Batch Embedding Generation

```typescript
// packages/ai-bot/src/optimization/batch-embeddings.ts

export class BatchEmbeddingGenerator {
  private queue: Array<{ messageId: string; text: string; resolve: () => void }> = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private provider: LLMProvider,
    private db: DrizzleClient,
    private config: { batchSize: number; flushIntervalMs: number } = {
      batchSize: 20,
      flushIntervalMs: 5000,
    },
  ) {}

  /** Queue a message for embedding generation */
  enqueue(messageId: string, text: string): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ messageId, text, resolve });
      if (this.queue.length >= this.config.batchSize) {
        this.flush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => this.flush(), this.config.flushIntervalMs);
      }
    });
  }

  private async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.config.batchSize);
    const texts = batch.map((item) => item.text);

    try {
      const embeddings = await this.provider.embeddings("text-embedding-3-small", texts);

      // Batch insert into PostgreSQL
      const rows = batch.map((item, i) => ({
        messageId: item.messageId,
        embedding: JSON.stringify(embeddings[i]),
      }));

      // Use Drizzle batch insert
      await this.db.insert(messageEmbeddings).values(
        rows.map((r) => ({
          messageId: r.messageId,
          embedding: sql`${r.embedding}::vector`,
        })),
      );

      batch.forEach((item) => item.resolve());
    } catch (err) {
      // Re-queue for retry
      this.queue.unshift(...batch);
      logger.error({ err, batchSize: batch.length }, "Batch embedding generation failed");
    }
  }
}
```

---

## 8. Privacy & Compliance

### 8.1 Data Flow to LLM Providers

```
┌────────────────────────────────────────────────────────────┐
│                 What the AI Bot sends to LLM providers      │
│                                                            │
│  ✅ System prompt (bot persona, workspace name, channel)   │
│  ✅ Recent messages from the channel (normal mode only)    │
│  ✅ RAG search results (messages from normal channels)     │
│  ✅ User profile info (name, role — from system prompt)    │
│  ✅ Workspace-level custom instructions                    │
│                                                            │
│  ❌ Messages from E2E-encrypted channels                   │
│  ❌ Messages from channels the user isn't a member of      │
│  ❌ User email addresses, phone numbers, IP addresses      │
│  ❌ Authentication tokens or secrets                       │
│  ❌ File contents (only file names/types if needed)        │
│  ❌ User passwords or credentials                          │
└────────────────────────────────────────────────────────────┘
```

### 8.2 E2E Channel Constraint

The AI Bot **CANNOT** access E2E-encrypted channels. This is enforced at three levels:

```typescript
// Level 1: Channel membership — AI Bot cannot be added to E2E channels
// Level 2: Message event routing — E2E channel events skip bot dispatch
// Level 3: Tool execution — SDK API calls for E2E channels return PERMISSION_DENIED

// packages/ai-bot/src/guard.ts

export async function guardAiAccess(
  channelId: string,
  workspaceId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const channel = await db.channels.findById(channelId);

  if (!channel) {
    return { allowed: false, reason: "Channel not found" };
  }

  if (channel.isEncrypted) {
    return { allowed: false, reason: "AI Bot cannot access E2E-encrypted channels" };
  }

  // Check if AI Bot is a member of this channel
  const aiBotMembership = await db.channelMembers.findFirst({
    where: {
      channelId,
      memberType: "bot",
      memberId: AI_BOT_ID,
    },
  });

  if (!aiBotMembership) {
    return { allowed: false, reason: "AI Bot is not a member of this channel" };
  }

  return { allowed: true };
}
```

### 8.3 Workspace-Level Opt-In/Opt-Out

```typescript
// Database schema extension
// ALTER TABLE workspaces ADD COLUMN ai_features_enabled BOOLEAN DEFAULT false;
// ALTER TABLE workspaces ADD COLUMN ai_provider VARCHAR(50);
// ALTER TABLE workspaces ADD COLUMN ai_model VARCHAR(100);
// ALTER TABLE workspaces ADD COLUMN ai_data_retention VARCHAR(20) DEFAULT 'zero';

export interface WorkspaceAiSettings {
  enabled: boolean;                    // Master switch
  provider: "openai" | "anthropic" | "google" | "openrouter" | "ollama";
  model: string;                       // e.g., "gpt-4o-mini"
  dataRetention: "zero" | "30d" | "90d";  // LLM provider data retention
  allowedChannels: "all" | "selected";    // Which channels can use AI
  allowedChannelIds?: string[];           // If 'selected'
  maxTokensPerRequest: number;            // default: 4096
  maxRequestsPerUserPerDay: number;       // default: 50
  style: WorkspaceStyle;                  // Tone/style customization
}
```

### 8.4 Data Retention

```
nexus-chat Server:
  - AI request/response logs: retained per workspace data retention policy
  - Cost tracking data: retained indefinitely (aggregated, no message content)
  - Embedding vectors: retained until message is deleted
  - Summaries: cached in Redis (TTL 1 hour), persisted in DB for reuse

LLM Provider (external):
  - OpenAI: Zero Data Retention (ZDR) available for API usage
  - Anthropic: Does not train on API data by default; 30-day retention for abuse monitoring
  - Google Gemini: Zero data retention available via API settings
  - OpenRouter: Zero logging mode available
  - Ollama (self-hosted): No data leaves the infrastructure

Recommendation: Use zero-data-retention API options wherever available.
Document the specific retention policy in the workspace settings UI.
```

### 8.5 GDPR Considerations

| Requirement | Implementation |
|---|---|
| **Data Processing Agreement (DPA)** | Executed with each LLM provider (OpenAI, Anthropic, Google all offer DPAs) |
| **Data Residency** | Self-hosted Ollama option for EU-only data processing; provider selection by region |
| **Right to Access** | User can request all AI interactions associated with their account via API |
| **Right to Deletion** | Delete all AI interaction logs, embeddings, and summaries associated with a user |
| **Consent** | Workspace-level opt-in with clear disclosure of what data is sent to LLM providers |
| **Data Minimization** | Only send necessary context; strip PII from messages before sending to LLM |
| **DPIA** | Conduct Data Protection Impact Assessment before enabling AI features |

---

## 9. User Experience Design

### 9.1 AI Bot Introduction Flow

```
Step 1: Workspace admin enables AI features
  → Settings → AI Assistant → Enable
  → Configure: provider, model, data retention, allowed channels
  → AI Bot (@AIBot) auto-joins selected channels

Step 2: First-run tutorial (shown once per user)
  → DM from @AIBot:
    "Hi {userName}! I'm the AI Assistant. Here's what I can do:
     • /ai ask <question> — Ask me anything
     • /ai summarize [thread|today] — Summarize conversations
     • /ai translate <text> to <language> — Translate text
     • /ai draft <topic> — Draft a message
     • /ai search <query> — Search channel history
     
     Just mention @ai in any message or use /ai commands. 
     Type /ai help anytime for more info."

Step 3: Contextual hints (shown subtly in the UI)
  → In a long thread: "💡 Tip: Use /ai summarize thread to get a quick summary"
  → When pasting non-English text: "💡 Tip: Use /ai translate to translate this"
```

### 9.2 Slash Command Variations

```
/ai ask <question>
  → One-shot Q&A. AI responds in-channel with a text answer.
  → Example: /ai ask "What's the difference between Redis Streams and NATS?"
  → AI: Streams a structured answer with code examples and comparisons.

/ai summarize [thread|today|N messages|since <date>]
  → Summarizes the specified scope.
  → Example: /ai summarize thread → summarizes the current thread
  → Example: /ai summarize today → summarizes today's messages in the channel
  → Example: /ai summarize 50 → summarizes the last 50 messages
  → Example: /ai summarize since yesterday → summarizes since yesterday
  → AI: Streams a structured summary with key points, decisions, and action items.

/ai translate <text> to <language>
  → Translates the given text.
  → Example: /ai translate "Hello, how are you?" to Japanese
  → AI: "こんにちは、お元気ですか？"
  → If no text is given, translates the last message in the channel.

/ai draft <topic>
  → Drafts a message based on a topic description.
  → Example: /ai draft "Status update for the Q3 backend migration project"
  → AI: Streams a draft message. User can copy, edit, and send.
  → UI: "Draft" badge + [Copy to clipboard] [Edit] [Send] buttons.

/ai search <query>
  → Semantic search across channel history.
  → Example: /ai search "Q3 roadmap discussion about event bus"
  → AI: Searches pgvector index, returns top results with timestamps and snippets.
  → Response: Numbered list with links to original messages.

/ai help
  → Lists all available /ai commands with descriptions and examples.

/ai feedback
  → Opens a feedback form for the AI feature (helps improve prompt engineering).
```

### 9.3 @ai Mention in Thread

```
User replies in thread:
  "@bob I think we should use PostgreSQL for this. @ai what are the pros
   and cons of pgvector vs Pinecone for our use case?"

AI response (in thread):
  "@alice Based on the context of this discussion about search infrastructure,
   here's a comparison of pgvector vs Pinecone:

   **pgvector** (already in your stack):
   - ✅ Zero additional ops (already running PostgreSQL)
   - ✅ ACID compliance, joins with message data
   - ⚠️ Slower at >10M vectors
   - 💰 Free (already paid for)

   **Pinecone**:
   - ✅ Fastest at scale
   - ✅ Fully managed, hybrid search
   - ⚠️ Additional cost (~$70/month for starter)
   - ⚠️ Data leaves your infrastructure

   **Recommendation**: Start with pgvector. Migrate to Pinecone only if you exceed 10M vectors
   and query latency becomes an issue."

Key behavior: The AI response appears as a thread reply, visible to all thread participants.
```

### 9.4 Response Format Patterns

```markdown
Pattern 1: Short answer (Q&A)
  → Direct text: "The build pipeline runs at 9am UTC daily."

Pattern 2: Bullet list (summaries, lists)
  → • Point one
  → • Point two
  →   - Sub-point

Pattern 3: Code block (technical Q&A)
  → ```typescript
  → const x = 42;
  → ```

Pattern 4: Table (comparisons, data)
  → | Column A | Column B |
  → |----------|----------|
  → | Value 1  | Value 2  |

Pattern 5: Numbered list (search results, steps)
  → 1. First item (timestamp, author)
  → 2. Second item (timestamp, author)

Pattern 6: Decision record (summarize)
  → **Topic:** Q3 event bus decision
  → **Decision:** Use Redis Streams for Phase 1
  → **Rationale:** Zero additional ops cost
  → **Action:** @alice to update architecture doc
```

### 9.5 Error Message Patterns

```
Model unavailable:
  "⚠️ AI Assistant is temporarily unavailable. 
   Your message has been queued and you'll get a response when the service recovers."

Rate limited:
  "⏳ You've reached the daily limit for AI requests (50/day). 
   Your limit resets at midnight UTC."

Context too large:
  "📏 This conversation is too long for me to process fully. 
   I've summarized the earlier parts. For best results, use 
   /ai summarize first, then ask specific questions."

E2E channel:
  "🔒 AI Assistant cannot access end-to-end encrypted channels. 
   This is by design to protect your privacy."

No permission:
  "🚫 You don't have permission to use AI features in this workspace. 
   Contact a workspace admin to enable AI features."
```

---

## Appendix A: Implementation Roadmap

### Phase 1 MVP (Launch) — Not in scope
- AI features deferred to Phase 2

### Phase 2 (3 months post-launch) — Core AI Features

| Milestone | Deliverables |
|---|---|
| **M1: Provider Layer** | `LLMProvider` interface, OpenAI + Anthropic + Google providers, provider registry, cost tracker |
| **M2: Streaming Protocol** | `message.stream_start/chunk/end/cancel` events, ChunkBatcher, StreamManager, client-side rendering |
| **M3: Basic Commands** | `/ai ask`, `/ai summarize`, `/ai translate`, `/ai draft` — single agent with system prompt |
| **M4: Tool Integration** | Tool registry, SDK API tools (sendMessage, searchChannelHistory, getChannelInfo), tool execution sandbox |
| **M5: Memory Management** | Sliding conversation window, summarization, Redis caching, system prompt injection |
| **M6: UI Polish** | Typewriter animation, progressive markdown, cancel button, tool call indicators, token count display |
| **M7: Privacy & Opt-in** | Workspace AI settings, data retention controls, E2E guard, GDPR compliance |

### Phase 3 (6+ months post-launch) — Advanced AI

| Milestone | Deliverables |
|---|---|
| **M8: RAG** | pgvector integration, message embedding pipeline, semantic search, hybrid search (keyword + vector) |
| **M9: Multi-Agent** | LangGraph-based supervisor-worker, debate pattern, task decomposition |
| **M10: Advanced Tools** | Web fetch, code execution sandbox (E2B), external API integration, MCP server |
| **M11: Self-Hosted LLM** | Ollama provider, vLLM integration, enterprise on-premise deployment |
| **M12: AI Analytics** | Usage dashboards, cost allocation, prompt effectiveness metrics, A/B testing |

---

## Appendix B: Technology Recommendation Summary

| Component | Phase 2 Recommendation | Phase 3 Consideration |
|---|---|---|
| **Agent Framework** | Vercel AI SDK (streaming-first, TypeScript) | LangGraph (multi-agent orchestration) |
| **Tool Standard** | OpenAI function calling format | MCP (Model Context Protocol) |
| **Vector Store** | pgvector (already in PostgreSQL) | Pinecone / Qdrant (at >10M vectors) |
| **Primary Models** | GPT-4o, Claude 4 Sonnet, Gemini 2.5 Pro | Self-hosted via Ollama/vLLM |
| **Model Gateway** | Direct provider API | OpenRouter (unified access + fallback) |
| **Embedding Model** | OpenAI text-embedding-3-small | Self-hosted (e.g., BGE-M3 via Ollama) |
| **Stream Transport** | WebSocket (existing Socket.IO) | WebSocket + Durable Sessions |
| **Observability** | Pino logs + Prometheus metrics | OpenTelemetry traces (LangSmith or Signoz) |
| **Code Sandbox** | N/A (Phase 2) | E2B (gVisor-isolated) |

---

> **Related Documents**:
> - [Async Bot Engine & Event Dispatch Layer — Design](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)
> - [Long Connection & Core Gateway Layer — Design](../design/02_Long_Connection_and_Core_Gateway_Layer.md)
> - [Base Bot Catalog — Research](./base-bot-catalog.md)
> - [Security & E2EE Roadmap](./security-defense-e2ee-roadmap.md)
>
> **Next Steps**:
> 1. Implement `packages/ai-bot/src/providers/` — OpenAI, Anthropic, Google provider adapters
> 2. Design and implement the streaming protocol (3 new WebSocket event types)
> 3. Build the ChunkBatcher and StreamManager for token-to-chunk conversion
> 4. Create the AgentRouter with command parsing and agent selection
> 5. Implement the ToolRegistry with SDK API tools and confirmation flow
> 6. Build the sliding window memory manager with summarization
> 7. Add pgvector extension and message embedding pipeline
> 8. Implement ProgressiveMarkdownRenderer for the client
> 9. Build workspace AI settings UI with opt-in flow and first-run tutorial
