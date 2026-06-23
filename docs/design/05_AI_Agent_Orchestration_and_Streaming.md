---
lang: en
---

# 05 — AI Agent Orchestration & Streaming Engine Design

> nexus-chat · Slack-like IM application  
> Design date: June 2026 · Status: Draft v1.0  
> Dependencies: [AI Agent Orchestration Research](../research/ai-agent-orchestration.md), [Base Bot Catalog Research](../research/base-bot-catalog.md), [Bot Engine Design](./04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Streaming Message Protocol](#2-streaming-message-protocol)
3. [AI Bot Engine Architecture](#3-ai-bot-engine-architecture)
4. [Command Routing & Intent Parsing](#4-command-routing--intent-parsing)
5. [LLM Provider Abstraction](#5-llm-provider-abstraction)
6. [Tool System & SDK Integration](#6-tool-system--sdk-integration)
7. [Context & Memory Management](#7-context--memory-management)
8. [Prompt Engineering & System Templates](#8-prompt-engineering--system-templates)
9. [Performance & Cost Optimization](#9-performance--cost-optimization)
10. [Privacy, Security & Compliance](#10-privacy-security--compliance)
11. [Phased Implementation Roadmap](#11-phased-implementation-roadmap)

---

## 1. Overview

### 1.1 The AI Assistant Bot

The AI Assistant Bot (`@AIBot`) is a first-party built-in bot that distinguishes itself from all other bots in the nexus-chat ecosystem through one fundamental capability: it produces **streamed, AI-generated content** using large language models (LLMs). Unlike deterministic bots (WelcomeBot, ReminderBot, PollBot) that generate static or rule-based responses, the AI Assistant Bot:

- Accepts natural-language prompts and responds with context-aware, generated text
- Streams responses token-by-token into the chat UI, providing real-time progressive rendering
- Invokes tools (search, web fetch, message send) autonomously to fulfill complex requests
- Operates within a multi-layered context window spanning system prompts, conversation history, and semantic search results

### 1.2 Interaction Models

The AI Assistant supports two interaction modes, both routed through the existing Bot Engine event pipeline:

| Mode | Trigger | Routing | Agent |
|------|---------|---------|-------|
| **Slash Command** | `/ai <subcommand> [args]` | Parsed by `AiCommandRouter`, dispatched to specific agent | ask, summarize, translate, draft, search |
| **@ai Mention** | `@ai <prompt>` in any message or thread reply | Routed to default Q&A agent | ask (general Q&A) |

### 1.3 Scope by Phase

**Phase 2 (AI MVP)** — the scope of this design document:

- Single-agent architecture: one LLM call orchestrated with tool invocation
- Five built-in commands: `ask`, `summarize`, `translate`, `draft`, `search`
- Two LLM providers: OpenAI (GPT-4o / GPT-4o Mini) + Anthropic (Claude 4 Sonnet / Claude 3.5 Haiku)
- pgvector-based RAG for semantic search over channel history
- Streaming WebSocket protocol for progressive message rendering
- Workspace-level opt-in with provider selection and cost tracking

**Phase 3 (Advanced AI)** — deferred, sketched for roadmap alignment:

- Multi-agent orchestration via LangGraph (supervisor-worker, debate patterns)
- E2B-based code execution sandbox
- Voice/video meeting summarization
- Autonomous recap generation (daily/weekly digests)
- Custom agent builder and provider marketplace
- MCP (Model Context Protocol) server for tool exposure

### 1.4 Key Constraints

1. **No E2E channel access.** The AI Bot cannot be added to end-to-end encrypted channels. This is enforced at three levels: channel membership gating, event pipeline routing, and SDK API tool execution (see §10.2).
2. **All bots are channel members.** The AI Bot must be explicitly added to a channel by an admin before it can process `/ai` commands or `@ai` mentions.
3. **Streaming is disabled for E2E channels.** The `message.stream_*` events are gated behind the same encryption check.
4. **Shared infrastructure.** The AI Bot Engine runs as a subsystem within the existing Bot Engine process, reusing the Redis-backed event bus, Socket.IO room management, and JWT authentication pipeline.

---

## 2. Streaming Message Protocol

### 2.1 Problem Statement

Traditional IM platforms operate on a **message-at-a-time** paradigm: a user sends a complete message, the server delivers it atomically. LLMs produce output **token-by-token** with end-to-end latencies of 5–40 seconds. Bridging these paradigms requires a streaming protocol that converts an LLM token stream into progressive message updates visible in the chat UI.

```
Traditional IM:    User ──[full message]──> Server ──[full message]──> Recipients
LLM Streaming:     User ──[prompt]──> LLM ──[t1][t2][t3]...[tN]──> Client
nexus-chat:        User ──[prompt]──> AI Bot ──[chunk1][chunk2]...[chunkN]──> Channel (visible to all)
```

### 2.2 WebSocket Protocol Extension

nexus-chat uses Socket.IO v4 with typed event envelopes (`GatewayMessage`). The streaming protocol adds four bidirectional events to the existing WebSocket connection — no additional HTTP or SSE connection is required. The rationale for WebSocket over SSE is established in the research document (§1.2.3): WebSocket provides native bidirectionality (cancellation, tool confirmation), TCP backpressure, and connection state recovery via Socket.IO's built-in reconnect.

#### 2.2.1 Event Definitions

```typescript
// packages/shared/src/events/streaming.ts

export const StreamingEvents = {
  // ── Server → Client ──

  /** Creates a placeholder message skeleton in the UI at the correct chronological position. */
  "message.stream_start": (data: {
    streamId: string;
    channelId: string;
    workspaceId: string;
    botId: string;
    parentMessageId?: string;
    threadId?: string;
    /** Pre-allocated UUID v7 — the client creates an empty message immediately. */
    placeholderMessageId: string;
    /** Optional estimated total tokens for the progress bar. */
    estimatedTokens?: number;
  }) => void,

  /** Appends text content to the placeholder message. Always an append, never a replace. */
  "message.stream_chunk": (data: {
    streamId: string;
    channelId: string;
    chunkIndex: number;
    content: string;
    tokenCount: number;
    /** Tool call in progress (partial JSON may span multiple chunks). */
    toolCall?: {
      toolCallId: string;
      toolName: string;
      arguments: string;
    };
    /** Tool execution result returned to the LLM context. */
    toolResult?: {
      toolCallId: string;
      result: string;
    };
  }) => void,

  /** Terminates the stream. The placeholder becomes the final message. */
  "message.stream_end": (data: {
    streamId: string;
    channelId: string;
    messageId: string;
    status: "completed" | "cancelled" | "error";
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
    error?: { code: string; message: string };
    toolCalls?: Array<{
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      result: unknown;
    }>;
  }) => void,

  // ── Client → Server ──

  /** User-initiated cancellation of an in-progress generation. */
  "message.stream_cancel": (data: {
    streamId: string;
    channelId: string;
    reason?: string;
  }) => void,

  /** User approves or rejects a tool call that requires confirmation. */
  "message.stream_tool_response": (data: {
    streamId: string;
    toolCallId: string;
    approved: boolean;
    modifiedArguments?: Record<string, unknown>;
  }) => void,
} as const;
```

#### 2.2.2 Stream Lifecycle State Machine

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

Key design decisions:

1. **Pre-allocated message ID.** `stream_start` carries a `placeholderMessageId` (UUID v7). The client creates a skeleton message immediately, placing it in the correct chronological position. This avoids reordering when the full response arrives seconds later.
2. **Append-only chunks.** Each `stream_chunk` is an append operation — the client concatenates `content` to the existing message body. No diff/patch semantics are required.
3. **Tool call interlacing.** Tool calls are embedded within the stream. When the LLM requests a tool, `stream_chunk` carries `toolCall` data. The UI renders a "Tool in use: X…" interstitial. When the result is injected, the stream resumes.
4. **Bidirectional control.** The client can cancel or respond to tool confirmations on the same WebSocket — a key advantage over SSE (see research §1.2.3).
5. **Garbage collection.** If a WebSocket disconnects mid-stream, the server cancels the generation after a 10-second timeout. The placeholder is replaced with an error notice.

### 2.3 Chunk Batcher

LLMs produce tokens at 50–200 tokens/sec. Sending every token as a separate WebSocket message would overwhelm the client. The `ChunkBatcher` aggregates tokens into larger chunks at a controlled interval.

```typescript
// packages/ai-bot/src/streaming/chunk-batcher.ts

export class ChunkBatcher {
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chunkIndex = 0;

  constructor(
    private emit: (chunk: { chunkIndex: number; content: string }) => void,
    private config: {
      maxIntervalMs: number;   // default: 100
      minChars: number;        // default: 1
      flushOnNewline: boolean; // default: true
      maxChars: number;        // default: 500
    } = { maxIntervalMs: 100, minChars: 1, flushOnNewline: true, maxChars: 500 },
  ) {}

  push(token: string): void {
    this.buffer.push(token);

    if (this.config.flushOnNewline && token.includes("\n")) {
      this.flush();
      return;
    }

    const total = this.buffer.join("");
    if (total.length >= this.config.maxChars) {
      this.flush();
      return;
    }

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

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `maxIntervalMs` | 100 ms | Human perception of smoothness; <100 ms feels instantaneous |
| `minChars` | 1 | Don't hold single characters; the timer enforces the ceiling |
| `flushOnNewline` | true | Natural break points for progressive markdown rendering |
| `maxChars` | 500 | Prevents oversized chunks on very fast models |

### 2.4 Generation Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max output tokens per generation | 4,096 | Covers most IM use cases; prevents runaway |
| Max generation wall-clock time | 60 s | Hard deadline; cancels stream if exceeded |
| Max concurrent streams per workspace | 10 | Prevents abuse; queued beyond this |
| Max concurrent streams per user | 3 | One per channel/thread is reasonable |
| Max total input tokens (context) | 32,000 | Balances context richness with cost |

### 2.5 UI Phases

```
Phase 1: PLACEHOLDER (stream_start)
  ┌──────────────────────────────────────────┐
  │ @AIBot                                   │
  │ ┌──────────────────────────────────────┐ │
  │ │  ● Thinking…                         │ │
  │ │  ═══════════════════════ (animated)  │ │
  │ └──────────────────────────────────────┘ │
  │                         [ Cancel ]       │
  └──────────────────────────────────────────┘

Phase 2: STREAMING (stream_chunk × N)
  ┌──────────────────────────────────────────┐
  │ @AIBot                                   │
  │ ┌──────────────────────────────────────┐ │
  │ │  The current weather in Tokyo is     │ │
  │ │  22°C with partly cloudy skies. █    │ │  ← blinking cursor
  │ └──────────────────────────────────────┘ │
  │                         [ Cancel ]       │
  └──────────────────────────────────────────┘

Phase 3: COMPLETE (stream_end)
  ┌──────────────────────────────────────────┐
  │ @AIBot                                   │
  │ ┌──────────────────────────────────────┐ │
  │ │  The current weather in Tokyo is     │ │
  │ │  22°C with partly cloudy skies.      │ │
  │ └──────────────────────────────────────┘ │
  │  12:34 PM  ·  142 tokens                │
  └──────────────────────────────────────────┘
```

#### 2.5.1 Progressive Markdown Rendering

```typescript
// apps/web/src/lib/streaming-markdown.ts

export class StreamingMarkdownRenderer {
  private buffer = "";
  private renderer: MarkdownIt;

  constructor() {
    this.renderer = new MarkdownIt({
      html: false,
      linkify: true,
      typographer: true,
    });
  }

  append(chunk: string): string {
    this.buffer += chunk;
    return this.renderer.render(this.sanitizeBuffer());
  }

  private sanitizeBuffer(): string {
    let text = this.buffer;
    const openFences = (text.match(/```/g) || []).length;
    if (openFences % 2 !== 0) {
      text += "\n```"; // Temporarily close — re-opened by next chunk
    }
    return text;
  }

  final(): string {
    return this.renderer.render(this.buffer);
  }
}
```

#### 2.5.2 Tool Call Visual Interstitial

When the AI calls a tool, the streaming message shows an interstitial indicator:

```
┌──────────────────────────────────────────┐
│ @AIBot                                   │
│ ┌──────────────────────────────────────┐ │
│ │  Let me check the latest data…       │ │
│ │                                      │ │
│ │  🔍 Searching channel history…       │ │ ← Tool indicator
│ │  ═══════════════════════ (animated)  │ │
│ └──────────────────────────────────────┘ │
└──────────────────────────────────────────┘
```

After the tool returns, the stream continues with the result incorporated into the response.

---

## 3. AI Bot Engine Architecture

### 3.1 System Architecture Diagram

This diagram, reproduced from the research document (§2.3), shows the AI Bot Engine as a subsystem integrated with the existing Gateway Layer and Client.

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
│  │  /ai translate   │    │                 │    │  │ Anthropic     │  ││
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

### 3.2 Subsystem Descriptions

| Subsystem | Responsibility | Input | Output |
|-----------|---------------|-------|--------|
| **Command Parser** | Parse `/ai <subcommand> [args]` and `@ai` mentions from incoming messages | `IncomingMessage` | `AgentInvocation \| null` |
| **Agent Router** | Map intent to `AgentDefinition` (system prompt, tools, model, context config) | `AgentInvocation` | Resolved `AgentDefinition` |
| **LLM Provider** | Abstract over OpenAI, Anthropic, Google, OpenRouter, and Ollama; provide unified `chat()` and `embeddings()` | Messages, tools, options | `AsyncGenerator<StreamChunk>` |
| **Tool Executor** | Execute tool calls requested by the LLM; classify by safety (GREEN/YELLOW/RED) | `ToolCall`, `ToolContext` | Tool result injected into LLM context |
| **Memory Manager** | Maintain conversation sliding window, generate summaries, query pgvector for semantic search | Channel context, user query | `ChatMessage[]` for LLM context |
| **Stream Manager** | Batcher → Emitter pipeline; handle cancellation and tool confirmation events | `AsyncGenerator<StreamChunk>` | Socket.IO `stream_*` events |

### 3.3 Integration with Bot Engine (04 Design)

The AI Bot Engine plugs into the existing Bot Engine event pipeline described in [04_Async_Bot_Engine_and_Event_Dispatch_Layer](./04_Async_Bot_Engine_and_Event_Dispatch_Layer.md). The AI Bot is registered as a built-in bot with a WebSocket connection mode:

```
Message Received (non-E2E channel only)
    │
    ▼
┌───────────────────────────────────────┐
│         Event Enrichment               │  (existing pipeline, §2.1 of 04 design)
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│      Bot Subscription Router           │  (existing pipeline, §2.2 of 04 design)
│  AI Bot is registered for all channels │
│  where it has been added as a member.  │
└───────────────┬───────────────────────┘
                │
                ▼
┌───────────────────────────────────────┐
│         Event Queue (BullMQ)           │
│  ┌─────────────────────────────────┐   │
│  │  ai-bot queue                    │   │
│  │  → AiCommandRouter.route(msg)   │   │
│  │  → AgentRouter.dispatch(inv)    │   │
│  │  → StreamManager.execute()      │   │
│  └─────────────────────────────────┘   │
└───────────────────────────────────────┘
```

### 3.4 Core TypeScript Types

```typescript
// packages/ai-bot/src/types.ts

// ── Agent Definition ─────────────────────────────

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;                    // Template with {variables}
  tools: Record<string, Tool>;
  model: string;                           // Fully qualified: "openai/gpt-4o"
  maxSteps?: number;                       // Max tool-calling loop iterations
  context: {
    maxMessages: number;                   // Default: 50
    includeThreadHistory: boolean;
    includeChannelTopic: boolean;
    includeUserProfile: boolean;
  };
}

// ── Tool ─────────────────────────────────────────

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;     // JSON Schema
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

export interface ToolContext {
  workspaceId: string;
  channelId: string;
  userId: string;
  api: BotApiClient;
}

// ── LLM Provider ─────────────────────────────────

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  chat(
    model: string,
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    options?: ChatOptions,
  ): AsyncGenerator<StreamChunk>;
  embeddings(model: string, text: string | string[]): Promise<number[][]>;
  maxContextTokens(model: string): number;
  countTokens(messages: ChatMessage[]): Promise<number>;
  listModels(): Promise<ModelInfo[]>;
}

export type StreamChunk =
  | { type: "text"; content: string }
  | { type: "tool_call"; toolCallId: string; toolName: string; arguments: string }
  | { type: "tool_result"; toolCallId: string; result: string }
  | { type: "error"; message: string }
  | { type: "done"; usage: TokenUsage };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
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
  inputCostPer1M: number;
  outputCostPer1M: number;
  supportsTools: boolean;
  supportsVision: boolean;
}
```

---

## 4. Command Routing & Intent Parsing

### 4.1 Command Catalog

| Command | Syntax | Agent | Description |
|---------|--------|-------|-------------|
| `ask` | `/ai ask <question>` | `askAgent` | One-shot Q&A with context from channel history |
| `summarize` | `/ai summarize [N\|thread\|today\|yesterday]` | `summarizeAgent` | Summarize conversation scope |
| `translate` | `/ai translate <text> to <lang>` | `translateAgent` | Translate text; defaults to last message if no text given |
| `draft` | `/ai draft <topic>` | `draftAgent` | Generate draft message; user can copy, edit, send |
| `search` | `/ai search <query>` | `searchAgent` | Semantic search across channel history via pgvector |
| `recap` | `/ai recap [today\|week]` | `recapAgent` | Daily/weekly channel recap summary |
| `help` | `/ai help` | N/A | Lists available commands with descriptions |
| `feedback` | `/ai feedback` | N/A | Opens feedback form for AI feature |
| (mention) | `@ai <prompt>` in message | `askAgent` | Default Q&A agent for natural-language mentions |

### 4.2 Command Router Implementation

```typescript
// packages/ai-bot/src/router.ts

import { parseSlashCommand } from "@nexus-chat/bot-engine";
import { askAgent, summarizeAgent, translateAgent, draftAgent, searchAgent } from "./agents";

const AI_COMMANDS: Record<string, AgentDefinition> = {
  "ask":        askAgent,
  "summarize":  summarizeAgent,
  "translate":  translateAgent,
  "draft":      draftAgent,
  "search":     searchAgent,
  "recap":      searchAgent,     // Recap is a variant of search with date range
};

export interface AgentInvocation {
  agent: AgentDefinition;
  intent: string;
  input: string;
  channelId: string;
  threadId?: string;
  userId: string;
  workspaceId: string;
}

export class AiCommandRouter {
  route(message: IncomingMessage): AgentInvocation | null {
    // Case 1: /ai slash command
    const parsed = parseSlashCommand(message.text);
    if (parsed?.botName === "ai") {
      const agent = AI_COMMANDS[parsed.command];
      if (!agent) return null;
      return {
        agent,
        intent: parsed.command,
        input: parsed.args.join(" "),
        channelId: message.channelId,
        threadId: message.threadId,
        userId: message.userId,
        workspaceId: message.workspaceId,
      };
    }

    // Case 2: @ai mention in a message (leading)
    const mentionMatch = message.text.match(/^@ai\s+(.+)/s);
    if (mentionMatch) {
      return {
        agent: askAgent,
        intent: "mention",
        input: mentionMatch[1],
        channelId: message.channelId,
        threadId: message.threadId,
        userId: message.userId,
        workspaceId: message.workspaceId,
      };
    }

    // Case 3: @ai mention in a thread reply (inline or trailing)
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
          workspaceId: message.workspaceId,
        };
      }
    }

    return null;
  }
}
```

### 4.3 Command Dispatch Flow

```
Incoming message arrives at AI Bot's BullMQ queue
    │
    ▼
AiCommandRouter.route(message)
    │
    ├── null → Ignore (not for this bot)
    │
    └── AgentInvocation → AgentRouter.dispatch(inv)
                              │
                              ▼
                         ┌─────────────────────────┐
                         │ 1. Load workspace AI     │
                         │    settings (provider,   │
                         │    model, style)          │
                         ├─────────────────────────┤
                         │ 2. Build context via     │
                         │    MemoryManager         │
                         ├─────────────────────────┤
                         │ 3. Select LLM provider   │
                         │    (registry.resolve)    │
                         ├─────────────────────────┤
                         │ 4. Execute agent loop:   │
                         │    chat() → tool calls   │
                         │    → result → chat()... │
                         ├─────────────────────────┤
                         │ 5. Stream via            │
                         │    StreamManager         │
                         └─────────────────────────┘
```

---

## 5. LLM Provider Abstraction

### 5.1 Provider Interface

All LLM interactions go through a unified `LLMProvider` interface (defined in §3.4). The chat method returns `AsyncGenerator<StreamChunk>`, enabling the Stream Manager to consume tokens as they arrive without buffering the entire response.

### 5.2 Provider Implementations

| Provider | Models | Strengths | Embeddings |
|----------|--------|-----------|------------|
| **OpenAI** | GPT-4o, GPT-4o Mini, o3-mini | Broadest tool calling support; `text-embedding-3-small` for embeddings | Native |
| **Anthropic** | Claude 4 Sonnet, Claude 3.5 Haiku | 200K context window; prompt caching (90% cost reduction on cached tokens); excellent summarization | Via OpenAI or Voyage AI |
| **Google Gemini** | Gemini 2.5 Pro | 1M token context window; strong for very long context | Native |
| **OpenRouter** | All of the above + 200+ models | Unified API; automatic fallback routing; cost comparison | Via provider |
| **Ollama** | Llama 3, Mistral, BGE-M3 (self-hosted) | Zero data egress; enterprise on-premise; fixed cost | Native (self-hosted) |

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
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature,
      top_p: options?.topP,
    });

    const toolCallBuffer = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { type: "text", content: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallBuffer.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.arguments += tc.function.arguments;
          toolCallBuffer.set(tc.index, existing);
        }
      }

      if (chunk.choices[0]?.finish_reason === "tool_calls") {
        for (const [, tc] of toolCallBuffer) {
          yield { type: "tool_call", toolCallId: tc.id, toolName: tc.name, arguments: tc.arguments };
        }
        toolCallBuffer.clear();
      }

      if (chunk.choices[0]?.finish_reason === "stop" && chunk.usage) {
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
      "o3-mini": 200_000,
    };
    return limits[model] ?? 128_000;
  }

  async countTokens(messages: ChatMessage[]): Promise<number> {
    let count = 0;
    for (const msg of messages) {
      count += 4;
      count += Math.ceil(msg.content.length / 3.5);
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
    const systemMsg = messages.find((m) => m.role === "system");
    const chatMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const stream = await this.client.messages.stream({
      model,
      system: systemMsg?.content,
      messages: chatMessages,
      tools: tools?.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
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
            yield { type: "tool_call", toolCallId: event.content_block.id, toolName: event.content_block.name, arguments: "" };
          }
          break;
        case "message_stop":
          yield {
            type: "done",
            usage: {
              promptTokens: event.usage.input_tokens,
              completionTokens: event.usage.output_tokens,
              totalTokens: event.usage.input_tokens + event.usage.output_tokens,
            },
          };
          break;
      }
    }
  }

  async embeddings(_model: string, _text: string | string[]): Promise<number[][]> {
    throw new Error("Anthropic does not provide embeddings. Use OpenAI or Voyage AI.");
  }

  maxContextTokens(model: string): number {
    return model.includes("sonnet") || model.includes("opus") || model.includes("haiku") ? 200_000 : 200_000;
  }

  async countTokens(messages: ChatMessage[]): Promise<number> {
    const result = await this.client.messages.countTokens({
      model: "claude-sonnet-4-20250514",
      messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
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

### 5.3 Provider Registry & Routing

```typescript
// packages/ai-bot/src/providers/registry.ts

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
  }

  resolve(modelId: string): { provider: LLMProvider; model: string } {
    const [providerId, ...modelParts] = modelId.split("/");
    if (modelParts.length > 0) {
      const provider = this.providers.get(providerId);
      if (!provider) throw new Error(`Unknown provider: ${providerId}`);
      return { provider, model: modelParts.join("/") };
    }

    if (modelId.startsWith("gpt-") || modelId.startsWith("o1") || modelId.startsWith("o3"))
      return { provider: this.providers.get("openai")!, model: modelId };
    if (modelId.startsWith("claude-"))
      return { provider: this.providers.get("anthropic")!, model: modelId };
    if (modelId.startsWith("gemini-"))
      return { provider: this.providers.get("google")!, model: modelId };

    throw new Error(`Cannot resolve model: ${modelId}`);
  }

  async listAllModels(): Promise<ModelInfo[]> {
    const results = await Promise.all(
      Array.from(this.providers.values()).map((p) => p.listModels().catch(() => [])),
    );
    return results.flat();
  }
}
```

### 5.4 Provider Selection & Fallback Chain

```
Default routing (by complexity):
  Simple queries (translate, draft, ask)  → GPT-4o Mini / Claude 3.5 Haiku
  Complex reasoning (summarize, search)   → GPT-4o / Claude 4 Sonnet
  Very large context (>100K tokens)       → Gemini 2.5 Pro / Claude 4 Sonnet

Fallback chain:
  1. Try primary provider (workspace-configured)
  2. If rate-limited (HTTP 429) → exponential backoff, retry (max 3 attempts)
  3. If timeout (>60s) → try secondary provider
  4. If all fail → return cached response or graceful degradation message
```

### 5.5 Cost Tracking

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

    aiCostCounter.inc({ workspaceId: context.workspaceId, provider, model }, costUSD);
  }

  async getWorkspaceCost(workspaceId: string): Promise<{
    totalCost: number;
    byProvider: Record<string, number>;
    byModel: Record<string, number>;
    byUser: Record<string, number>;
  }> {
    // Aggregate from cost_records table grouped by provider, model, user
    // ...
  }
}
```

### 5.6 Embedding Provider Separation

Because Anthropic does not offer an embeddings API, the embedding provider is configured separately from the chat provider:

```typescript
// packages/ai-bot/src/providers/embedding-provider.ts

export const EMBEDDING_PROVIDER_MAP: Record<string, { provider: string; model: string }> = {
  "openai":    { provider: "openai", model: "text-embedding-3-small" },
  "anthropic": { provider: "openai", model: "text-embedding-3-small" },   // Delegated
  "google":    { provider: "google", model: "text-embedding-004" },
  "ollama":    { provider: "ollama", model: "bge-m3" },
};
```

---

## 6. Tool System & SDK Integration

### 6.1 Tool Declaration Format

nexus-chat uses **OpenAI function calling format** as the canonical tool declaration, which is the de facto standard supported by OpenAI, Anthropic (`tool_use`), Google Gemini, and OpenRouter (see research §4.1).

### 6.2 Built-in Tool Catalog

```typescript
// packages/ai-bot/src/tools/registry.ts

export const NEXUS_CHAT_TOOLS: Tool[] = [
  // ── GREEN: Read-only, auto-execute ──

  {
    name: "searchChannelHistory",
    description: "Search for messages in the current channel by keyword or semantic query",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10, max 50)" },
        fromDate: { type: "string", description: "ISO date string (optional)" },
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
    description: "Get information about the current channel (name, topic, member count)",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_args, ctx) => ctx.api.getChannelInfo(ctx.channelId),
  },

  {
    name: "listChannelMembers",
    description: "List all members of the current channel",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async (_args, ctx) => ctx.api.listChannelMembers(ctx.channelId),
  },

  {
    name: "getUserProfile",
    description: "Get a user's profile information",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "User ID or @username" },
      },
      required: ["userId"],
    },
    execute: async (args, ctx) => ctx.api.getUserProfile(args.userId as string),
  },

  // ── YELLOW: Write/External, auto-execute with logging ──

  {
    name: "sendMessage",
    description: "Send a message to the current channel (markdown supported)",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Message text" },
      },
      required: ["content"],
    },
    execute: async (args, ctx) => ctx.api.sendMessage(ctx.channelId, args.content as string),
  },

  {
    name: "fetchWebPage",
    description: "Fetch content from a URL (web page, API, documentation)",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
      },
      required: ["url"],
    },
    requiresConfirmation: true,
    confirmationMessage: "Fetch content from {url}? External URLs may not be trusted.",
    execute: async (args, _ctx) => {
      const response = await fetch(args.url as string);
      const text = await response.text();
      return text.slice(0, 8000);
    },
  },

  // ── RED: Destructive, requires user confirmation ──

  {
    name: "archiveChannel",
    description: "Archive (close) the current channel. THIS IS DESTRUCTIVE.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for archiving" },
      },
      required: ["reason"],
    },
    requiresConfirmation: true,
    confirmationMessage: "Archive this channel? All members will lose access.",
    execute: async (args, ctx) => ctx.api.archiveChannel(ctx.channelId, args.reason as string),
  },
];
```

### 6.3 Tool Safety Classification

```
GREEN (auto-execute, not logged beyond standard audit):
  ├── searchChannelHistory     (READ-ONLY)
  ├── getChannelInfo           (READ-ONLY)
  ├── listChannelMembers       (READ-ONLY)
  └── getUserProfile           (READ-ONLY)

YELLOW (auto-execute, audit-logged):
  ├── sendMessage              (WRITE — expected for AI responses)
  └── fetchWebPage             (READ — but external, requires allowlist)

RED (requires user confirmation via interactive button):
  ├── archiveChannel           (DESTRUCTIVE)
  ├── deleteMessage            (DESTRUCTIVE)
  ├── removeMember             (DESTRUCTIVE)
  └── createChannel            (WRITE — medium impact)
```

### 6.4 Interactive Confirmation Flow

When the AI proposes a destructive tool call, the streaming message includes an interactive confirmation using the existing Block Kit protocol:

```typescript
// 1. AI emits tool_call with requiresConfirmation: true
// 2. Server renders confirmation block in the stream:

// stream_chunk payload:
{
  streamId: "str_abc123",
  channelId: "ch_xyz",
  chunkIndex: 5,
  content: "",
  toolCall: {
    toolCallId: "call_123",
    toolName: "archiveChannel",
    arguments: '{"reason":"Channel has been inactive for 6 months"}',
  },
}

// 3. Client renders:
//    ⚠️ Archive this channel? All members will lose access.
//    [ Confirm ]  [ Cancel ]

// 4. User clicks [Confirm]:
//    Client sends: { type: "message.stream_tool_response",
//                    streamId: "str_abc123",
//                    toolCallId: "call_123", approved: true }

// 5. Server executes tool, returns result as stream_chunk
```

### 6.5 Tool Execution Flow

```
┌──────────────────────────────────────────────────────────────┐
│                     Agent Execution Loop                      │
│                                                              │
│  1. Build context (MemoryManager)                            │
│  2. LLM chat(messages, tools) → yields chunks               │
│       │                                                      │
│       ├── chunk type="text" → Stream to client               │
│       └── chunk type="tool_call"                             │
│            │                                                 │
│            ├── Check safety classification                   │
│            │                                                 │
│            ├── GREEN → Execute immediately                   │
│            ├── YELLOW → Execute, write audit log             │
│            └── RED → Stream confirmation to client           │
│                  │                                           │
│                  ├── User approves → Execute                 │
│                  └── User rejects → Skip tool, resume LLM    │
│                                                              │
│  3. Inject tool result as ChatMessage { role:"tool", ... }  │
│  4. LLM chat(messages + toolResult, tools) → resumes        │
│  5. Repeat steps 2-4 until LLM emits "done"                 │
│       or maxSteps (default: 5) is reached                    │
└──────────────────────────────────────────────────────────────┘
```

### 6.6 Tool Sandboxing

| Execution Model | Phase | Description |
|-----------------|-------|-------------|
| **Server-side (SDK API)** | Phase 2 | Tools execute within the AI Bot Engine using the scoped Bot SDK client |
| **Server-side (HTTP fetch)** | Phase 2 | External URL fetch with domain allowlist, rate limiting, 10s timeout |
| **Code sandbox (E2B)** | Phase 3 | gVisor-based isolation for executing AI-generated code via `/ai code` |
| **MCP server** | Phase 3 | Model Context Protocol — expose nexus-chat tools to external clients and consume external tools |

---

## 7. Context & Memory Management

### 7.1 Five-Layer Context Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    LLM Context Window                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Layer 1: System Prompt (~500 tokens)                   │  │
│  │  Bot persona, workspace info, channel topic, user role  │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Layer 2: Conversation Window (last N messages)        │  │
│  │  Sliding window of recent channel messages              │  │
│  │  Thread history (if in thread)                          │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Layer 3: RAG Context (conditional)                    │  │
│  │  Top-K semantically relevant messages from channel     │  │
│  │  Injected when query is historical/referential          │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Layer 4: User Input                                    │  │
│  │  The current query or command                           │  │
│  ├────────────────────────────────────────────────────────┤  │
│  │  Layer 5: Generation Budget (reserved for output)      │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Sliding Window

```typescript
// packages/ai-bot/src/memory/conversation-window.ts

export class ConversationWindow {
  constructor(
    private config: {
      maxMessages: number;   // default: 50
      maxTokens: number;     // default: 24_000
    },
  ) {}

  async buildContext(
    channelId: string,
    threadId?: string,
  ): Promise<ChatMessage[]> {
    const messages = await this.fetchRecentMessages(channelId, threadId, this.config.maxMessages);
    let chatMessages = messages.map(toChatMessage);
    chatMessages = this.truncateToBudget(chatMessages, this.config.maxTokens);

    // If messages were truncated, prepend a summary
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

  private truncateToBudget(messages: ChatMessage[], budget: number): ChatMessage[] {
    let used = 0;
    const result: ChatMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const tokens = Math.ceil(messages[i].content.length / 3.5);
      if (used + tokens > budget) break;
      result.unshift(messages[i]);
      used += tokens;
    }
    return result;
  }
}
```

### 7.3 Conversation Summarization

When the conversation exceeds the context window, older messages are recursively summarized using a cascading approach:

```
Strategy:
  1. Track a `summarized_until` cursor per channel
  2. When a new summarization is needed:
     a. Summarize the [summarized_until, oldest_in_window) range
     b. Prepend: [summary_N, summary_N-1, ..., summary_1, recent_msg_1, ... recent_msg_K]
  3. Cache summaries in Redis: `ai:summary:{channelId}:{rangeStart}:{rangeEnd}` (TTL: 1 hour)
  4. When summaries exceed 5 entries: summarize the summaries (recursive compaction)
```

```typescript
// packages/ai-bot/src/memory/summarizer.ts

const SUMMARIZE_PROMPT = `Summarize this conversation excerpt concisely.
Include: key decisions, action items, and important facts.
Omit: small talk, greetings, redundant information.

Conversation:
{messages}

Summary:`;

export async function summarizeConversation(
  messages: Message[],
  provider: LLMProvider,
): Promise<string> {
  const text = messages.map((m) => `[${m.userName}]: ${m.content}`).join("\n");
  const chunks: string[] = [];
  const generator = provider.chat("openai/gpt-4o-mini", [
    { role: "user", content: SUMMARIZE_PROMPT.replace("{messages}", text) },
  ], undefined, { maxTokens: 500 });

  for await (const chunk of generator) {
    if (chunk.type === "text") chunks.push(chunk.content);
  }
  return chunks.join("");
}
```

### 7.4 RAG: Semantic Search with pgvector

As established in the research document (§3.4), pgvector is the primary vector store recommendation because PostgreSQL is already deployed in the stack (see [03_Business_Logic_and_Persistence_Backend](./03_Business_Logic_and_Persistence_Backend.md)).

#### 7.4.1 Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE message_embeddings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id  UUID NOT NULL,
  workspace_id UUID NOT NULL,
  embedding   vector(1536),   -- OpenAI text-embedding-3-small dimension
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_message_embeddings_channel
  ON message_embeddings (channel_id);

CREATE INDEX idx_message_embeddings_vector
  ON message_embeddings
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

#### 7.4.2 Vector Index

```typescript
// packages/ai-bot/src/memory/vector-index.ts

export class ChannelVectorIndex {
  constructor(
    private db: DrizzleClient,
    private provider: LLMProvider,
  ) {}

  async indexMessage(message: Message): Promise<void> {
    const embedding = await this.provider.embeddings(
      "text-embedding-3-small",
      `[${message.userName}]: ${message.content}`,
    );

    await this.db.execute(sql`
      INSERT INTO message_embeddings (message_id, channel_id, workspace_id, embedding)
      VALUES (${message.id}, ${message.channelId}, ${message.workspaceId},
              ${JSON.stringify(embedding[0])}::vector)
    `);
  }

  async search(
    query: string,
    channelId: string,
    options?: { limit?: number; threshold?: number },
  ): Promise<ScoredMessage[]> {
    const queryEmbedding = await this.provider.embeddings("text-embedding-3-small", query);
    const limit = options?.limit ?? 10;
    const threshold = options?.threshold ?? 0.7;

    const results = await this.db.execute<ScoredMessage>(sql`
      SELECT
        m.id, m.content, m.user_id, m.created_at,
        1 - (me.embedding <=> ${JSON.stringify(queryEmbedding[0])}::vector) AS similarity
      FROM message_embeddings me
      JOIN messages m ON m.id = me.message_id
      WHERE me.channel_id = ${channelId}
        AND 1 - (me.embedding <=> ${JSON.stringify(queryEmbedding[0])}::vector) > ${threshold}
      ORDER BY similarity DESC
      LIMIT ${limit}
    `);

    return results;
  }
}
```

#### 7.4.3 RAG Injection Strategy

```typescript
// packages/ai-bot/src/memory/rag-injector.ts

export async function injectRagContext(
  userQuery: string,
  channelId: string,
  conversationMessages: ChatMessage[],
  vectorIndex: ChannelVectorIndex,
): Promise<ChatMessage[]> {
  if (!detectHistoricalIntent(userQuery)) return conversationMessages;

  const results = await vectorIndex.search(userQuery, channelId, { limit: 5 });
  if (results.length === 0) return conversationMessages;

  const contextBlock = [
    "[Relevant past messages from this channel]:",
    ...results.map((r, i) => `[${i + 1}] ${r.userName} (${r.createdAt}): ${r.content}`),
  ].join("\n");

  return [
    conversationMessages[0],                             // System prompt
    { role: "system", content: contextBlock },           // RAG context
    ...conversationMessages.slice(1),                     // Conversation
  ];
}

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

### 7.5 Context Injection Template

```
┌─────────────────────────────────────────────────┐
│ Layer 1: System Prompt                          │
│                                                 │
│ Workspace: Acme Corp (Engineering)              │
│ Channel:   #backend-discussion                  │
│ Topic:     "Backend architecture & API design"  │
│ Current user: @alice (Role: Admin)              │
│ Date:      2026-06-24                           │
│                                                 │
│ Layer 2: Conversation Window                    │
│ [Last 20 messages in #backend-discussion]       │
│                                                 │
│ Layer 3: RAG Injection (conditional)            │
│ [Top 5 semantically relevant past messages]     │
│                                                 │
│ Layer 4: Thread Context (if in thread)          │
│ Parent: @bob: "Should we use Redis Streams?"    │
│ Thread replies: [5 most recent in thread]       │
│                                                 │
│ Layer 5: User Input                             │
│ @alice: "/ai ask what did we decide about       │
│          the event bus?"                        │
└─────────────────────────────────────────────────┘
```

---

## 8. Prompt Engineering & System Templates

### 8.1 System Prompt Template

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

export function renderSystemPrompt(vars: SystemPromptVariables): string {
  let prompt = SYSTEM_PROMPT_TEMPLATE
    .replace("{workspaceName}", vars.workspaceName)
    .replace("{channelName}", vars.channelName)
    .replace("{channelTopic}", vars.channelTopic || "No topic set")
    .replace("{userName}", vars.userName)
    .replace("{userRole}", vars.userRole)
    .replace("{currentDate}", vars.currentDate)
    .replace("{memberList}", vars.memberList.join(", "))
    .replace("{maxResponseTokens}", String(vars.maxResponseTokens ?? 4096))
    .replace("{toolDescriptions}", buildToolDescriptions(vars.tools));

  // Append workspace style customizations
  if (vars.style) {
    prompt += "\n\n## Communication Style\n" + buildStylePrompt(vars.style);
  }

  return prompt;
}
```

### 8.2 Template Variables

| Variable | Source | Example |
|----------|--------|---------|
| `{workspaceName}` | `workspaces.name` | "Acme Corp" |
| `{channelName}` | `channels.name` | "backend-discussion" |
| `{channelTopic}` | `channels.topic` | "Backend architecture & API design" |
| `{userName}` | `users.display_name` | "Alice Chen" |
| `{userRole}` | `workspace_members.role` | "Admin" |
| `{currentDate}` | `new Date().toISOString()` | "2026-06-24" |
| `{memberList}` | Channel member names | "Alice, Bob, Carol" |
| `{toolDescriptions}` | Generated from `AgentsDefinition.tools` | — |
| `{maxResponseTokens}` | Agent config or workspace setting | "4096" |

### 8.3 Agent-Specific Sub-Prompts

#### 8.3.1 Summarize Agent

```typescript
// packages/ai-bot/src/prompts/summarize.ts

export const SUMMARIZE_PROMPT = `Summarize the following conversation.

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

Conversation:
{conversationText}`;
```

#### 8.3.2 Translate Agent

```typescript
// packages/ai-bot/src/prompts/translate.ts

export const TRANSLATE_PROMPT = `Translate the following text from {sourceLanguage} to {targetLanguage}.
Preserve formatting, code blocks, and markdown syntax.
Keep technical terms in their original language if they have no standard equivalent in the target language.
If the source language is not specified, auto-detect it.

Text to translate:
{text}`;
```

#### 8.3.3 Draft Agent

```typescript
// packages/ai-bot/src/prompts/draft.ts

export const DRAFT_PROMPT = `Draft a message based on the following topic description.
Match the tone and style of the workspace. Use markdown formatting as appropriate.

Recent channel context (for tone matching):
{recentMessages}

Topic: {topic}

Draft message:`;
```

### 8.4 Tone/Style Customization per Workspace

```typescript
// packages/ai-bot/src/prompts/style.ts

export interface WorkspaceStyle {
  tone: "professional" | "casual" | "technical" | "friendly";
  emojiLevel: "none" | "minimal" | "moderate" | "expressive";
  verbosity: "concise" | "balanced" | "detailed";
  customInstructions?: string;
}

export function buildStylePrompt(style: WorkspaceStyle): string {
  const toneMap: Record<WorkspaceStyle["tone"], string> = {
    professional: "Use a professional, business-appropriate tone. Avoid slang.",
    casual:       "Use a casual, conversational tone. Slang is acceptable.",
    technical:    "Use precise technical language. Assume technical expertise.",
    friendly:     "Use a warm, approachable tone. Be encouraging and supportive.",
  };

  const emojiMap: Record<WorkspaceStyle["emojiLevel"], string> = {
    none:        "Do not use emojis.",
    minimal:     "Use emojis sparingly (1-2 per message at most).",
    moderate:    "Use emojis naturally where appropriate.",
    expressive:  "Feel free to use emojis expressively.",
  };

  const verbosityMap: Record<WorkspaceStyle["verbosity"], string> = {
    concise:   "Keep responses brief. Prefer bullet points over paragraphs.",
    balanced:  "Provide balanced responses — enough detail without being verbose.",
    detailed:  "Provide thorough, detailed responses. Include examples when helpful.",
  };

  return [
    toneMap[style.tone],
    emojiMap[style.emojiLevel],
    verbosityMap[style.verbosity],
    style.customInstructions,
  ].filter(Boolean).join("\n");
}
```

### 8.5 Output Format Guidelines

| Response Type | Format | Example |
|---------------|--------|---------|
| Simple answer | Direct text | "The build pipeline runs at 9 AM UTC." |
| Lists | Markdown bullets | `• Item A\n• Item B` |
| Code | Fenced code blocks | `\`\`\`typescript\n...\n\`\`\`` |
| Data | Markdown tables | `\| Col A \| Col B \|\n\|...\|` |
| Search results | Numbered list with timestamps | `1. [2026-06-20] @bob: ...` |
| Decisions | Structured summary | `**Topic:** ... **Decision:** ...` |

---

## 9. Performance & Cost Optimization

### 9.1 Latency Targets

| Metric | Target | Measurement Point |
|--------|--------|-------------------|
| Time to first token (TTFT) | ≤ 200 ms | From LLM request to first `stream_chunk` emitted |
| Inter-chunk interval | ≤ 30 ms | Between successive `stream_chunk` emissions (batcher: 100 ms window) |
| Short response (< 200 tokens) | ≤ 3 s | Total wall-clock from request to `stream_end` |
| Long response (< 2000 tokens) | ≤ 30 s | Total wall-clock from request to `stream_end` |
| Tool call round-trip | ≤ 500 ms | From tool_call emitted to tool result injected |
| Command parse to `stream_start` | ≤ 100 ms | Pre-generation overhead |

### 9.2 Token Budget Allocation

```typescript
// packages/ai-bot/src/optimization/token-budget.ts

export class TokenBudget {
  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  allocate(
    systemPrompt: string,
    conversation: ChatMessage[],
    ragContext?: string,
    maxInputTokens?: number,
  ): ChatMessage[] {
    const totalBudget = maxInputTokens ?? Math.floor(
      this.provider.maxContextTokens(this.model) * 0.5,
    );

    const systemTokens = Math.ceil(systemPrompt.length / 3.5);
    const ragTokens = ragContext ? Math.ceil(ragContext.length / 3.5) : 0;
    const conversationBudget = totalBudget - systemTokens - ragTokens - 500;

    const result: ChatMessage[] = [{ role: "system", content: systemPrompt }];
    if (ragContext) result.push({ role: "system", content: ragContext });

    let usedTokens = 0;
    const included: ChatMessage[] = [];
    for (let i = conversation.length - 1; i >= 0; i--) {
      const msgTokens = Math.ceil(conversation[i].content.length / 3.5);
      if (usedTokens + msgTokens > conversationBudget) break;
      included.unshift(conversation[i]);
      usedTokens += msgTokens;
    }

    result.push(...included);
    return result;
  }
}
```

### 9.3 Caching Architecture

```
Layer 1: Anthropic Prompt Caching (provider-native)
  ├── Mark system prompt with cache_control: { type: "ephemeral" }
  ├── Anthropic caches server-side for 5 minutes
  └── 90% cost reduction on cached input tokens

Layer 2: Redis Summary Cache
  ├── Key: `ai:summary:{channelId}:{rangeStart}:{rangeEnd}`
  ├── TTL: 1 hour
  └── Invalidate when new messages arrive in the summarized range

Layer 3: Redis Embedding Cache
  ├── Key: `ai:emb:{sha256(text)}`
  ├── TTL: 24 hours
  └── Same message content → same embedding vector

Layer 4: Redis System Prompt Cache
  ├── Key: `ai:sysprompt:{workspaceId}:{channelId}`
  ├── TTL: 1 hour
  └── Invalidate on workspace settings change or channel topic update
```

```typescript
// packages/ai-bot/src/optimization/cache.ts

export class ContextCache {
  constructor(private redis: Redis) {}

  async getSummary(channelId: string, start: string, end: string): Promise<string | null> {
    return this.redis.get(`ai:summary:${channelId}:${start}:${end}`);
  }

  async setSummary(channelId: string, start: string, end: string, summary: string): Promise<void> {
    await this.redis.setex(`ai:summary:${channelId}:${start}:${end}`, 3600, summary);
  }

  async getEmbedding(textHash: string): Promise<number[] | null> {
    const data = await this.redis.get(`ai:emb:${textHash}`);
    return data ? JSON.parse(data) : null;
  }

  async setEmbedding(textHash: string, embedding: number[]): Promise<void> {
    await this.redis.setex(`ai:emb:${textHash}`, 86400, JSON.stringify(embedding));
  }

  async getSystemPrompt(workspaceId: string, channelId: string): Promise<string | null> {
    return this.redis.get(`ai:sysprompt:${workspaceId}:${channelId}`);
  }

  async setSystemPrompt(workspaceId: string, channelId: string, prompt: string): Promise<void> {
    await this.redis.setex(`ai:sysprompt:${workspaceId}:${channelId}`, 3600, prompt);
  }
}
```

### 9.4 Batch Embedding Generation

To minimize API calls, message embeddings are batched at the queue level:

```typescript
// packages/ai-bot/src/optimization/batch-embeddings.ts

export class BatchEmbeddingGenerator {
  private queue: Array<{ messageId: string; text: string; resolve: () => void }> = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private provider: LLMProvider,
    private db: DrizzleClient,
    private config = { batchSize: 20, flushIntervalMs: 5000 },
  ) {}

  enqueue(messageId: string, text: string): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ messageId, text, resolve });
      if (this.queue.length >= this.config.batchSize) this.flush();
      else if (!this.flushTimer) {
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
      const rows = batch.map((item, i) => ({
        messageId: item.messageId,
        embedding: sql`${JSON.stringify(embeddings[i])}::vector`,
      }));
      await this.db.insert(messageEmbeddings).values(rows);
      batch.forEach((item) => item.resolve());
    } catch (err) {
      this.queue.unshift(...batch);
      logger.error({ err, batchSize: batch.length }, "Batch embedding generation failed");
    }
  }
}
```

### 9.5 Degradation Strategy

```
Priority 1: Full AI response
  → LLM streaming with tools, full context window

Priority 2: Degraded — LLM without tools
  → If tool execution fails: respond without tools, note limitations
  → Prefix: "[Note: Some capabilities are currently unavailable]"

Priority 3: Degraded — Smaller model
  → Primary model is slow/unavailable → fall back to Haiku/Mini
  → Prefix: "[Using fast mode — responses may be less detailed]"

Priority 4: Degraded — Cached response
  → For repeated queries: return cached response
  → Suffix: "[Cached response from {timestamp}]"

Priority 5: Static fallback
  → All LLM providers unavailable:
  → "AI Assistant is temporarily unavailable. Please try again in a moment."
  → Log error, emit Prometheus counter, alert on-call

Priority 6: Silent failure
  → AI Bot process crashes entirely:
  → User's message still appears in the channel (normal message delivery)
  → No AI response generated; system sends DM to user about the failure
```

---

## 10. Privacy, Security & Compliance

### 10.1 Data Flow to LLM Providers

```
┌──────────────────────────────────────────────────────────────┐
│              What the AI Bot sends to LLM providers           │
│                                                              │
│  ✅ System prompt (bot persona, workspace name, channel)     │
│  ✅ Recent messages from the channel (non-E2E only)          │
│  ✅ RAG search results (messages from non-E2E channels)      │
│  ✅ User profile info (display name, workspace role)         │
│  ✅ Workspace-level custom instructions                      │
│                                                              │
│  ❌ Messages from E2E-encrypted channels                     │
│  ❌ Messages from channels the user is not a member of       │
│  ❌ User email addresses, phone numbers, IP addresses        │
│  ❌ Authentication tokens or API secrets                     │
│  ❌ File contents (only file names/types if needed)          │
│  ❌ User passwords or credentials                            │
└──────────────────────────────────────────────────────────────┘
```

### 10.2 E2E Channel Hard Block

The AI Bot cannot access E2E-encrypted channels. This is enforced at three levels:

```typescript
// packages/ai-bot/src/guard.ts

export async function guardAiAccess(
  channelId: string,
  workspaceId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const channel = await db.channels.findById(channelId);

  if (!channel) {
    return { allowed: false, reason: "Channel not found" };
  }

  // Level 1: Channel is encrypted
  if (channel.isEncrypted) {
    return { allowed: false, reason: "AI Bot cannot access E2E-encrypted channels" };
  }

  // Level 2: AI Bot is a member
  const membership = await db.channelMembers.findFirst({
    where: { channelId, memberType: "bot", memberId: AI_BOT_ID },
  });

  if (!membership) {
    return { allowed: false, reason: "AI Bot is not a member of this channel" };
  }

  return { allowed: true };
}
```

The three enforcement levels:
1. **Channel membership** — AI Bot cannot be added to E2E channels
2. **Event routing** — The Bot Engine's subscription router skips E2E channels entirely (see [04 design document §1.2](./04_Async_Bot_Engine_and_Event_Dispatch_Layer.md))
3. **Tool execution** — SDK API calls for E2E channels return `PERMISSION_DENIED` error

### 10.3 Workspace-Level Opt-In/Opt-Out

AI features are **off by default**. Workspace admins must explicitly enable them.

```typescript
// Database schema extensions:
// ALTER TABLE workspaces ADD COLUMN ai_enabled          BOOLEAN DEFAULT false;
// ALTER TABLE workspaces ADD COLUMN ai_provider         VARCHAR(50);
// ALTER TABLE workspaces ADD COLUMN ai_model            VARCHAR(100);
// ALTER TABLE workspaces ADD COLUMN ai_data_retention   VARCHAR(20) DEFAULT 'zero';
// ALTER TABLE workspaces ADD COLUMN ai_allowed_channels VARCHAR(20) DEFAULT 'all';
// ALTER TABLE workspaces ADD COLUMN ai_max_tokens       INTEGER DEFAULT 4096;
// ALTER TABLE workspaces ADD COLUMN ai_max_requests_per_user_per_day INTEGER DEFAULT 50;

export interface WorkspaceAiSettings {
  enabled: boolean;                              // Master switch
  provider: "openai" | "anthropic" | "google" | "openrouter" | "ollama";
  model: string;                                 // e.g., "gpt-4o-mini"
  dataRetention: "zero" | "30d" | "90d";        // LLM provider data retention preference
  allowedChannels: "all" | "selected";
  allowedChannelIds?: string[];
  maxTokensPerRequest: number;
  maxRequestsPerUserPerDay: number;
  style: WorkspaceStyle;
}
```

### 10.4 Data Retention

| Location | Policy |
|----------|--------|
| **nexus-chat server** | AI request/response logs retained per workspace policy; cost data retained indefinitely (aggregated, no message content); embedding vectors deleted when message is deleted (CASCADE) |
| **Redis** | Summaries: TTL 1 hour; Embedding cache: TTL 24 hours; System prompts: TTL 1 hour |
| **OpenAI API** | Zero Data Retention (ZDR) enabled for API usage |
| **Anthropic API** | Does not train on API data; 30-day retention for abuse monitoring |
| **Google Gemini API** | Zero data retention available via API settings |
| **OpenRouter** | Zero logging mode available |
| **Ollama (self-hosted)** | No data leaves the infrastructure |

### 10.5 GDPR Compliance

| Requirement | Implementation |
|-------------|---------------|
| **Data Processing Agreement (DPA)** | Executed with each LLM provider (OpenAI, Anthropic, Google all offer DPAs) |
| **Data Residency** | Self-hosted Ollama for EU-only data processing; provider selection by region |
| **Right to Access** | API endpoint: `GET /api/users/{id}/ai-interactions` — all AI logs for a user |
| **Right to Deletion** | Cascade delete: AI interaction logs → message embeddings → summaries → cost records (retain aggregate, strip PII) |
| **Consent** | Workspace-level opt-in with clear disclosure of data sent to LLM providers |
| **Data Minimization** | Only send necessary context; strip PII from messages before sending to LLM |
| **DPIA** | Conduct Data Protection Impact Assessment before enabling AI features |

### 10.6 Audit Logging

```typescript
// packages/ai-bot/src/audit.ts

export interface AiAuditLog {
  id: string;
  workspaceId: string;
  channelId: string;
  userId: string;           // Who triggered the request
  command: string;          // "ask", "summarize", "translate", etc.
  provider: string;         // "openai", "anthropic", etc.
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUSD: number;
  toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  durationMs: number;
  status: "completed" | "cancelled" | "error";
  errorMessage?: string;
  createdAt: Date;
}
```

---

## 11. Phased Implementation Roadmap

### 11.1 Phase 2 (AI MVP) — 3 months post-launch

| Milestone | Deliverables | Dependencies |
|-----------|-------------|--------------|
| **M1: Provider Layer** | `LLMProvider` interface + `OpenAIProvider` + `AnthropicProvider` + `ProviderRegistry` + `CostTracker` | Bot Engine queue system (04 design §7) |
| **M2: Streaming Protocol** | `message.stream_start/chunk/end/cancel` events + `ChunkBatcher` + `StreamManager` + client-side `StreamingMarkdownRenderer` | Socket.IO infrastructure (02 design) |
| **M3: Basic Commands** | `/ai ask`, `/ai summarize`, `/ai translate`, `/ai draft` — single agent with system prompt, no tools | M1, M2 |
| **M4: Tool Integration** | `ToolRegistry` + SDK API tools (searchChannelHistory, getChannelInfo, listChannelMembers, sendMessage, fetchWebPage) + safety classification + confirmation UI | M3, Bot SDK (04 design §4) |
| **M5: Memory Management** | `ConversationWindow` (sliding window) + `ConversationSummarizer` + `ContextCache` (Redis) + system prompt injection | M1, PostgreSQL |
| **M6: UI Polish** | Typewriter animation + progressive markdown + cancel button + tool call indicators + token count + scroll lock | Client shell (01 design) |
| **M7: Privacy & Opt-in** | Workspace AI settings page + provider/model selection + data retention controls + E2E guard + GDPR compliance + audit logging | M1, PostgreSQL |

### 11.2 Phase 3 (Advanced AI) — 6+ months post-launch

| Milestone | Deliverables | Technology |
|-----------|-------------|------------|
| **M8: RAG** | pgvector extension + message embedding pipeline + `BatchEmbeddingGenerator` + semantic search + hybrid search (keyword + vector) | pgvector, OpenAI text-embedding-3-small |
| **M9: Multi-Agent** | LangGraph supervisor-worker + debate pattern + task decomposition + agent handoff | LangGraph (Python microservice wrapped behind TypeScript API) |
| **M10: Advanced Tools** | Web fetch with domain allowlisting + E2B code execution sandbox + MCP server for tool exposure | E2B, MCP protocol |
| **M11: Self-Hosted LLM** | Ollama provider + vLLM integration + enterprise on-premise deployment guide | Ollama, vLLM |
| **M12: AI Analytics** | Usage dashboards + cost allocation per workspace/user + prompt effectiveness metrics + A/B testing framework | Prometheus + Grafana |
| **M13: Custom Agents** | Agent builder UI for workspace admins + community-contributed agent marketplace | Plugin protocol |
| **M14: Meeting AI** | Voice/video meeting transcription + meeting summarization + action item extraction | Whisper API + LLM |

### 11.3 Technology Recommendation Summary

| Component | Phase 2 | Phase 3 (Consideration) |
|-----------|---------|------------------------|
| **Agent Framework** | Vercel AI SDK (streaming-first, TypeScript) | LangGraph (multi-agent) |
| **Tool Standard** | OpenAI function calling format | MCP (Model Context Protocol) |
| **Vector Store** | pgvector | Pinecone / Qdrant (at >10M vectors) |
| **Primary Models** | GPT-4o, Claude 4 Sonnet | Self-hosted Ollama/vLLM |
| **Model Gateway** | Direct provider API | OpenRouter (unified + fallback) |
| **Embedding Model** | OpenAI text-embedding-3-small | Self-hosted BGE-M3 via Ollama |
| **Stream Transport** | WebSocket (existing Socket.IO) | WebSocket + Durable Sessions |
| **Observability** | Pino logs + Prometheus metrics | OpenTelemetry traces (LangSmith/Signoz) |
| **Code Sandbox** | N/A | E2B (gVisor-isolated) |
| **Memory** | Sliding window + Redis summaries | Long-term memory via LangGraph store |

### 11.4 Implementation Sequence

```
Week 1-2:  M1 — Provider Layer
  └─ Set up packages/ai-bot/ with Vercel AI SDK
  └─ Implement OpenAIProvider + AnthropicProvider
  └─ Implement ProviderRegistry with model resolution
  └─ Implement CostTracker with per-request cost recording

Week 3-4:  M2 — Streaming Protocol
  └─ Define StreamingEvents in packages/shared/
  └─ Implement ChunkBatcher with 100ms flush
  └─ Implement StreamManager tying AsyncGenerator → Socket.IO
  └─ Implement client-side StreamingMarkdownRenderer

Week 5-6:  M3 — Basic Commands
  └─ Define AgentDefinition for ask, summarize, translate, draft
  └─ Implement AiCommandRouter with slash command + @ai mention parsing
  └─ Build system prompt template with variable substitution
  └─ Implement simple generation loop (no tools yet)

Week 7-8:  M4 — Tool Integration
  └─ Implement ToolRegistry and NEXUS_CHAT_TOOLS catalog
  └─ Integrate Bot SDK API client for tool execution
  └─ Build safety classification (GREEN/YELLOW/RED)
  └─ Implement interactive confirmation flow (Block Kit)

Week 9-10: M5 — Memory Management
  └─ Implement ConversationWindow with sliding window
  └─ Implement ConversationSummarizer with cascading summaries
  └─ Implement ContextCache with Redis TTLs
  └─ Wire context building into agent dispatch pipeline

Week 11:   M6 — UI Polish
  └─ Implement typewriter animation (CSS @keyframes blink)
  └─ Implement scroll lock during streaming
  └─ Add cancel button with stream_cancel event
  └─ Add tool call indicator interstitials
  └─ Add token count display on completion

Week 12:   M7 — Privacy & Opt-in
  └─ Add workspace AI settings schema + UI
  └─ Implement guardAiAccess() three-level E2E block
  └─ Implement GDPR deletion endpoints
  └─ Implement audit logging for AI interactions
  └─ Write user-facing documentation
```
