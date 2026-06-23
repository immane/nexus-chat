---
lang: en
---

# PHP Bot SDK — Developer Reference

> **Package:** `nexus-chat/bot-sdk`  
> **Language:** PHP 8.1+  
> **Transport:** WebSocket (persistent) / Webhook (HTTP callback, Phase 1.5)  
> **Gateway:** `wss://gateway.nexus.chat/bot-ws`  

---

## Table of Contents

1. [Package](#1-package)
2. [Quick Start](#2-quick-start)
3. [API Reference](#3-api-reference)
   - [3.1 Constructor](#31-constructor)
   - [3.2 Event Callbacks](#32-event-callbacks)
   - [3.3 Messaging Methods](#33-messaging-methods)
   - [3.4 Channel Methods](#34-channel-methods)
   - [3.5 Connection Lifecycle](#35-connection-lifecycle)
   - [3.6 Middleware Pipeline](#36-middleware-pipeline)
   - [3.7 Built-in Rate Limiter](#37-built-in-rate-limiter)
4. [Event Classes](#4-event-classes)
5. [Slash Command Registration](#5-slash-command-registration)
6. [Error Handling](#6-error-handling)
7. [Reconnection Strategy](#7-reconnection-strategy)
8. [Bot Manifest](#8-bot-manifest)
9. [Complete Examples](#9-complete-examples)
   - [9.1 EchoBot](#91-echobot)
   - [9.2 PollBot](#92-pollbot)
   - [9.3 Laravel Artisan Command Bot](#93-laravel-artisan-command-bot)
   - [9.4 Symfony Console Bot](#94-symfony-console-bot)
10. [PHP-Specific Notes](#10-php-specific-notes)

---

## 1. Package

### Installation

```bash
composer require nexus-chat/bot-sdk
```

### Requirements

| Dependency | Version | Purpose |
|---|---|---|
| PHP | `>= 8.1` | Enums, readonly properties, fibers, `match` expressions, named arguments |
| `guzzlehttp/guzzle` | `^7.0` | HTTP client for REST API calls (channel info, member lists) |
| `textalk/websocket` | `^1.6` | RFC 6455 WebSocket client for persistent gateway connections |
| `monolog/monolog` | `^3.0` | PSR-3 logging (injectable, defaults to stdout) |

### Extensions

- `ext-json` — required
- `ext-pcntl` — recommended for long-running daemon bots (signal handling)
- `ext-fiber` — required (PHP 8.1+ core) for async helpers

---

## 2. Quick Start

```php
<?php

use NexusChat\Bot\NexusBot;
use NexusChat\Bot\Event\MessageEvent;

require __DIR__ . '/vendor/autoload.php';

$bot = new NexusBot(
    token: 'nxbot_v1_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8',
    gatewayUrl: 'wss://gateway.nexus.chat/bot-ws',
);

$bot->on('message', function (MessageEvent $event) use ($bot): void {
    if ($event->text === '/ping') {
        $bot->sendMessage($event->channelId, 'Pong! 🏓');
    }
});

$bot->connect(); // Blocks the current process
```

### Connection Options at a Glance

```php
// Blocking — the simplest form; call from a CLI script
$bot->connect();

// Async — returns a FiberPromise for use in fiber-based loops
$bot->connectAsync()->await();

// With full reconnection config
$bot->connect(reconnect: [
    'maxRetries'    => 0,    // 0 = infinite
    'initialDelayMs' => 1000,
    'maxDelayMs'    => 30_000,
    'jitter'        => true,
]);
```

---

## 3. API Reference

### 3.1 Constructor

The constructor accepts **PHP 8.1 named arguments**. Every parameter is individually optional beyond `token`.

```php
public function __construct(
    public readonly string $token,
    public readonly string $gatewayUrl = 'wss://gateway.nexus.chat/bot-ws',
    public readonly string $apiBaseUrl  = 'https://api.nexus.chat',
    public readonly ?Psr\Log\LoggerInterface $logger = null,
    public readonly array $reconnectConfig = [
        'maxRetries'     => 10,
        'initialDelayMs' => 1_000,
        'maxDelayMs'     => 30_000,
        'jitter'         => true,
    ],
    public readonly array $rateLimitConfig = [
        'maxPerMinute' => 120,
    ],
) {}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `token` | `string` | *(required)* | Bot token in `nxbot_v1_` format |
| `gatewayUrl` | `string` | `wss://gateway.nexus.chat/bot-ws` | WebSocket gateway endpoint |
| `apiBaseUrl` | `string` | `https://api.nexus.chat` | REST API base URL |
| `logger` | `?LoggerInterface` | Monolog stdout handler | PSR-3 logger instance |
| `reconnectConfig` | `array` | See defaults | Backoff parameters for auto-reconnect |
| `rateLimitConfig` | `array` | `['maxPerMinute' => 120]` | Client-side token bucket capacity |

---

### 3.2 Event Callbacks

Register a handler for any of the 9 supported event types:

```php
$bot->on(string $event, callable $handler): self
```

The `$event` name must be one of:

| Event String | Handler Class |
|---|---|
| `message` | `MessageEvent` |
| `message_edited` | `MessageEditedEvent` |
| `message_deleted` | `MessageDeletedEvent` |
| `channel_created` | `ChannelCreatedEvent` |
| `channel_archived` | `ChannelArchivedEvent` |
| `member_joined` | `MemberJoinedEvent` |
| `member_left` | `MemberLeftEvent` |
| `slash_command` | `SlashCommandEvent` |
| `button_clicked` | `ButtonClickedEvent` |

You may register multiple handlers per event type; they are invoked in registration order.

```php
$bot->on('message', fn(MessageEvent $e) => /* ... */);
$bot->on('message', fn(MessageEvent $e) => /* second handler */);

// Fluent chaining
$bot
    ->on('message', $this->handleMessage(...))
    ->on('channel_created', $this->handleChannelCreated(...))
    ->on('slash_command', $this->handleSlashCommand(...));
```

---

### 3.3 Messaging Methods

#### `sendMessage()`

Send a message to a channel.

```php
public function sendMessage(
    string $channelId,
    string $text,
    ?string $threadId = null,
    ?array $blocks = null,
): Message;
```

| Argument | Type | Description |
|---|---|---|
| `channelId` | `string` | Target channel ID |
| `text` | `string` | Markdown-formatted message body |
| `threadId` | `?string` | Parent message ID for threaded replies |
| `blocks` | `?array` | Layout blocks (future) |

```php
$bot->sendMessage(
    channelId: 'ch_abc123',
    text: 'Hello from the PHP bot!',
);
```

#### `editMessage()`

Update an existing message previously sent by this bot.

```php
public function editMessage(
    string $channelId,
    string $messageId,
    string $text,
): Message;
```

```php
$bot->editMessage(
    channelId: 'ch_abc123',
    messageId: 'msg_xyz789',
    text: 'Updated content.',
);
```

#### `deleteMessage()`

Delete a message previously sent by this bot.

```php
public function deleteMessage(
    string $channelId,
    string $messageId,
): void;
```

#### `sendEphemeral()`

Send a message visible only to a specific user in the channel. Bots cannot read ephemeral messages sent by other bots.

```php
public function sendEphemeral(
    string $channelId,
    string $userId,
    string $text,
): void;
```

```php
$bot->sendEphemeral(
    channelId: 'ch_abc123',
    userId: 'usr_456',
    text: 'This is visible only to you.',
);
```

---

### 3.4 Channel Methods

#### `getChannelInfo()`

Retrieve metadata about a channel the bot is a member of.

```php
public function getChannelInfo(string $channelId): ChannelInfo;
```

```php
$info = $bot->getChannelInfo('ch_abc123');
echo $info->name;   // "general"
echo $info->memberCount; // 42
```

The returned `ChannelInfo` object:

```php
readonly class ChannelInfo {
    public string $id;
    public string $name;
    public string $workspaceId;
    public int $memberCount;
    public bool $isArchived;
    public string $createdAt;   // ISO 8601
}
```

#### `getMemberList()`

Fetch the list of members in a channel. Returns a paginated result set.

```php
public function getMemberList(
    string $channelId,
    int $limit = 100,
    ?string $cursor = null,
): MemberListPage;
```

```php
$page = $bot->getMemberList('ch_abc123', limit: 50);

foreach ($page->members as $member) {
    echo $member->userId . ': ' . $member->displayName . PHP_EOL;
}

// Paginate
while ($page->hasMore) {
    $page = $bot->getMemberList('ch_abc123', cursor: $page->nextCursor);
}
```

---

### 3.5 Connection Lifecycle

```
CONNECTING → AUTHENTICATING → SUBSCRIBING → ACTIVE
                                  ↓
                            DISCONNECTED → (auto-reconnect) → CONNECTING
```

#### `connect()`

Open a persistent WebSocket connection. **Blocks the calling thread** until the socket closes or the process receives a termination signal.

```php
public function connect(?array $reconnect = null): void;
```

Pass `$reconnect` to override the constructor-level reconnect config for this invocation:

```php
$bot->connect(reconnect: ['maxRetries' => 0]); // never give up
```

#### `connectAsync()`

Returns a `FiberPromise` that resolves when the connection is established and event processing begins. The underlying event loop runs in a separate Fiber, allowing the caller to perform other work.

```php
public function connectAsync(): FiberPromise;
```

```php
$promise = $bot->connectAsync();

// Do other setup...
$promise->await(); // block here until the bot finishes
```

> **Note:** `FiberPromise` is a lightweight SDK-internal implementation, not an HTTP library promise. It is compatible with fiber-based cooperative multitasking.

#### `disconnect()`

Gracefully close the WebSocket. The bot will **not** attempt to reconnect after an explicit `disconnect()`.

```php
public function disconnect(int $code = 1000, string $reason = ''): void;
```

#### `isConnected()`

```php
public function isConnected(): bool;
```

Returns `true` when the connection state is `ACTIVE`.

---

### 3.6 Middleware Pipeline

Middleware wraps every outgoing API call. Common uses: logging, custom retry, metrics collection.

```php
$bot->use(callable $middleware): self;
```

The middleware signature is:

```php
use NexusChat\Bot\Middleware\CallContext;

/**
 * @param CallContext          $ctx     Method name, arguments, metadata
 * @param callable(CallContext): mixed $next  The next handler in the chain
 * @return mixed
 */
function (CallContext $ctx, callable $next): mixed;
```

```php
use NexusChat\Bot\Middleware\CallContext;

// Log every outgoing API call
$bot->use(function (CallContext $ctx, callable $next): mixed {
    $bot->getLogger()->info('API call', [
        'method' => $ctx->method,
        'args'   => $ctx->args,
    ]);

    return $next($ctx);
});

// Rate-limit guard (built-in runs first; this is additional)
$bot->use(function (CallContext $ctx, callable $next): mixed {
    if ($ctx->method === 'chat.sendMessage' && strlen($ctx->args['text'] ?? '') > 4000) {
        throw new \InvalidArgumentException('Message text exceeds 4000 characters');
    }

    return $next($ctx);
});
```

`CallContext` is a simple value object:

```php
readonly class CallContext {
    public string $method;       // e.g. "chat.sendMessage"
    public array  $args;         // Key-value arguments
    public array  $metadata;     // Extra context (botId, workspaceId, etc.)
}
```

Middleware is invoked in registration order, followed by the actual API transport. This is a standard onion/stack pattern.

---

### 3.7 Built-in Rate Limiter

The SDK enforces a **token bucket** rate limiter client-side. It smooths bursts and respects `Retry-After` headers returned with `429 Too Many Requests`.

#### How It Works

1. On construction, the bucket is filled to `maxPerMinute` tokens.
2. Before every API call, a token is consumed. If no tokens are available, the call sleeps until the next token refills.
3. If the server returns `429`, the SDK reads the `Retry-After` header and globally pauses **all** outgoing calls for that duration.

```php
// Default: 120 requests per minute
$bot = new NexusBot(token: '...', rateLimitConfig: [
    'maxPerMinute' => 120,
]);

// Aggressive bot: bump to 300 (subject to workspace limits)
$bot = new NexusBot(token: '...', rateLimitConfig: [
    'maxPerMinute' => 300,
]);
```

The limiter is per-bot-instance. If you need workspace-wide coordination across multiple processes, implement a custom limiter via Redis-backed middleware.

```php
$bot->use(function (CallContext $ctx, callable $next): mixed {
    // Custom Redis-backed distributed rate limiter
    $limiter = new \Your\RedisRateLimiter($redis, 'bot:mybot', 120);
    $limiter->wait();

    return $next($ctx);
});
```

---

## 4. Event Classes

Every event object uses **PHP 8.1 promoted readonly properties**. Properties are typed and immutable after construction.

### `MessageEvent`

Received when a user sends a message in a subscribed channel.

```php
readonly class MessageEvent {
    public string $id;
    public string $channelId;       // ch_xxx
    public string $userId;          // usr_xxx
    public string $workspaceId;     // ws_xxx
    public string $text;            // Markdown body
    public ?string $threadId;       // null unless in a thread
    public array  $mentions;        // ["usr_111", "usr_222"]
    public array  $attachments;     // [Attachment, ...]
    public string $timestamp;       // ISO 8601
    public string $idempotencyKey;  // Deduplication key
}

readonly class Attachment {
    public string $id;
    public string $filename;
    public string $mimeType;
    public int $sizeBytes;
    public string $url;
}
```

### `MessageEditedEvent`

```php
readonly class MessageEditedEvent {
    public string $channelId;
    public string $messageId;
    public string $userId;
    public string $oldText;
    public string $newText;
    public string $timestamp;
    public string $idempotencyKey;
}
```

### `MessageDeletedEvent`

```php
readonly class MessageDeletedEvent {
    public string $channelId;
    public string $messageId;
    public string $userId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

### `ChannelCreatedEvent`

```php
readonly class ChannelCreatedEvent {
    public string $channelId;
    public string $name;
    public string $createdBy;       // userId
    public string $workspaceId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

### `ChannelArchivedEvent`

```php
readonly class ChannelArchivedEvent {
    public string $channelId;
    public string $archivedBy;      // userId
    public string $workspaceId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

### `MemberJoinedEvent`

```php
readonly class MemberJoinedEvent {
    public string $channelId;
    public string $userId;
    public string $workspaceId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

### `MemberLeftEvent`

```php
readonly class MemberLeftEvent {
    public string $channelId;
    public string $userId;
    public string $workspaceId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

### `SlashCommandEvent`

Dispatched when a user invokes a slash command targeting this bot (e.g., `/poll "Lunch?" "Pizza" "Sushi"`).

```php
readonly class SlashCommandEvent {
    public string $command;         // "poll"
    public array  $args;            // ["Lunch?", "Pizza", "Sushi"]
    public string $triggerId;       // Unique trigger ID (valid for 3 s)
    public string $userId;          // The user who invoked the command
    public string $channelId;
    public string $workspaceId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

The server parses arguments respecting quoted strings:

```
/poll "Best language?" "PHP" "Rust" "TypeScript"
  → command = "poll"
  → args    = ["Best language?", "PHP", "Rust", "TypeScript"]
```

### `ButtonClickedEvent`

```php
readonly class ButtonClickedEvent {
    public string $actionId;        // Developer-defined action identifier
    public string $value;           // Value attached to the button
    public string $messageId;       // Message containing the button
    public string $userId;
    public string $channelId;
    public string $workspaceId;
    public string $timestamp;
    public string $idempotencyKey;
}
```

---

## 5. Slash Command Registration

### Manifest Format (PHP Array)

Commands are declared in the bot manifest — either as a PHP associative array or loaded from a JSON file. The SDK validates the structure on registration.

```php
$manifest = [
    'name'        => 'pollbot',
    'description' => 'Create quick polls in any channel.',
    'commands'    => [
        [
            'name'        => 'poll',
            'description' => 'Create a poll with options',
            'usage'       => '/poll "Question" "Option A" "Option B" [...]',
            'args'        => [
                ['name' => 'question', 'description' => 'The poll question', 'required' => true, 'type' => 'string'],
                ['name' => 'options',  'description' => 'Poll options (2 or more)', 'required' => true, 'type' => 'string'],
            ],
        ],
        [
            'name'        => 'poll_results',
            'description' => 'Show results of the last poll',
            'usage'       => '/poll_results',
        ],
    ],
    'scopes'       => ['messages:read', 'messages:write', 'commands'],
    'iconUrl'      => 'https://example.com/pollbot-icon.png',
];
```

### Validation Rules

| Field | Constraint |
|---|---|
| `name` | 1–50 characters |
| `description` | Max 500 characters |
| `commands[].name` | 1–32 characters, lowercase, regex `/^[a-z][a-z0-9_-]*$/` |
| `commands[].description` | Max 100 characters |
| `commands[].usage` | Max 200 characters (optional) |
| `commands[].args[].type` | One of `string`, `number`, `user`, `channel` (enum) |
| Max commands | 50 per bot |

### Registering via SDK

```php
use NexusChat\Bot\Manifest\BotManifest;

$manifest = BotManifest::fromArray($manifestArray);
// or from JSON:
$manifest = BotManifest::fromJsonFile(__DIR__ . '/manifest.json');

$bot->setManifest($manifest);
$bot->connect();
```

The SDK sends the manifest as part of the WebSocket handshake identity payload. The server validates and registers the commands on behalf of the bot.

### Command Dispatch Flow (Server-Side)

```
User types: /pollbot poll "Best DB?" "PostgreSQL" "MySQL"
      ↓
Parser extracts: botName=pollbot, command=poll, args=["Best DB?", "PostgreSQL", "MySQL"]
      ↓
Look up bot + verify channel membership + verify command in manifest
      ↓
Enqueue SlashCommandEvent for the bot (3 s trigger_id window)
      ↓
Bot SDK receives SlashCommandEvent → handler runs
```

---

## 6. Error Handling

### Exception Hierarchy

```
\RuntimeException
 └── NexusBot\Exception\NexusBotException (base)
      ├── AuthenticationException
      ├── RateLimitException
      ├── ConnectionException
      │    ├── ConnectionTimeoutException
      │    └── ConnectionClosedException
      ├── PermissionException
      └── ApiException
```

| Exception | Thrown When |
|---|---|
| `NexusBotException` | Base for all SDK exceptions |
| `AuthenticationException` | Invalid token, expired token, wrong workspace |
| `RateLimitException` | Server `429` beyond SDK retry budget; includes `retryAfterMs` |
| `ConnectionException` | WebSocket-level failure (timeout, refused, protocol error) |
| `ConnectionTimeoutException` | Handshake not completed within 10 s |
| `ConnectionClosedException` | Server closed connection with non-recoverable code |
| `PermissionException` | Bot lacks required scope for the attempted action |
| `ApiException` | Generic API error; includes `statusCode` and `errorCode` |

### Handling Examples

```php
use NexusChat\Bot\Exception\{
    AuthenticationException,
    RateLimitException,
    ConnectionException,
    PermissionException,
    ApiException,
};

try {
    $bot->connect();
} catch (AuthenticationException $e) {
    echo 'Invalid token: ' . $e->getMessage() . PHP_EOL;
    exit(1);
} catch (ConnectionException $e) {
    echo 'Cannot reach gateway: ' . $e->getMessage() . PHP_EOL;
    // Will auto-retry if reconnection is enabled
}
```

In event handlers, wrap API calls defensively:

```php
$bot->on('message', function (MessageEvent $event) use ($bot): void {
    try {
        $bot->sendMessage($event->channelId, 'Processing...');
    } catch (RateLimitException $e) {
        // The SDK already backs off; this is optional logging
        $bot->getLogger()->warning('Rate limited', [
            'retryAfterMs' => $e->retryAfterMs,
        ]);
    } catch (PermissionException $e) {
        $bot->getLogger()->error('Missing scope', ['scope' => $e->requiredScope]);
    }
});
```

### `ApiException` Details

```php
readonly class ApiException extends NexusBotException {
    public int    $statusCode;
    public string $errorCode;    // e.g. "e2e_bots_disabled", "channel_not_found"
    public ?array $details;      // Server-provided extra context
}
```

---

## 7. Reconnection Strategy

The SDK's `ReconnectManager` implements **exponential backoff with jitter**, matching the TypeScript SDK's behavior. It is active for all unexpected disconnections; explicit `disconnect()` calls suppress it.

### Algorithm

```
attempt 1: delay = min(1000 * 2^0, 30000) * jitter = 1000 * rand(0.5, 1.0)  ms
attempt 2: delay = min(1000 * 2^1, 30000) * jitter = 2000 * rand(0.5, 1.0)  ms
attempt 3: delay = min(1000 * 2^2, 30000) * jitter = 4000 * rand(0.5, 1.0)  ms
attempt 4: delay = min(1000 * 2^3, 30000) * jitter = 8000 * rand(0.5, 1.0)  ms
attempt 5: delay = min(1000 * 2^4, 30000) * jitter = 16000 * rand(0.5, 1.0)  ms
...
attempt N: delay = min(1000 * 2^(N-1), 30000) * jitter, capped at 30 s
```

On successful connection → `attempt` counter resets to 0.

### Configuration

```php
// Infinite retries (default: 10)
$bot = new NexusBot(
    token: '...',
    reconnectConfig: [
        'maxRetries'     => 0,      // 0 = retry forever
        'initialDelayMs' => 1_000,
        'maxDelayMs'     => 30_000,
        'jitter'         => true,
    ],
);

// No auto-reconnect at all
$bot = new NexusBot(
    token: '...',
    reconnectConfig: ['maxRetries' => 1], // Try once, then give up
);
```

### Reconnection Events

The SDK emits internal debug logs during reconnection. You can hook into the process via middleware or subclassing.

```php
$bot->on('_internal.reconnecting', function (array $data) {
    // Not part of the public event API — used by observability middleware
    echo sprintf(
        "Reconnecting: attempt %d / %s\n",
        $data['attempt'],
        $data['maxRetries'] === 0 ? '∞' : $data['maxRetries'],
    );
});
```

---

## 8. Bot Manifest

The bot manifest is the canonical declaration of the bot's identity, capabilities, and requirements. It is sent to the server during the WebSocket handshake identity phase.

### Full Manifest Schema

```php
readonly class BotManifest {
    public string $name;             // 1-50 chars, workspace-unique
    public string $description;      // max 500 chars
    /** @var BotCommand[] */
    public array  $commands;         // max 50
    /** @var string[] */
    public array  $scopes;           // Permission scopes required
    public string $connectionMode;   // "websocket" | "webhook"
    public ?string $webhookUrl;      // Required for webhook mode
    public ?string $iconUrl;         // Public URL to bot avatar image
}

readonly class BotCommand {
    public string $name;             // "poll"
    public string $description;      // "Create a poll with options"
    public ?string $usage;           // "/poll <question> <options...>"
    /** @var CommandArg[] */
    public ?array $args;
}

readonly class CommandArg {
    public string $name;
    public string $description;
    public bool   $required;
    public string $type;             // "string" | "number" | "user" | "channel"
}
```

### Available Permission Scopes

| Scope | Enables |
|---|---|
| `messages:read` | Receive `message`, `message_edited`, `message_deleted` events |
| `messages:write` | `sendMessage`, `editMessage`, `sendEphemeral` |
| `channels:read` | `getChannelInfo` |
| `channels:manage` | Create / archive channels (future) |
| `members:read` | `getMemberList`, `member_joined`, `member_left` events |
| `commands` | Respond to slash commands |
| `interactions` | Receive `button_clicked` events |
| `files:read` | Read file metadata and URLs in subscribed channels (future) |
| `files:write` | Upload files to channels (future) |

### Programmatic Manifest Construction

```php
use NexusChat\Bot\Manifest\BotManifest;
use NexusChat\Bot\Manifest\BotCommand;
use NexusChat\Bot\Manifest\CommandArg;

$manifest = new BotManifest(
    name: 'ci-bot',
    description: 'CI/CD notifications and deployment commands.',
    commands: [
        new BotCommand(
            name: 'deploy',
            description: 'Trigger a deployment pipeline',
            usage: '/deploy <service> <environment>',
            args: [
                new CommandArg(name: 'service', description: 'Service to deploy', required: true, type: 'string'),
                new CommandArg(name: 'environment', description: 'Target environment', required: true, type: 'string'),
            ],
        ),
        new BotCommand(
            name: 'status',
            description: 'Show current deployment status',
        ),
    ],
    scopes: ['messages:read', 'messages:write', 'commands'],
    connectionMode: 'websocket',
    iconUrl: 'https://ci.example.com/bot-avatar.png',
);

$bot->setManifest($manifest);
```

### JSON Manifest File

```json
{
    "name": "ci-bot",
    "description": "CI/CD notifications and deployment commands.",
    "commands": [
        {
            "name": "deploy",
            "description": "Trigger a deployment pipeline",
            "usage": "/deploy <service> <environment>",
            "args": [
                { "name": "service", "description": "Service to deploy", "required": true, "type": "string" },
                { "name": "environment", "description": "Target environment", "required": true, "type": "string" }
            ]
        },
        {
            "name": "status",
            "description": "Show current deployment status"
        }
    ],
    "scopes": ["messages:read", "messages:write", "commands"],
    "connectionMode": "websocket",
    "iconUrl": "https://ci.example.com/bot-avatar.png"
}
```

Load via:

```php
$manifest = BotManifest::fromJsonFile(__DIR__ . '/ci-bot-manifest.json');
```

---

## 9. Complete Examples

### 9.1 EchoBot

A minimal bot that echoes every message. Demonstrates the core event loop.

```php
<?php
// echobot.php

declare(strict_types=1);

use NexusChat\Bot\NexusBot;
use NexusChat\Bot\Event\MessageEvent;

require __DIR__ . '/vendor/autoload.php';

$bot = new NexusBot(
    token: getenv('NEXUS_BOT_TOKEN') ?: throw new \RuntimeException('NEXUS_BOT_TOKEN not set'),
);

$bot->on('message', function (MessageEvent $event) use ($bot): void {
    // Don't echo messages from other bots
    if ($event->userId === $bot->getBotUserId()) {
        return;
    }

    $reply = sprintf('You said: %s', $event->text);
    $bot->sendMessage($event->channelId, $reply);
});

$bot->on('channel_created', function () use ($bot): void {
    $bot->getLogger()->info('EchoBot was added to a new channel');
});

$bot->connect();
```

Run:

```bash
NEXUS_BOT_TOKEN=nxbot_v1_xxxx php echobot.php
```

---

### 9.2 PollBot

A slash-command bot that creates interactive polls. Demonstrates command parsing, message blocks, and handler de-duplication.

```php
<?php
// pollbot.php

declare(strict_types=1);

use NexusChat\Bot\NexusBot;
use NexusChat\Bot\Event\{MessageEvent, SlashCommandEvent, ButtonClickedEvent};
use NexusChat\Bot\Manifest\{BotManifest, BotCommand, CommandArg};

require __DIR__ . '/vendor/autoload.php';

// In-memory poll storage (use Redis / DB in production)
$polls = [];

$bot = new NexusBot(token: getenv('NEXUS_BOT_TOKEN'));

// ── Manifest ──────────────────────────────────────
$manifest = new BotManifest(
    name: 'pollbot',
    description: 'Create quick polls in any channel.',
    commands: [
        new BotCommand(
            name: 'poll',
            description: 'Create a poll',
            usage: '/poll "Question" "Option A" "Option B" [...]',
            args: [
                new CommandArg(name: 'question', description: 'The question', required: true, type: 'string'),
            ],
        ),
    ],
    scopes: ['messages:read', 'messages:write', 'commands', 'interactions'],
    connectionMode: 'websocket',
);
$bot->setManifest($manifest);

// ── Slash command handler ─────────────────────────
$bot->on('slash_command', function (SlashCommandEvent $event) use ($bot, &$polls): void {
    match ($event->command) {
        'poll' => handlePollCreate($event, $bot, $polls),
        default => $bot->sendEphemeral($event->channelId, $event->userId, "Unknown command: {$event->command}"),
    };
});

function handlePollCreate(SlashCommandEvent $event, NexusBot $bot, array &$polls): void {
    if (count($event->args) < 3) {
        $bot->sendEphemeral(
            $event->channelId,
            $event->userId,
            'Usage: /poll "Question" "Option A" "Option B" [...]',
        );
        return;
    }

    $question = $event->args[0];
    $options  = array_slice($event->args, 1);

    if (count($options) < 2) {
        $bot->sendEphemeral($event->channelId, $event->userId, 'Provide at least 2 options.');
        return;
    }

    $pollId = uniqid('poll_', more_entropy: true);
    $polls[$pollId] = array_fill_keys($options, 0);

    $text = sprintf("*%s*\n\n", $question);
    foreach ($options as $i => $opt) {
        $text .= sprintf("%d. %s (0)\n", $i + 1, $opt);
    }

    $message = $bot->sendMessage($event->channelId, $text);

    $bot->sendEphemeral($event->channelId, $event->userId, 'Poll created!');
}

// ── Message handler: vote by number ───────────────
$bot->on('message', function (MessageEvent $event) use ($bot, &$polls): void {
    // Only process messages that look like poll votes in threads
    // (Simplified — a real implementation would track poll messages)
});

$bot->connect();
```

---

### 9.3 Laravel Artisan Command Bot

Embed a nexus-chat bot inside a Laravel application as an Artisan command. This pattern is ideal for bots that need access to Eloquent models, the service container, queues, or application logic.

```php
<?php
// app/Console/Commands/NexusBotServe.php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use NexusChat\Bot\NexusBot;
use NexusChat\Bot\Event\MessageEvent;
use NexusChat\Bot\Event\SlashCommandEvent;
use NexusChat\Bot\Manifest\{BotManifest, BotCommand, CommandArg};
use App\Models\Order;
use Monolog\Logger;
use Monolog\Handler\StreamHandler;

class NexusBotServe extends Command
{
    protected $signature = 'nexus:bot-serve';
    protected $description = 'Start the nexus-chat bot WebSocket client';

    public function handle(): int
    {
        $logger = new Logger('nexus-bot');
        $logger->pushHandler(new StreamHandler(storage_path('logs/nexus-bot.log')));

        $bot = new NexusBot(
            token: config('services.nexus.bot_token'),
            logger: $logger,
        );

        // ── Manifest ───────────────────────────────
        $bot->setManifest(new BotManifest(
            name: 'shopkeeper',
            description: 'Order management and inventory queries.',
            commands: [
                new BotCommand(
                    name: 'orders',
                    description: 'List recent orders',
                    args: [
                        new CommandArg(name: 'status', description: 'Filter by status', required: false, type: 'string'),
                    ],
                ),
                new BotCommand(
                    name: 'order',
                    description: 'Show details for a specific order',
                    usage: '/order <order_id>',
                    args: [
                        new CommandArg(name: 'order_id', description: 'Order ID', required: true, type: 'number'),
                    ],
                ),
            ],
            scopes: ['messages:read', 'messages:write', 'commands'],
            connectionMode: 'websocket',
        ));

        // ── Slash command handlers ─────────────────
        $bot->on('slash_command', function (SlashCommandEvent $event) use ($bot): void {
            match ($event->command) {
                'orders' => $this->handleOrders($bot, $event),
                'order'  => $this->handleOrderDetail($bot, $event),
                default  => $bot->sendEphemeral($event->channelId, $event->userId, "Unknown: {$event->command}"),
            };
        });

        // ── Health check ───────────────────────────
        $bot->on('message', function (MessageEvent $event) use ($bot): void {
            if (trim($event->text) === '/health') {
                $info = [
                    'Status'    => 'healthy',
                    'Laravel'   => app()->version(),
                    'PHP'       => PHP_VERSION,
                    'Memory'    => round(memory_get_usage(true) / 1024 / 1024, 1) . ' MB',
                    'Uptime'    => $this->getUptime(),
                ];

                $lines = [];
                foreach ($info as $key => $val) {
                    $lines[] = sprintf('• *%s:* %s', $key, $val);
                }

                $bot->sendMessage($event->channelId, implode("\n", $lines));
            }
        });

        $this->info('Starting nexus-chat bot...');
        $bot->connect();

        return self::SUCCESS;
    }

    private function handleOrders(NexusBot $bot, SlashCommandEvent $event): void
    {
        $status = $event->args[0] ?? null;

        $query = Order::query()->latest()->limit(10);
        if ($status) {
            $query->where('status', $status);
        }

        $orders = $query->get();

        if ($orders->isEmpty()) {
            $bot->sendMessage($event->channelId, 'No orders found.');
            return;
        }

        $lines = ["*Recent Orders*\n"];
        foreach ($orders as $order) {
            $lines[] = sprintf(
                '#%s — %s — $%.2f — %s',
                $order->id,
                $order->customer_name,
                $order->total / 100,
                $order->status,
            );
        }

        $bot->sendMessage($event->channelId, implode("\n", $lines));
    }

    private function handleOrderDetail(NexusBot $bot, SlashCommandEvent $event): void
    {
        $orderId = (int) ($event->args[0] ?? 0);
        $order = Order::find($orderId);

        if (!$order) {
            $bot->sendEphemeral($event->channelId, $event->userId, "Order #{$orderId} not found.");
            return;
        }

        $detail = <<<MD
*Order #{$order->id}*
• Customer: {$order->customer_name}
• Status: {$order->status}
• Total: \${$order->total}
• Placed: {$order->created_at->toIso8601String()}
MD;

        $bot->sendMessage($event->channelId, $detail);
    }

    private function getUptime(): string
    {
        $start = $_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true);
        $seconds = (int) (microtime(true) - $start);
        $hours = floor($seconds / 3600);
        $mins = floor(($seconds % 3600) / 60);

        return "{$hours}h {$mins}m";
    }
}
```

Register in `routes/console.php` or `Kernel.php` and run:

```bash
php artisan nexus:bot-serve
```

For production, use **Supervisor** (see [Section 10](#10-php-specific-notes)).

---

### 9.4 Symfony Console Bot

The same pattern adapted for a Symfony Console application.

```php
<?php
// src/Command/NexusBotCommand.php

declare(strict_types=1);

namespace App\Command;

use Symfony\Component\Console\Command\Command;
use Symfony\Component\Console\Input\InputInterface;
use Symfony\Component\Console\Output\OutputInterface;
use NexusChat\Bot\NexusBot;
use NexusChat\Bot\Event\{MessageEvent, SlashCommandEvent};
use NexusChat\Bot\Manifest\{BotManifest, BotCommand, CommandArg};
use App\Service\DeployService;
use Monolog\Logger;
use Monolog\Handler\StreamHandler;
use Monolog\Handler\ConsoleHandler;

class NexusBotCommand extends Command
{
    protected static $defaultName = 'nexus:bot';
    protected static $defaultDescription = 'Start the nexus-chat bot';

    public function __construct(
        private readonly DeployService $deployService,
    ) {
        parent::__construct();
    }

    protected function execute(InputInterface $input, OutputInterface $output): int
    {
        $logger = new Logger('nexus-bot');
        $logger->pushHandler(new ConsoleHandler($output));
        $logger->pushHandler(new StreamHandler('var/log/nexus-bot.log'));

        $bot = new NexusBot(
            token: $_ENV['NEXUS_BOT_TOKEN'],
            logger: $logger,
        );

        // ── Manifest ───────────────────────────────
        $bot->setManifest(new BotManifest(
            name: 'deployer',
            description: 'Deploy services from chat.',
            commands: [
                new BotCommand(
                    name: 'deploy',
                    description: 'Deploy a service to an environment',
                    usage: '/deploy <service> <environment>',
                    args: [
                        new CommandArg(name: 'service', description: 'Service name', required: true, type: 'string'),
                        new CommandArg(name: 'env', description: 'staging | production', required: true, type: 'string'),
                    ],
                ),
                new BotCommand(
                    name: 'rollback',
                    description: 'Rollback the last deployment',
                    usage: '/rollback <service>',
                    args: [
                        new CommandArg(name: 'service', description: 'Service to rollback', required: true, type: 'string'),
                    ],
                ),
            ],
            scopes: ['messages:read', 'messages:write', 'commands'],
            connectionMode: 'websocket',
        ));

        // ── Slash commands ─────────────────────────
        $bot->on('slash_command', function (SlashCommandEvent $event) use ($bot): void {
            match ($event->command) {
                'deploy'   => $this->handleDeploy($bot, $event),
                'rollback' => $this->handleRollback($bot, $event),
                default    => null,
            };
        });

        $output->writeln('<info>Bot starting on ' . $bot->gatewayUrl . '</info>');

        $bot->connect();

        return Command::SUCCESS;
    }

    private function handleDeploy(NexusBot $bot, SlashCommandEvent $event): void
    {
        if (count($event->args) < 2) {
            $bot->sendEphemeral($event->channelId, $event->userId, 'Usage: /deploy <service> <env>');
            return;
        }

        [$service, $env] = $event->args;

        $validEnvs = ['staging', 'production'];
        if (!in_array($env, $validEnvs, strict: true)) {
            $bot->sendEphemeral($event->channelId, $event->userId, 'Environment must be: staging, production');
            return;
        }

        $bot->sendMessage($event->channelId, sprintf('Deploying *%s* to *%s*...', $service, $env));

        try {
            $this->deployService->deploy($service, $env);
            $bot->sendMessage($event->channelId, sprintf('Deployment of *%s* to *%s* complete.', $service, $env));
        } catch (\Throwable $e) {
            $bot->sendMessage($event->channelId, sprintf('Deployment failed: %s', $e->getMessage()));
        }
    }

    private function handleRollback(NexusBot $bot, SlashCommandEvent $event): void
    {
        $service = $event->args[0] ?? null;
        if (!$service) {
            $bot->sendEphemeral($event->channelId, $event->userId, 'Usage: /rollback <service>');
            return;
        }

        $bot->sendMessage($event->channelId, sprintf('Rolling back *%s*...', $service));

        try {
            $this->deployService->rollback($service);
            $bot->sendMessage($event->channelId, sprintf('Rollback of *%s* complete.', $service));
        } catch (\Throwable $e) {
            $bot->sendMessage($event->channelId, sprintf('Rollback failed: %s', $e->getMessage()));
        }
    }
}
```

Run:

```bash
php bin/console nexus:bot
```

---

## 10. PHP-Specific Notes

### 10.1 Process Model

PHP is traditionally request-response. Running a persistent WebSocket client means your process will be long-lived. Plan for this:

- Use a **process supervisor** (systemd, Supervisor, Docker restart policy).
- The `connect()` method blocks indefinitely by design. Put cleanup logic in `register_shutdown_function()` or signal handlers.
- Memory: PHP's garbage collector runs periodically, but be mindful of accumulating state in global/static variables.

### 10.2 Signal Handling with `pcntl`

For graceful shutdown in long-running CLI scripts, register signal handlers **before** calling `connect()`:

```php
declare(ticks = 1);

$running = true;

pcntl_signal(SIGINT, function () use (&$running, $bot): void {
    echo "\nShutting down...\n";
    $running = false;
    $bot->disconnect();
});

pcntl_signal(SIGTERM, function () use (&$running, $bot): void {
    $running = false;
    $bot->disconnect();
});

$bot->connect();
```

If `ext-pcntl` is not available (e.g., Windows), the bot will still run but cannot handle signals. For Windows, use a wrapper like:

```php
if (!extension_loaded('pcntl')) {
    echo "Warning: pcntl not loaded. Use Ctrl+Break to stop.\n";
}
```

### 10.3 Memory and Long-Running Scripts

PHP's memory model means long-running daemons need attention:

```php
// Periodically report memory usage (optional)
$bot->on('message', function (MessageEvent $event) use ($bot): void {
    // Core logic...

    // Aggressive GC every 1000 messages
    static $counter = 0;
    if (++$counter % 1000 === 0) {
        gc_collect_cycles();
        $bot->getLogger()->debug('GC triggered', [
            'memory_mb' => round(memory_get_usage(true) / 1024 / 1024, 1),
        ]);
    }
});
```

**Recommendations**:

| Concern | Mitigation |
|---|---|
| Memory leaks in event handlers | Avoid global state; use dependency injection; call `gc_collect_cycles()` periodically |
| Accumulating log buffer | Use Monolog stream handlers, not in-memory buffers |
| Stale connections | The SDK auto-reconnects; trust the `ReconnectManager` |
| CPU-bound handlers | Offload heavy work to a job queue (Laravel Queue, Symfony Messenger); respond within 3 s for slash commands |
| Multiple bot instances | Use distributed coordination (Redis locks) to avoid duplicate processing if running >1 replica |

### 10.4 Supervisor Configuration

Example `supervisord.conf` section:

```ini
[program:nexus-chat-bot]
command=php /var/www/nexus-bot/echobot.php
directory=/var/www/nexus-bot
user=www-data
autostart=true
autorestart=true
startretries=5
stdout_logfile=/var/log/nexus-bot.stdout.log
stderr_logfile=/var/log/nexus-bot.stderr.log
environment=NEXUS_BOT_TOKEN="nxbot_v1_xxxx"
```

### 10.5 Docker / Containerization

```dockerfile
FROM php:8.2-cli

RUN apt-get update && apt-get install -y \
    libzip-dev \
    && docker-php-ext-install pcntl

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
COPY . /app
WORKDIR /app
RUN composer install --no-dev --optimize-autoloader

CMD ["php", "echobot.php"]
```

### 10.6 E2E Encryption Constraint

Bots **cannot** access end-to-end encrypted channels. The nexus-chat server skips bot dispatch entirely for encrypted channels. Your bot will never receive events from, and can never be added to, an E2E channel. If you attempt `getChannelInfo()` on an E2E channel, the server returns a `PermissionException` with error code `e2e_bots_disabled`.

### 10.7 Request Correlation

Every event carries an `idempotencyKey` of the form `{messageId}:{eventType}` (e.g., `msg_abc123:message.created`). The server guarantees at-least-once delivery; your handler **should be idempotent**. Use the key for deduplication if your handler has side effects:

```php
$bot->on('slash_command', function (SlashCommandEvent $event) use ($bot, $redis): void {
    $key = 'processed:' . $event->idempotencyKey;

    if (!$redis->set($key, '1', ['NX', 'EX' => 3600])) {
        // Already processed — skip
        return;
    }

    // Process the command...
});
```

### 10.8 Rate Limit Headers on `429`

When the server returns `429 Too Many Requests`, the SDK reads the `Retry-After` header (seconds) and pauses all API calls globally. During this pause, new API calls are queued and resume after the window expires. No exceptions are thrown unless the pause exceeds the SDK's retry budget (configurable via `rateLimitConfig`).

### 10.9 Logging

The logger is injectable and defaults to Monolog with a `StreamHandler` writing to `php://stdout` at `INFO` level. Customize:

```php
use Monolog\Logger;
use Monolog\Handler\RotatingFileHandler;
use Monolog\Processor\MemoryUsageProcessor;

$logger = new Logger('nexus-bot');
$logger->pushHandler(new RotatingFileHandler('/var/log/nexus-bot.log', maxFiles: 7, level: Logger::DEBUG));
$logger->pushProcessor(new MemoryUsageProcessor());

$bot = new NexusBot(token: '...', logger: $logger);
```

### 10.10 Enum-Based Event Dispatch

Internally, the SDK uses a PHP 8.1 backed enum for event type routing:

```php
namespace NexusChat\Bot\Event;

enum EventType: string {
    case Message        = 'message';
    case MessageEdited  = 'message_edited';
    case MessageDeleted = 'message_deleted';
    case ChannelCreated = 'channel_created';
    case ChannelArchived = 'channel_archived';
    case MemberJoined   = 'member_joined';
    case MemberLeft     = 'member_left';
    case SlashCommand   = 'slash_command';
    case ButtonClicked  = 'button_clicked';
}
```

Match expressions are used throughout for exhaustive dispatch:

```php
$class = match (EventType::from($eventName)) {
    EventType::Message        => MessageEvent::class,
    EventType::MessageEdited  => MessageEditedEvent::class,
    EventType::MessageDeleted => MessageDeletedEvent::class,
    EventType::ChannelCreated => ChannelCreatedEvent::class,
    EventType::ChannelArchived => ChannelArchivedEvent::class,
    EventType::MemberJoined   => MemberJoinedEvent::class,
    EventType::MemberLeft     => MemberLeftEvent::class,
    EventType::SlashCommand   => SlashCommandEvent::class,
    EventType::ButtonClicked  => ButtonClickedEvent::class,
};
```

### 10.11 Webhook Mode (Phase 1.5)

For bots that prefer HTTP callbacks over persistent WebSocket connections:

```php
$bot = new NexusBot(
    token: '...',
    connectionMode: 'webhook',
    webhookUrl: 'https://mybot.example.com/nexus-webhook',
);

// Verify incoming webhook signatures
use NexusChat\Bot\Webhook\SignatureVerifier;

$verifier = new SignatureVerifier($bot->token);
$isValid = $verifier->verify(
    body: file_get_contents('php://input'),
    signatureHeader: $_SERVER['HTTP_X_NEXUS_SIGNATURE'] ?? '',
);
```

The webhook payload is a signed JWT in the request body. Headers:

| Header | Value |
|---|---|
| `X-Nexus-Signature` | `t=1719000000,v1=hex_hmac_signature` |
| `X-Nexus-Event` | Event type string (e.g., `message.created`) |
| `X-Nexus-Delivery` | Unique delivery ID for deduplication |
| `X-Nexus-Retry` | Retry attempt number (0-indexed) |

---

> **Related Documents:**
> - [Async Bot Engine & Event Dispatch Layer — Design Document](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)
> - [Bot Engine & Microservices — Research Report](../research/bot-engine-microservices.md)
