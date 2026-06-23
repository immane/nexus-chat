---
lang: en
---

# @nexus-chat/bot-sdk — Node.js SDK Reference

> nexus-chat · Slack-like IM platform  
> Target audience: Node.js developers building nexus-chat bots  
> Package: `@nexus-chat/bot-sdk` · Runtime: Node.js 18+, Bun, Deno

---

## Table of Contents

1. [Package](#1-package)
2. [Quick Start](#2-quick-start)
3. [API Reference](#3-api-reference)
   - [Constructor Options](#31-constructor-options)
   - [Event Listeners](#32-event-listeners)
   - [Sending Messages](#33-sending-messages)
   - [Channel Methods](#34-channel-methods)
   - [Connection Lifecycle](#35-connection-lifecycle)
   - [Middleware Pipeline](#36-middleware-pipeline)
4. [Event Types](#4-event-types)
5. [Slash Command Registration](#5-slash-command-registration)
6. [Bot Manifest](#6-bot-manifest)
7. [Rate Limiting](#7-rate-limiting)
8. [Reconnection Strategy](#8-reconnection-strategy)
9. [Error Handling](#9-error-handling)
10. [Examples](#10-examples)
11. [Permission Scopes](#11-permission-scopes)
12. [Bot Token Format](#12-bot-token-format)

---

## 1. Package

| Attribute | Value |
|-----------|-------|
| **Package name** | `@nexus-chat/bot-sdk` |
| **Runtime** | Node.js 18+, Bun, Deno |
| **Transport** | WebSocket (`wss://`) |
| **TypeScript** | First-class; all types exported from the package root |

```bash
# npm
npm install @nexus-chat/bot-sdk

# pnpm
pnpm add @nexus-chat/bot-sdk

# yarn
yarn add @nexus-chat/bot-sdk

# bun
bun add @nexus-chat/bot-sdk
```

### Package Exports

```typescript
// Everything available from the root import
import {
  NexusBot,                    // Main bot client class
  BotEvent,                    // Event type namespace
  NexusBotError,               // Base error class
  RateLimitError,              // 429 error subclass
  BotManifest,                 // Manifest type
  BotCommand,                  // Command definition type
  MiddlewareFn,                // Middleware function signature
  BotOptions,                  // Constructor options type
  SendMessageOptions,          // sendMessage() opts type
  Message,                     // Message response type
  ChannelInfo,                 // Channel metadata type
  MemberInfo,                  // Member metadata type
  ReconnectConfig,             // Reconnect options type
  RateLimitConfig,             // Rate limit config type
} from '@nexus-chat/bot-sdk';
```

---

## 2. Quick Start

A 5-minute echo/ping bot:

```typescript
import { NexusBot } from '@nexus-chat/bot-sdk';

const bot = new NexusBot({
  token: 'nxbot_v1_xxxx',
  gatewayUrl: 'wss://gateway.nexus.chat/bot-ws',
});

bot.on('message', async (event) => {
  if (event.text === '/ping') {
    await bot.sendMessage(event.channel_id, 'Pong! 🏓');
  }
});

await bot.connect();
console.log('Bot is online');
```

The above bot:

1. Instantiates with a bot token and gateway URL.
2. Registers a listener for the `message` event.
3. When it receives a message whose text is `/ping`, it replies with `Pong!`.
4. Calls `connect()` to open the WebSocket, authenticate, and begin receiving events.

---

## 3. API Reference

### 3.1 Constructor Options

```typescript
interface BotOptions {
  /** Bot token issued by nexus-chat workspace admin. Format: nxbot_v1_XXXX */
  token: string;

  /** WebSocket gateway endpoint. Default: wss://gateway.nexus.chat/bot-ws */
  gatewayUrl?: string;

  /** Reconnection configuration */
  reconnect?: Partial<ReconnectConfig>;

  /** Rate limiting configuration */
  rateLimit?: Partial<RateLimitConfig>;

  /** Custom logger (must implement console-compatible .info/.warn/.error/.debug) */
  logger?: Logger;
}

interface ReconnectConfig {
  /** Enable automatic reconnection. Default: true */
  enabled: boolean;

  /** Maximum retry attempts. 0 = infinite. Default: 10 */
  maxRetries: number;

  /** Initial backoff delay in milliseconds. Default: 1000 */
  initialDelayMs: number;

  /** Maximum backoff delay in milliseconds. Default: 30000 */
  maxDelayMs: number;

  /** Apply random jitter to backoff delay. Default: true */
  jitter: boolean;
}

interface RateLimitConfig {
  /** Maximum outbound API calls per minute. Default: 120 */
  maxPerMinute: number;
}
```

**Full constructor example:**

```typescript
const bot = new NexusBot({
  token: 'nxbot_v1_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8',
  gatewayUrl: 'wss://gateway.nexus.chat/bot-ws',
  reconnect: {
    enabled: true,
    maxRetries: 10,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true,
  },
  rateLimit: {
    maxPerMinute: 120,
  },
});
```

---

### 3.2 Event Listeners

```typescript
// Signature
bot.on<K extends keyof BotEventMap>(
  event: K,
  handler: (event: BotEventMap[K]) => void | Promise<void>,
): void;

bot.off<K extends keyof BotEventMap>(
  event: K,
  handler: (event: BotEventMap[K]) => void | Promise<void>,
): void;
```

**Registering listeners:**

```typescript
bot.on('message', async (event) => {
  console.log(`[${event.channel_id}] ${event.user_id}: ${event.text}`);
  if (event.text === '/ping') {
    await bot.sendMessage(event.channel_id, 'Pong!');
  }
});

bot.on('slash_command', async (event) => {
  // Slash commands arrive as their own event type
  console.log(`Command: /${event.bot_name} ${event.command}`, event.args);
});

bot.on('button_clicked', async (event) => {
  console.log(`Button ${event.action_id} clicked by ${event.user_id}`);
  console.log(`Value: ${event.value}`);
});
```

**Event type table:**

| Event name | Trigger | One-time handler support |
|------------|---------|--------------------------|
| `message` | User sends a message in a subscribed channel | `bot.once('message', fn)` |
| `message_edited` | User edits an existing message | `bot.once('message_edited', fn)` |
| `message_deleted` | User deletes a message | `bot.once('message_deleted', fn)` |
| `channel_created` | A channel the bot belongs to is created | `bot.once('channel_created', fn)` |
| `channel_archived` | A channel the bot belongs to is archived | `bot.once('channel_archived', fn)` |
| `member_joined` | A user joins a subscribed channel | `bot.once('member_joined', fn)` |
| `member_left` | A user leaves a subscribed channel | `bot.once('member_left', fn)` |
| `slash_command` | User invokes a slash command targeting this bot | `bot.once('slash_command', fn)` |
| `button_clicked` | User clicks an interactive button from this bot | `bot.once('button_clicked', fn)` |
| `error` | SDK-level or transport error occurs | `bot.once('error', fn)` |
| `connected` | WebSocket authenticated and subscribed | `bot.once('connected', fn)` |
| `disconnected` | WebSocket closed (auto-reconnect pending) | `bot.once('disconnected', fn)` |

**One-time handlers:**

```typescript
// Fires only once, then auto-unregisters
bot.once('connected', () => {
  console.log('Bot connected for the first time');
});
```

---

### 3.3 Sending Messages

#### `bot.sendMessage(channelId, text, opts?)`

Send a text message to a channel.

```typescript
interface SendMessageOptions {
  /** Reply in a thread */
  threadId?: string;

  /** Rich layout blocks (future) */
  blocks?: Block[];

  /** Attachments */
  attachments?: Attachment[];
}
```

```typescript
// Simple message
const msg = await bot.sendMessage('ch_abc123', 'Hello, world!');

// Thread reply
const reply = await bot.sendMessage('ch_abc123', 'Threaded reply', {
  threadId: 'msg_parent_456',
});

// With attachments
const fileMsg = await bot.sendMessage('ch_abc123', 'Check this out', {
  attachments: [
    { type: 'file', url: 'https://example.com/report.pdf', name: 'report.pdf' },
  ],
});
```

**Returns** a `Message` object:

```typescript
interface Message {
  id: string;
  channel_id: string;
  user_id: string;      // The bot's user ID
  text: string;
  thread_id: string | null;
  created_at: string;   // ISO-8601
  edited_at: string | null;
}
```

#### `bot.editMessage(channelId, messageId, text)`

Edit a previously sent message. Only editable by the original sender (the bot itself).

```typescript
await bot.editMessage('ch_abc123', 'msg_xyz789', 'Updated content');
```

#### `bot.deleteMessage(channelId, messageId)`

Delete a previously sent message.

```typescript
await bot.deleteMessage('ch_abc123', 'msg_xyz789');
```

#### `bot.sendEphemeral(channelId, userId, text)`

Send a message visible only to the specified user. The message is never persisted and disappears when the user navigates away.

```typescript
await bot.sendEphemeral('ch_abc123', 'usr_xyz', 'Only you can see this');
```

---

### 3.4 Channel Methods

#### `bot.getChannelInfo(channelId)`

Retrieve metadata for a channel.

```typescript
const channel = await bot.getChannelInfo('ch_abc123');
// => { id: 'ch_abc123', name: 'general', is_archived: false, member_count: 42 }

interface ChannelInfo {
  id: string;
  name: string;
  description: string | null;
  is_archived: boolean;
  is_encrypted: boolean;
  member_count: number;
  created_by: string;
  created_at: string;
  archived_at: string | null;
}
```

#### `bot.getMemberList(channelId)`

Retrieve the list of members in a channel.

```typescript
const members = await bot.getMemberList('ch_abc123');
// => [{ user_id: 'usr_1', display_name: 'Alice', role: 'admin' }, ...]

interface MemberInfo {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
}
```

---

### 3.5 Connection Lifecycle

#### `bot.connect(): Promise<void>`

Opens the WebSocket to the gateway, authenticates with the bot token, subscribes to subscribed channels, and begins receiving events. Resolves when the `connected` event fires.

```typescript
await bot.connect();
```

**Connection state machine:**

```
CONNECTING → AUTHENTICATING → SUBSCRIBED → ACTIVE
                │                              │
                └── (auth failure) ────────────┤
                                               │
DISCONNECTED ←── (error/timeout/close) ←───────┘
     │
     └── (auto-reconnect with backoff) ──→ CONNECTING
```

#### `bot.disconnect(): Promise<void>`

Gracefully closes the WebSocket connection. Suppresses auto-reconnect.

```typescript
await bot.disconnect();
```

#### `bot.isConnected(): boolean`

Synchronous check of current connection state.

```typescript
if (!bot.isConnected()) {
  console.warn('Bot is offline; reconnect may be in progress');
}
```

---

### 3.6 Middleware Pipeline

The SDK provides a Koa-style middleware pipeline that wraps event processing. Each middleware receives the event and a `next()` function that yields control to the next middleware in the chain (or the inner handler).

```typescript
type MiddlewareFn = (
  event: BotEvent.Any,
  next: () => Promise<void>,
) => Promise<void>;
```

**Usage:**

```typescript
// Logging middleware
bot.use(async (event, next) => {
  const start = Date.now();
  console.log(`→ ${event.type} ${event.idempotency_key ?? ''}`);
  await next();
  console.log(`← ${event.type} done (${Date.now() - start}ms)`);
});

// Permission guard middleware
bot.use(async (event, next) => {
  if (event.type === 'message' && event.text.startsWith('!admin')) {
    const allowed = await checkAdmin(event.user_id);
    if (!allowed) {
      await bot.sendEphemeral(event.channel_id, event.user_id, 'Admin only.');
      return; // Short-circuit: don't call next()
    }
  }
  await next();
});

// Error boundary middleware
bot.use(async (event, next) => {
  try {
    await next();
  } catch (err) {
    console.error(`Error handling ${event.type}:`, err);
    // Middleware can swallow errors or rethrow
  }
});

// Application handlers run after all middleware
bot.on('message', async (event) => {
  // This runs after all use() middleware have called next()
  await handleCommand(event);
});
```

**Execution order:**

```
Event arrives
  → middleware[0].next()
    → middleware[1].next()
      → middleware[2].next()
        → registered .on() handler
      ← return
    ← return
  ← return
```

---

## 4. Event Types

Every event extends a common base:

```typescript
namespace BotEvent {
  interface Base {
    /** Event type discriminator */
    type: string;

    /** Idempotency key: {messageId}:{eventType} — safe to re-process */
    idempotency_key: string;

    /** Workspace ID */
    workspace_id: string;

    /** ISO-8601 server timestamp */
    timestamp: string;
  }
}
```

### 4.1 `message`

Emitted when a user sends a message in a channel the bot is subscribed to.

```typescript
interface Message extends BotEvent.Base {
  type: 'message';

  /** Channel where the message was posted */
  channel_id: string;

  /** User who sent the message */
  user_id: string;

  /** Display name of the sending user */
  user_display_name: string;

  /** Message text content (plain text, max 4000 chars) */
  text: string;

  /** Thread parent ID, if this is a thread reply */
  thread_id: string | null;

  /** IDs of users @mentioned in the message */
  mentions: string[];

  /** Attached files or media */
  attachments: Attachment[];

  /** Message sent by a bot (true) vs. human user (false) */
  is_bot: boolean;
}

interface Attachment {
  type: 'image' | 'file' | 'link';
  url: string;
  name: string;
  size_bytes: number;
  mime_type: string;
}
```

### 4.2 `message_edited`

Emitted when a user edits a previously sent message.

```typescript
interface MessageEdited extends BotEvent.Base {
  type: 'message_edited';
  channel_id: string;
  message_id: string;
  user_id: string;         // Editor
  old_text: string;
  new_text: string;
}
```

### 4.3 `message_deleted`

Emitted when a user deletes a message.

```typescript
interface MessageDeleted extends BotEvent.Base {
  type: 'message_deleted';
  channel_id: string;
  message_id: string;
  user_id: string;         // Deleter
}
```

### 4.4 `channel_created`

Emitted when a channel the bot belongs to is created.

```typescript
interface ChannelCreated extends BotEvent.Base {
  type: 'channel_created';
  channel_id: string;
  name: string;
  description: string | null;
  created_by: string;      // Creator user ID
  is_encrypted: boolean;
}
```

### 4.5 `channel_archived`

Emitted when a channel the bot belongs to is archived.

```typescript
interface ChannelArchived extends BotEvent.Base {
  type: 'channel_archived';
  channel_id: string;
  archived_by: string;
}
```

### 4.6 `member_joined`

Emitted when a user joins a channel the bot is subscribed to.

```typescript
interface MemberJoined extends BotEvent.Base {
  type: 'member_joined';
  channel_id: string;
  user_id: string;
  user_display_name: string;
}
```

### 4.7 `member_left`

Emitted when a user leaves a channel the bot is subscribed to.

```typescript
interface MemberLeft extends BotEvent.Base {
  type: 'member_left';
  channel_id: string;
  user_id: string;
  user_display_name: string;
}
```

### 4.8 `slash_command`

Emitted when a user invokes a slash command targeting this bot.

```typescript
interface SlashCommand extends BotEvent.Base {
  type: 'slash_command';

  /** The bot name as registered (e.g., "poll") */
  bot_name: string;

  /** The command name (first token after /botname) */
  command: string;

  /** Parsed arguments (quoted strings respected) */
  args: string[];

  /** 3-second response window token — pass to respond() */
  trigger_id: string;

  /** Channel where the command was invoked */
  channel_id: string;

  /** User who invoked the command */
  user_id: string;
}
```

### 4.9 `button_clicked`

Emitted when a user clicks an interactive button rendered by this bot.

```typescript
interface ButtonClicked extends BotEvent.Base {
  type: 'button_clicked';

  /** The action_id set when the button was created */
  action_id: string;

  /** The value payload set on the button */
  value: string;

  /** Message that contains the button */
  message_id: string;

  /** Channel where the interaction happened */
  channel_id: string;

  /** User who clicked */
  user_id: string;
}
```

### 4.10 Lifecycle Events

```typescript
interface Connected extends BotEvent.Base {
  type: 'connected';
  session_id: string;
  bot_user_id: string;
}

interface Disconnected extends BotEvent.Base {
  type: 'disconnected';
  code: number;     // WebSocket close code
  reason: string;   // Human-readable reason
}

interface ErrorEvent extends BotEvent.Base {
  type: 'error';
  code: string;           // Machine-readable error code
  message: string;        // Human-readable description
  recoverable: boolean;   // Whether the connection will retry
}
```

### 4.11 Event Map

The full event map used internally for typed `on()`/`off()`:

```typescript
interface BotEventMap {
  message:          BotEvent.Message;
  message_edited:   BotEvent.MessageEdited;
  message_deleted:  BotEvent.MessageDeleted;
  channel_created:  BotEvent.ChannelCreated;
  channel_archived: BotEvent.ChannelArchived;
  member_joined:    BotEvent.MemberJoined;
  member_left:      BotEvent.MemberLeft;
  slash_command:    BotEvent.SlashCommand;
  button_clicked:   BotEvent.ButtonClicked;
  connected:        BotEvent.Connected;
  disconnected:     BotEvent.Disconnected;
  error:            BotEvent.ErrorEvent;
}
```

---

## 5. Slash Command Registration

Bots declare slash commands via a manifest (see [Section 6](#6-bot-manifest)). Commands are parsed on the server and dispatched as `slash_command` events.

### Command Format

```
/botname command [args...]
```

Where:
- **botname** — the bot's registered name in the workspace (alphanumeric, no spaces)
- **command** — the specific action (empty string means bare `/botname`)
- **args** — whitespace-delimited or quoted arguments

**Examples:**

```
/weather tokyo
/poll "What's for lunch?" "Pizza" "Sushi" "Salad"
/deploy service-cart staging
```

### Command Definition Type

```typescript
interface BotCommand {
  /** Command name: lowercase, alphanumeric + hyphens/underscores, max 32 chars */
  name: string;

  /** Short description shown in autocomplete (max 100 chars) */
  description: string;

  /** Usage hint, e.g. "/weather <city>" (max 200 chars, optional) */
  usage?: string;

  /** Argument definitions */
  args?: CommandArg[];
}

interface CommandArg {
  /** Argument name */
  name: string;

  /** Human-readable description */
  description: string;

  /** Whether the argument is required */
  required: boolean;

  /** Expected type */
  type: 'string' | 'number' | 'user' | 'channel';
}
```

### Command Definition Example

```typescript
const commands: BotCommand[] = [
  {
    name: 'weather',
    description: 'Get current weather for a city',
    usage: '/weather <city>',
    args: [
      { name: 'city', description: 'City name', required: true, type: 'string' },
    ],
  },
  {
    name: 'poll',
    description: 'Create a poll',
    usage: '/poll "Question" "Option A" "Option B" ...',
    args: [
      { name: 'question', description: 'Poll question', required: true, type: 'string' },
      { name: 'options', description: 'Poll options (2-10)', required: true, type: 'string' },
    ],
  },
  {
    name: 'deploy',
    description: 'Deploy a service to an environment',
    usage: '/deploy <service> <environment>',
    args: [
      { name: 'service', description: 'Service name', required: true, type: 'string' },
      { name: 'environment', description: 'Target environment', required: true, type: 'string' },
    ],
  },
];
```

### Handling Slash Commands

```typescript
bot.on('slash_command', async (event) => {
  switch (event.command) {
    case 'weather': {
      const city = event.args[0];
      if (!city) {
        await bot.sendEphemeral(
          event.channel_id,
          event.user_id,
          'Usage: /weather <city>',
        );
        return;
      }
      const weather = await fetchWeather(city);
      await bot.sendMessage(event.channel_id, weather);
      break;
    }
    case 'poll': {
      const question = event.args[0];
      const options = event.args.slice(1);
      if (!question || options.length < 2) {
        await bot.sendEphemeral(
          event.channel_id,
          event.user_id,
          'Usage: /poll "Question" "Option A" "Option B" ...',
        );
        return;
      }
      await createPoll(event.channel_id, question, options);
      break;
    }
    default:
      await bot.sendEphemeral(
        event.channel_id,
        event.user_id,
        `Unknown command: ${event.command}`,
      );
  }
});
```

---

## 6. Bot Manifest

Every bot is described by a manifest registered at creation time. The manifest declares the bot's identity, capabilities, permission scopes, and connection mode.

```typescript
interface BotManifest {
  /** Display name (max 50 chars) */
  name: string;

  /** Short description shown in the bot directory (max 500 chars) */
  description: string;

  /** Declared slash commands (max 50) */
  commands: BotCommand[];

  /** Required permission scopes */
  scopes: string[];

  /** Connection mode: persistent WebSocket or HTTP webhook */
  connectionMode: 'websocket' | 'webhook';

  /** Webhook URL (required if connectionMode is 'webhook') */
  webhookUrl?: string;

  /** Public icon URL for the bot directory */
  iconUrl?: string;
}
```

### Example Manifest

```typescript
const manifest: BotManifest = {
  name: 'WeatherBot',
  description: 'Provides real-time weather forecasts for cities worldwide. Powered by OpenWeatherMap.',
  commands: [
    {
      name: 'weather',
      description: 'Get current weather for a city',
      usage: '/weather <city>',
      args: [
        { name: 'city', description: 'City name', required: true, type: 'string' },
      ],
    },
    {
      name: 'forecast',
      description: 'Get 5-day forecast for a city',
      usage: '/forecast <city>',
      args: [
        { name: 'city', description: 'City name', required: true, type: 'string' },
      ],
    },
  ],
  scopes: [
    'messages:read',
    'messages:write',
    'commands',
  ],
  connectionMode: 'websocket',
  iconUrl: 'https://mybot.example.com/weather-icon.png',
};
```

---

## 7. Rate Limiting

The SDK enforces a client-side **token bucket** rate limiter to prevent exceeding the server-side threshold. It also respects server-returned `429 Too Many Requests` responses by globally pausing all outbound calls for the `Retry-After` duration.

### How It Works

```
                ┌──────────────────────────┐
                │     Token Bucket          │
                │  Capacity: maxPerMinute   │
                │  Refill: linear, 60 s     │
                └─────────────┬────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Token available?  │
                    └────┬─────────┬────┘
                     Yes │         │ No
                         │         │
                         ▼         ▼
                  Execute API   Wait for next
                      call      token (sleep)
                         │
                         ▼
               ┌────────────────────┐
               │ Server returns 429? │
               └──────┬─────────┬───┘
                  Yes │         │ No
                      │         │
                      ▼         ▼
              Global pause    Consume 1
              for Retry-After   token
              seconds
```

### Configuration

```typescript
const bot = new NexusBot({
  token: 'nxbot_v1_xxxx',
  rateLimit: {
    maxPerMinute: 120,  // Default: 120 API calls per minute
  },
});
```

### 429 Handling

When the server returns `429 Too Many Requests`, the SDK:

1. Reads the `Retry-After` header value (in seconds).
2. Sets `globalPauseUntil = now + Retry-After * 1000`.
3. All outgoing API calls are queued until the pause expires.
4. Emits a warning log: `Rate limit hit; pausing for <Retry-After>s`.

```typescript
bot.on('error', (event) => {
  if (event.code === 'rate_limited') {
    console.warn(`Rate limited: ${event.message}`);
  }
});
```

### Bot-Level Limit (Server-Side)

| Attribute | Value |
|-----------|-------|
| Default limit | 120 requests/min per bot |
| Window type | Sliding window (Redis ZSET) |
| Key pattern | `ratelimit:bot:{botId}:minute` |
| Response on exceed | `429 Too Many Requests` + `Retry-After` header |
| Actual algorithm | Server-side Lua script with atomic `ZREMRANGEBYSCORE` + `ZADD` |

---

## 8. Reconnection Strategy

The SDK implements **exponential backoff with full jitter** for automatic reconnection. This is production-hardened against thundering-herd reconnect storms.

### Algorithm

```
delay = min(initialDelayMs × 2^attempt, maxDelayMs)
jittered = delay × (0.5 + random(0, 0.5))   // Full jitter, 50%–100% of delay
```

### Sequence Example

| Attempt | Base delay | Jittered range | Cumulative (max) |
|---------|-----------|----------------|-------------------|
| 0 | 1 s | 0.5–1.0 s | 1 s |
| 1 | 2 s | 1.0–2.0 s | 3 s |
| 2 | 4 s | 2.0–4.0 s | 7 s |
| 3 | 8 s | 4.0–8.0 s | 15 s |
| 4 | 16 s | 8.0–16.0 s | 31 s |
| 5 | 30 s (capped) | 15.0–30.0 s | 61 s |
| 6+ | 30 s (capped) | 15.0–30.0 s | +30 s each |

### Configuration

```typescript
const bot = new NexusBot({
  token: 'nxbot_v1_xxxx',
  reconnect: {
    enabled: true,          // Enable auto-reconnect
    maxRetries: 10,         // Give up after 10 attempts (0 = infinite)
    initialDelayMs: 1000,   // Start at 1 second
    maxDelayMs: 30000,      // Cap at 30 seconds
    jitter: true,           // Add ±50% random jitter
  },
});
```

### Lifecycle Events During Reconnect

```typescript
bot.on('disconnected', (event) => {
  console.warn(`Disconnected: code=${event.code} reason="${event.reason}"`);
  // Auto-reconnect is in progress — no manual action needed
});

bot.on('connected', (event) => {
  console.log(`Reconnected! Session: ${event.session_id}`);
  // Bot is back online; handlers resume receiving events
});

bot.on('error', (event) => {
  if (!event.recoverable) {
    console.error('Connection exhausted all retries:', event.message);
    process.exit(1);
  }
});
```

### Heartbeat

The SDK automatically sends WebSocket `PING` frames every 30 seconds. If the server does not receive a ping within 60 seconds (2× heartbeat interval), it closes the connection. The SDK then triggers the reconnection flow.

---

## 9. Error Handling

### Error Classes

```typescript
class NexusBotError extends Error {
  /** Machine-readable error code */
  code: string;

  /** HTTP status code (for API errors) */
  status: number;

  /** Additional context payload */
  detail: Record<string, unknown>;
}

class RateLimitError extends NexusBotError {
  code: 'rate_limited';

  /** Seconds until the rate limit resets */
  retryAfterSeconds: number;
}

class AuthError extends NexusBotError {
  code: 'invalid_token' | 'token_expired' | 'token_revoked';
}

class PermissionError extends NexusBotError {
  code: 'permission_denied';
  requiredScope: string;
}

class TransportError extends NexusBotError {
  code: 'connection_failed' | 'connection_closed' | 'timeout';
}
```

### Error Handling Patterns

**Global error listener:**

```typescript
bot.on('error', (event) => {
  switch (event.code) {
    case 'rate_limited':
      console.warn(`Rate limited: ${event.message}`);
      break;
    case 'permission_denied':
      console.error(`Missing scope: ${event.message}`);
      break;
    case 'invalid_token':
      console.error('Bot token is invalid or expired. Regenerate it in workspace settings.');
      break;
    default:
      console.error(`Unhandled error [${event.code}]: ${event.message}`);
  }
});
```

**Per-call error handling:**

```typescript
import { NexusBotError, RateLimitError, PermissionError } from '@nexus-chat/bot-sdk';

async function safeSend(bot: NexusBot, channelId: string, text: string) {
  try {
    await bot.sendMessage(channelId, text);
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn(`Backing off for ${err.retryAfterSeconds}s`);
    } else if (err instanceof PermissionError) {
      console.error(`Missing scope: ${err.requiredScope}`);
      // Notify workspace admin to update bot scopes
    } else if (err instanceof NexusBotError) {
      console.error(`API error [${err.code}]: ${err.message}`, err.detail);
    } else {
      console.error('Unexpected error:', err);
    }
  }
}
```

**Middleware error boundary:**

```typescript
bot.use(async (event, next) => {
  try {
    await next();
  } catch (err) {
    console.error(`Crash in handler for ${event.type}:`, err);
    // Don't rethrow — keep the bot alive
    if (event.type === 'message') {
      await bot.sendEphemeral(
        event.channel_id,
        event.user_id,
        'Sorry, something went wrong processing your request.',
      ).catch(() => {}); // Best-effort
    }
  }
});
```

### Error Code Reference

| Code | Meaning | Recoverable |
|------|---------|-------------|
| `invalid_token` | Bot token is malformed or invalid | No — regenerate token |
| `token_expired` | Bot token has expired | No — regenerate token |
| `token_revoked` | Bot token was revoked by workspace admin | No — reinstall bot |
| `permission_denied` | Bot lacks a required scope for the action | Depends — update scopes |
| `rate_limited` | Bot exceeded rate limit | Yes — SDK auto-pauses |
| `channel_not_found` | Target channel does not exist | No |
| `message_not_found` | Target message does not exist | No |
| `e2e_bots_disabled` | Bot cannot interact with E2E-encrypted channels | No |
| `connection_failed` | WebSocket handshake failed | Yes — auto-reconnect |
| `connection_closed` | WebSocket closed unexpectedly | Yes — auto-reconnect |
| `timeout` | API call timed out | Yes — may retry |

---

## 10. Examples

### 10.1 Echo Bot

A simple bot that echoes back any message that mentions it, or responds to `/echo`.

```typescript
import { NexusBot } from '@nexus-chat/bot-sdk';

const bot = new NexusBot({
  token: process.env.NEXUS_BOT_TOKEN!,
  gatewayUrl: process.env.NEXUS_GATEWAY_URL ?? 'wss://gateway.nexus.chat/bot-ws',
});

bot.on('slash_command', async (event) => {
  if (event.command === 'echo') {
    const text = event.args.join(' ');
    if (!text) {
      await bot.sendEphemeral(event.channel_id, event.user_id, 'Usage: /echo <text>');
      return;
    }
    await bot.sendMessage(event.channel_id, text);
  }
});

bot.on('member_joined', async (event) => {
  await bot.sendMessage(
    event.channel_id,
    `Welcome to the channel, ${event.user_display_name}! ` +
    `Try /echo "Hello, world!" to see me in action.`,
  );
});

bot.on('error', (event) => {
  console.error(`[${event.code}] ${event.message}`);
});

await bot.connect();
console.log('EchoBot is online');
```

### 10.2 Poll Bot

A poll bot that creates polls via slash command and collects reactions.

```typescript
import { NexusBot, BotEvent } from '@nexus-chat/bot-sdk';

const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const bot = new NexusBot({
  token: process.env.NEXUS_BOT_TOKEN!,
  rateLimit: { maxPerMinute: 120 },
});

interface ActivePoll {
  messageId: string;
  channelId: string;
  question: string;
  options: string[];
  votes: Map<string, number>;
}

const activePolls = new Map<string, ActivePoll>();

bot.on('slash_command', async (event) => {
  if (event.command !== 'poll') return;

  const [question, ...rawOptions] = event.args;

  if (!question || rawOptions.length < 2) {
    await bot.sendEphemeral(
      event.channel_id,
      event.user_id,
      'Usage: /poll "Question" "Option A" "Option B" ...',
    );
    return;
  }

  if (rawOptions.length > 10) {
    await bot.sendEphemeral(
      event.channel_id,
      event.user_id,
      'Maximum 10 options allowed.',
    );
    return;
  }

  const pollBody = `**${question}**\n\n${rawOptions
    .map((opt, i) => `${POLL_EMOJIS[i]} ${opt}`)
    .join('\n')}`;

  const msg = await bot.sendMessage(event.channel_id, pollBody);

  activePolls.set(msg.id, {
    messageId: msg.id,
    channelId: event.channel_id,
    question,
    options: rawOptions,
    votes: new Map(),
  });
});

await bot.connect();
console.log('PollBot is online');
```

### 10.3 CI/CD Notifier Bot

A bot that receives webhook events from a CI/CD pipeline and posts status updates to a designated channel.

```typescript
import { NexusBot } from '@nexus-chat/bot-sdk';

const bot = new NexusBot({
  token: process.env.NEXUS_BOT_TOKEN!,
  reconnect: { enabled: true, maxRetries: 0 }, // Infinite retry for CI/CD reliability
});

const NOTIFY_CHANNEL = process.env.NOTIFY_CHANNEL_ID!;

bot.on('slash_command', async (event) => {
  if (event.command !== 'deploy') return;

  const [service, environment] = event.args;

  if (!service || !environment) {
    await bot.sendEphemeral(
      event.channel_id,
      event.user_id,
      'Usage: /deploy <service> <environment>',
    );
    return;
  }

  const validEnvs = ['staging', 'production'];
  if (!validEnvs.includes(environment)) {
    await bot.sendEphemeral(
      event.channel_id,
      event.user_id,
      `Invalid environment. Choose: ${validEnvs.join(', ')}`,
    );
    return;
  }

  await bot.sendMessage(
    event.channel_id,
    `🚀 Deploying **${service}** to **${environment}**...`,
  );

  try {
    const result = await triggerDeploy(service, environment);
    const statusEmoji = result.success ? '✅' : '❌';

    await bot.sendMessage(
      event.channel_id,
      `${statusEmoji} Deploy ${result.success ? 'succeeded' : 'failed'}: ` +
      `**${service}** → **${environment}**\n` +
      `\`\`\`\n${result.log}\n\`\`\``,
    );
  } catch (err) {
    await bot.sendMessage(
      event.channel_id,
      `❌ Deploy error: **${service}** → **${environment}**\n` +
      `\`\`\`\n${String(err)}\n\`\`\``,
    );
  }
});

bot.on('message', async (event) => {
  if (event.text === '/deploy_status') {
    const history = await getDeployHistory(10);
    if (history.length === 0) {
      await bot.sendMessage(event.channel_id, 'No recent deployments.');
      return;
    }
    const lines = history.map(
      (d) => `${d.success ? '✅' : '❌'} **${d.service}** → ${d.env} (${d.timestamp})`,
    );
    await bot.sendMessage(
      event.channel_id,
      `**Recent deploys:**\n${lines.join('\n')}`,
    );
  }
});

// ── External HTTP endpoint for CI/CD webhooks ──────────
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  if (req.url === '/notify' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        await bot.sendMessage(NOTIFY_CHANNEL, text);
        res.writeHead(200).end('ok');
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(3000, () => console.log('CI/CD webhook listener on :3000'));

await bot.connect();
console.log('CICDNotifierBot is online');

// ── Stubs for deploy logic ─────────────────────────────
async function triggerDeploy(service: string, env: string) {
  // Call your actual CI/CD API here
  return { success: true, log: 'Deploy completed in 12s' };
}

async function getDeployHistory(n: number) {
  return []; // Query your deploy database
}
```

### 10.4 Full-Featured Bot with Middleware

A complete example combining middleware, slash commands, error handling, and connection lifecycle management:

```typescript
import {
  NexusBot,
  BotEvent,
  NexusBotError,
  RateLimitError,
} from '@nexus-chat/bot-sdk';

// ── Configuration ──────────────────────────────────────

const bot = new NexusBot({
  token: process.env.NEXUS_BOT_TOKEN!,
  gatewayUrl: process.env.NEXUS_GATEWAY_URL ?? 'wss://gateway.nexus.chat/bot-ws',
  reconnect: {
    enabled: true,
    maxRetries: 10,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    jitter: true,
  },
  rateLimit: {
    maxPerMinute: 120,
  },
  logger: {
    info: (msg, ctx) => console.log(`[INFO] ${msg}`, ctx ?? ''),
    warn: (msg, ctx) => console.warn(`[WARN] ${msg}`, ctx ?? ''),
    error: (msg, ctx) => console.error(`[ERROR] ${msg}`, ctx ?? ''),
    debug: (msg, ctx) => console.debug(`[DEBUG] ${msg}`, ctx ?? ''),
  },
});

// ── Middleware ─────────────────────────────────────────

// 1. Request logging
bot.use(async (event, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  if (ms > 500) {
    console.warn(`Slow handler: ${event.type} took ${ms}ms`);
  }
});

// 2. Global error boundary
bot.use(async (event, next) => {
  try {
    await next();
  } catch (err) {
    console.error(`Handler error for ${event.type}:`, err);
  }
});

// ── Event Handlers ─────────────────────────────────────

bot.on('connected', (event) => {
  console.log(`✅ Connected as ${event.bot_user_id} (session: ${event.session_id})`);
});

bot.on('disconnected', (event) => {
  console.warn(`⚠️  Disconnected (code ${event.code}): ${event.reason}`);
});

bot.on('error', (event) => {
  if (event.recoverable) {
    console.warn(`Recoverable error: ${event.message}`);
  } else {
    console.error(`Fatal error [${event.code}]: ${event.message}`);
  }
});

bot.on('slash_command', async (event) => {
  await handleCommand(event).catch((err) => {
    console.error(`Command failed: ${event.command}`, err);
  });
});

bot.on('message', async (event) => {
  // Ignore bot messages to avoid echo loops
  if (event.is_bot) return;

  if (event.text.startsWith('!')) {
    await handleBangCommand(event);
  }
});

// ── Command Dispatch ───────────────────────────────────

async function handleCommand(event: BotEvent.SlashCommand): Promise<void> {
  switch (event.command) {
    case 'ping':
      await bot.sendMessage(event.channel_id, 'Pong!');
      break;
    case 'help':
      await bot.sendMessage(
        event.channel_id,
        'Available commands: /ping, /help, /deploy',
      );
      break;
    default:
      await bot.sendEphemeral(
        event.channel_id,
        event.user_id,
        `Unknown command: ${event.command}. Try /help.`,
      );
  }
}

async function handleBangCommand(event: BotEvent.Message): Promise<void> {
  try {
    await bot.sendMessage(event.channel_id, `You said: ${event.text}`);
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn(`Rate limited; retry in ${err.retryAfterSeconds}s`);
    } else {
      throw err;
    }
  }
}

// ── Graceful Shutdown ──────────────────────────────────

process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await bot.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await bot.disconnect();
  process.exit(0);
});

// ── Start ──────────────────────────────────────────────

await bot.connect();
console.log('Bot is running. Press Ctrl+C to stop.');
```

---

## 11. Permission Scopes

Every bot declares required scopes at registration. Scopes are validated on every API call and event delivery.

| Scope | Description | Required For |
|-------|-------------|--------------|
| `messages:read` | Read messages in subscribed channels | Receiving `message`, `message_edited`, `message_deleted` events |
| `messages:write` | Send and edit messages | `sendMessage()`, `editMessage()`, `deleteMessage()`, `sendEphemeral()` |
| `channels:read` | Read channel metadata | `getChannelInfo()` |
| `channels:manage` | Create / archive channels | Channel management endpoints (future) |
| `members:read` | Read member list and presence | `getMemberList()`, `member_joined`, `member_left` events |
| `commands` | Register and respond to slash commands | Slash command dispatch; `slash_command` event |
| `interactions` | Respond to button / modal interactions | `button_clicked` event |
| `files:read` | Read files shared in channels | File-related events |
| `files:write` | Upload files | `uploadFile()` (future) |

**Declaring scopes in the manifest:**

```typescript
const manifest = {
  // ...
  scopes: [
    'messages:read',
    'messages:write',
    'channels:read',
    'commands',
    'interactions',
  ],
};
```

If a bot attempts an API call outside its declared scopes, the server returns `permission_denied`:

```typescript
bot.on('error', (event) => {
  if (event.code === 'permission_denied') {
    console.error(`Missing scope. Update your bot's scopes in workspace settings.`);
    console.error(`Required: ${event.requiredScope}`);
  }
});
```

---

## 12. Bot Token Format

Bot tokens follow a structured, self-validating format:

```
nxbot_v1_<base64url(hmac-sha256)>

Example:
nxbot_v1_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0
```

| Component | Description |
|-----------|-------------|
| `nxbot` | Token prefix identifying the nexus-chat platform |
| `v1` | Token version (for future rotation/upgrade) |
| `base64url(HMAC)` | Self-validating signature — the server can verify authenticity without a DB lookup |

### Security Properties

- **Self-validation**: The server recomputes the HMAC using a private signing secret (`BOT_TOKEN_SIGNING_SECRET`, 64-byte hex). A matching HMAC proves the token was issued by the platform.
- **DB lookup for auth**: After format validation, the server hashes the token with SHA-256 and looks up `SHA256(token)` in the database to retrieve the bot's ID, workspace, and scopes.
- **No logging**: Tokens are redacted from all log output by default.
- **Revocable**: Workspace admins can revoke tokens instantly via the workspace settings UI.
- **Rotatable**: The `v1` version prefix enables seamless token format upgrades without breaking existing bots.

### Environment Variable Best Practice

```bash
# .env (never committed to version control)
NEXUS_BOT_TOKEN=nxbot_v1_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8
```

```typescript
// Load from environment
const bot = new NexusBot({
  token: process.env.NEXUS_BOT_TOKEN!,
});

// Or load from a secrets manager
import { getSecret } from './secrets';
const bot = new NexusBot({
  token: await getSecret('nexus-bot-token'),
});
```

---

## Appendix A: TypeScript Configuration

The SDK requires `strict: true` in your `tsconfig.json` (default with the package). The minimum recommended TypeScript configuration for bot projects:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

## Appendix B: Logging Interface

```typescript
interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}
```

The default logger writes to `console`. You can supply a custom logger (e.g., Pino, Winston) via the constructor options:

```typescript
import pino from 'pino';

const logger = pino({ name: 'my-bot' });

const bot = new NexusBot({
  token: 'nxbot_v1_xxxx',
  logger,
});
```

## Appendix C: WebSocket Protocol Frames

For advanced debugging or custom transport implementations, the SDK uses this wire protocol:

```
Client → Server                          Server → Client
────────────────────────────────────────────────────────────
{"type":"identity","token":"nxbot_v1"}   {"type":"connected","session_id":"s_xxx"}
{"type":"subscribe","channels":["ch1"]}  {"type":"subscribed","channels":["ch1"]}
{"type":"ping"}                          {"type":"pong"}
                                         {"type":"event","event":{...}}
```

Actual frame envelopes are internal to the SDK and not a public API.

## Appendix D: E2E Encryption Constraint

Bots **cannot** interact with end-to-end encrypted channels. This is a hard platform restriction enforced at the routing layer:

- Events from E2E channels never enter the bot dispatch pipeline.
- Slash commands are disabled in E2E channels.
- Bots cannot be added to encrypted channels.
- Any attempt results in error code `e2e_bots_disabled`.

Bots receive the `is_encrypted` flag on `channel_created` and `getChannelInfo()` responses so they can adjust behavior accordingly.
