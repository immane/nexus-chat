---
lang: en
---

# Nexus Bot SDK for Python

> **Package**: `nexus-bot-sdk`  
> **Python**: 3.10+  
> **Dependencies**: `websockets`, `aiohttp`, `pydantic` (v2)  
> **Repository**: `https://github.com/nexus-chat/nexus-chat`  
> **Design Reference**: [Async Bot Engine & Event Dispatch Layer](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)

---

## Table of Contents

1. [Installation](#1-installation)
2. [Quick Start](#2-quick-start)
3. [Constructor & Configuration](#3-constructor--configuration)
4. [Event System](#4-event-system)
5. [Event Models (Pydantic v2)](#5-event-models-pydantic-v2)
6. [API Methods](#6-api-methods)
7. [Connection Lifecycle](#7-connection-lifecycle)
8. [Middleware Pipeline](#8-middleware-pipeline)
9. [Rate Limiter](#9-rate-limiter)
10. [Reconnection Strategy](#10-reconnection-strategy)
11. [Slash Command Registration](#11-slash-command-registration)
12. [Bot Manifest](#12-bot-manifest)
13. [Error Handling](#13-error-handling)
14. [Webhook Adapter](#14-webhook-adapter)
15. [Complete Examples](#15-complete-examples)
16. [Type Reference](#16-type-reference)

---

## 1. Installation

```bash
pip install nexus-bot-sdk
```

**Requirements**: Python 3.10 or later. The SDK relies on the `match` statement and union-type syntax (`X | Y`) introduced in Python 3.10, and on Pydantic v2 for model validation.

| Dependency | Version | Purpose |
|------------|---------|---------|
| `websockets` | >=12.0 | WebSocket transport for persistent bot connections |
| `aiohttp` | >=3.9 | HTTP client for REST API calls (channel info, member lists) |
| `pydantic` | >=2.0 | Runtime validation and serialisation of event payloads |

---

## 2. Quick Start

```python
import asyncio
from nexus_bot_sdk import NexusBot, MessageEvent

async def main() -> None:
    bot = NexusBot(
        token="nxbot_v1_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        gateway_url="wss://gateway.nexus.chat/bot-ws",
    )

    @bot.on("message")
    async def on_message(event: MessageEvent) -> None:
        if event.text == "/ping":
            await bot.send_message(event.channel_id, "Pong! 🏓")

    await bot.connect()
    await bot.wait_until_closed()

asyncio.run(main())
```

`bot.wait_until_closed()` blocks the coroutine until the connection is intentionally closed via `bot.disconnect()` or an unrecoverable error occurs.

---

## 3. Constructor & Configuration

### 3.1 `NexusBot`

```python
class NexusBot:
    def __init__(
        self,
        *,
        token: str,
        gateway_url: str = "wss://gateway.nexus.chat/bot-ws",
        reconnect: ReconnectConfig | None = None,
        rate_limit: RateLimitConfig | None = None,
    ) -> None: ...
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `token` | `str` | *(required)* | Bot authentication token (`nxbot_v1_...`). Keep this secret. |
| `gateway_url` | `str` | `"wss://gateway.nexus.chat/bot-ws"` | WebSocket gateway endpoint. |
| `reconnect` | `ReconnectConfig \| None` | `ReconnectConfig()` | Auto-reconnect behaviour (see [§10](#10-reconnection-strategy)). |
| `rate_limit` | `RateLimitConfig \| None` | `RateLimitConfig()` | Client-side token-bucket rate limiter (see [§9](#9-rate-limiter)). |

### 3.2 `ReconnectConfig`

```python
from nexus_bot_sdk import ReconnectConfig

@dataclass
class ReconnectConfig:
    enabled: bool = True
    max_retries: int = 10           # 0 = infinite
    initial_delay_ms: int = 1000
    max_delay_ms: int = 30_000
    jitter: bool = True
```

### 3.3 `RateLimitConfig`

```python
from nexus_bot_sdk import RateLimitConfig

@dataclass
class RateLimitConfig:
    max_per_minute: int = 120       # Outgoing API calls per minute
```

---

## 4. Event System

### 4.1 Registering Handlers

```python
@bot.on("message")
async def handle_message(event: MessageEvent) -> None: ...

@bot.on("message_edited")
async def handle_edit(event: MessageEditedEvent) -> None: ...

@bot.on("message_deleted")
async def handle_delete(event: MessageDeletedEvent) -> None: ...

@bot.on("channel_created")
async def handle_channel_created(event: ChannelCreatedEvent) -> None: ...

@bot.on("channel_archived")
async def handle_channel_archived(event: ChannelArchivedEvent) -> None: ...

@bot.on("member_joined")
async def handle_member_joined(event: MemberJoinedEvent) -> None: ...

@bot.on("member_left")
async def handle_member_left(event: MemberLeftEvent) -> None: ...

@bot.on("slash_command")
async def handle_command(event: SlashCommandEvent) -> None: ...

@bot.on("button_clicked")
async def handle_button(event: ButtonClickedEvent) -> None: ...
```

Multiple handlers may be registered for the same event type; they are invoked **sequentially** in registration order. If a handler raises an exception, subsequent handlers for that event are **not** called, and the error is logged (see [§13](#13-error-handling)).

### 4.2 Available Event Types

| Event String | Python Model | Trigger |
|-------------|-------------|---------|
| `"message"` | `MessageEvent` | User sends a message in a subscribed channel. |
| `"message_edited"` | `MessageEditedEvent` | User edits an existing message. |
| `"message_deleted"` | `MessageDeletedEvent` | User deletes a message. |
| `"channel_created"` | `ChannelCreatedEvent` | A channel the bot belongs to is created. |
| `"channel_archived"` | `ChannelArchivedEvent` | A channel the bot belongs to is archived. |
| `"member_joined"` | `MemberJoinedEvent` | A user joins a subscribed channel. |
| `"member_left"` | `MemberLeftEvent` | A user leaves a subscribed channel. |
| `"slash_command"` | `SlashCommandEvent` | A user invokes a slash command targeting this bot. |
| `"button_clicked"` | `ButtonClickedEvent` | A user clicks an interactive button from this bot. |

### 4.3 Decorator Overloads

The `@bot.on()` decorator accepts a `list[str]` to bind a single handler to multiple event types:

```python
@bot.on(["member_joined", "message"])
async def greet_member(event: MemberJoinedEvent | MessageEvent) -> None:
    match event:
        case MemberJoinedEvent():
            await bot.send_message(event.channel_id, f"Welcome <@{event.user_id}>!")
        case MessageEvent():
            if event.text == "/hello":
                await bot.send_message(event.channel_id, "Hi there!")
```

---

## 5. Event Models (Pydantic v2)

All event models are Pydantic v2 `BaseModel` subclasses with strict validation.

### 5.1 Base Event

```python
from pydantic import BaseModel, Field
from datetime import datetime

class BaseEvent(BaseModel):
    """Shared fields present on every inbound event."""
    model_config = {"extra": "forbid", "frozen": True}

    idempotency_key: str       # e.g. "msg_abc123:message.created"
    workspace_id: str          # UUID of the workspace
    channel_id: str            # UUID of the channel
    event_timestamp: datetime  # Server-side timestamp of the event
```

### 5.2 `MessageEvent`

```python
from typing import Sequence

class Attachment(BaseModel):
    """Media or file attachment on a message."""
    model_config = {"extra": "forbid", "frozen": True}

    id: str
    filename: str
    mime_type: str
    size_bytes: int
    url: str                      # Signed expiring URL
    thumbnail_url: str | None = None

class MessageEvent(BaseEvent):
    """Fired when a user sends a message in a subscribed channel."""
    type: str = "message"
    message_id: str
    user_id: str                  # Sender UUID
    text: str
    thread_id: str | None = None
    mentions: Sequence[str] = Field(default_factory=list)   # Mentioned user UUIDs
    attachments: Sequence[Attachment] = Field(default_factory=list)
```

### 5.3 `MessageEditedEvent`

```python
class MessageEditedEvent(BaseEvent):
    """Fired when a user edits a message in a subscribed channel."""
    type: str = "message_edited"
    message_id: str
    user_id: str                  # Editor UUID
    old_text: str
    new_text: str
```

### 5.4 `MessageDeletedEvent`

```python
class MessageDeletedEvent(BaseEvent):
    """Fired when a user deletes a message in a subscribed channel."""
    type: str = "message_deleted"
    message_id: str
    user_id: str                  # Deleter UUID
```

### 5.5 `ChannelCreatedEvent`

```python
class ChannelCreatedEvent(BaseEvent):
    """Fired when a channel the bot is a member of is created."""
    type: str = "channel_created"
    name: str
    created_by: str               # Creator UUID
```

### 5.6 `ChannelArchivedEvent`

```python
class ChannelArchivedEvent(BaseEvent):
    """Fired when a channel the bot is a member of is archived."""
    type: str = "channel_archived"
    archived_by: str              # Actor UUID
```

### 5.7 `MemberJoinedEvent`

```python
class MemberJoinedEvent(BaseEvent):
    """Fired when a user joins a subscribed channel."""
    type: str = "member_joined"
    user_id: str                  # Joiner UUID
```

### 5.8 `MemberLeftEvent`

```python
class MemberLeftEvent(BaseEvent):
    """Fired when a user leaves a subscribed channel."""
    type: str = "member_left"
    user_id: str                  # Leaver UUID
```

### 5.9 `SlashCommandEvent`

```python
from typing import Sequence

class SlashCommandEvent(BaseEvent):
    """Fired when a user invokes a slash command targeting this bot.

    The server validates that the command exists in the bot's manifest
    before dispatching this event.  The bot has a 3-second window to
    acknowledge the command before the client shows a timeout error.
    """
    type: str = "slash_command"
    command: str                  # e.g. "weather"
    args: Sequence[str] = Field(default_factory=list)  # e.g. ["tokyo", "--metric"]
    trigger_id: str               # Opaque ID for acknowledgement
    user_id: str                  # Invoking user UUID
```

### 5.10 `ButtonClickedEvent`

```python
class ButtonClickedEvent(BaseEvent):
    """Fired when a user clicks an interactive button from this bot."""
    type: str = "button_clicked"
    action_id: str
    value: str | None = None
    message_id: str
    user_id: str
```

### 5.11 Discriminated Union

```python
from typing import Annotated, Literal
from pydantic import Field, TypeAdapter

BotEvent = Annotated[
    MessageEvent
    | MessageEditedEvent
    | MessageDeletedEvent
    | ChannelCreatedEvent
    | ChannelArchivedEvent
    | MemberJoinedEvent
    | MemberLeftEvent
    | SlashCommandEvent
    | ButtonClickedEvent,
    Field(discriminator="type"),
]

# Parse a raw JSON dict into the correct model:
bot_event_adapter: TypeAdapter[BotEvent] = TypeAdapter(BotEvent)

parsed = bot_event_adapter.validate_python(raw_dict)
```

---

## 6. API Methods

All API methods are `async` and return awaitable objects. They communicate with the nexus-chat server over the WebSocket connection (or HTTP for channel queries).

### 6.1 Messaging

```python
class NexusBot:
    async def send_message(
        self,
        channel_id: str,
        text: str,
        *,
        thread_id: str | None = None,
        blocks: Sequence[Block] | None = None,
    ) -> Message: ...
```

Sends a plain-text or block-rich message to a channel. Returns the created `Message` object.

```python
class NexusBot:
    async def edit_message(
        self,
        channel_id: str,
        message_id: str,
        text: str,
    ) -> Message: ...
```

Edits a previously sent message. The bot may only edit its own messages.

```python
class NexusBot:
    async def delete_message(
        self,
        channel_id: str,
        message_id: str,
    ) -> None: ...
```

Deletes a message. The bot may only delete its own messages unless granted the `messages:manage` scope.

```python
class NexusBot:
    async def send_ephemeral(
        self,
        channel_id: str,
        user_id: str,
        text: str,
    ) -> None: ...
```

Sends a message visible only to the specified user. Ephemeral messages do not persist and are not delivered to other channel members.

### 6.2 Channel Operations

```python
from pydantic import BaseModel

class ChannelInfo(BaseModel):
    id: str
    name: str
    is_archived: bool
    is_encrypted: bool           # Always False for bot-accessible channels
    member_count: int
    created_at: datetime

class MemberInfo(BaseModel):
    user_id: str
    display_name: str
    joined_at: datetime

class NexusBot:
    async def get_channel_info(self, channel_id: str) -> ChannelInfo: ...

    async def get_member_list(self, channel_id: str) -> Sequence[MemberInfo]: ...
```

### 6.3 Message Response Model

```python
class Message(BaseModel):
    """A message object returned by API calls."""
    id: str
    channel_id: str
    user_id: str                  # Always the bot's own ID for sent messages
    text: str
    thread_id: str | None = None
    created_at: datetime
```

### 6.4 Block Kit (Preview)

```python
class Block(BaseModel):
    """A rich-layout block for composing structured messages."""
    type: Literal["section", "actions", "context", "divider"]
    text: str | None = None
    elements: Sequence[BlockElement] = Field(default_factory=list)

class BlockElement(BaseModel):
    type: Literal["button", "text"]
    text: str
    action_id: str | None = None
    value: str | None = None
```

---

## 7. Connection Lifecycle

### 7.1 State Machine

```
              ┌──────────────┐
     start───>│ CONNECTING   │
              └──────┬───────┘
                     │ WebSocket handshake completed
                     ▼
              ┌──────────────┐
              │AUTHENTICATING│──── token invalid ────> DISCONNECTED
              └──────┬───────┘
                     │ identity accepted, subscriptions registered
                     ▼
              ┌──────────────┐
              │   ACTIVE     │<──── events pushed from server
              └──────┬───────┘
                     │ error / timeout / close frame received
                     ▼
              ┌──────────────┐
              │ DISCONNECTED │──── auto-reconnect (exponential backoff) ──> CONNECTING
              └──────────────┘
```

### 7.2 Public API

```python
class NexusBot:
    @property
    def is_connected(self) -> bool:
        """True when the bot is in the ACTIVE state."""
        ...

    async def connect(self) -> None:
        """Initiate the WebSocket handshake, authenticate, and begin
        receiving events.  Raises `AuthenticationError` if the token
        is invalid.  Blocks until the connection is ACTIVE."""
        ...

    async def disconnect(self) -> None:
        """Gracefully close the WebSocket connection.  The reconnect
        manager will NOT attempt to reconnect after a manual disconnect.
        Blocks until the connection is fully closed."""
        ...

    async def wait_until_closed(self) -> None:
        """Block the calling coroutine until the connection closes
        (manually, by error, or after exhausting reconnection retries)."""
        ...

    async def set_presence(self, status: Literal["online", "away", "offline"]) -> None:
        """Update the bot's presence indicator (online/away/offline)."""
        ...
```

### 7.3 Heartbeat

The server expects a `PING` frame every **30 seconds**. If no `PING` is received within **60 seconds** (2× heartbeat interval), the server closes the connection. The SDK handles `PING`/`PONG` automatically — no user code is required.

---

## 8. Middleware Pipeline

Middleware provides a mechanism to intercept and transform events **before** they reach registered handlers. Middleware functions execute in registration order for each incoming event.

```python
from typing import Any, Awaitable, Callable, TypeVar
from nexus_bot_sdk import BaseEvent

EventHandler = Callable[[Any], Awaitable[None]]
MiddlewareFunc = Callable[[Any, EventHandler], Awaitable[None]]

class NexusBot:
    def use(self, middleware: MiddlewareFunc) -> None:
        """Register an async middleware in the event pipeline.

        Each middleware receives the event and a `next` callable.
        Call `await next(event)` to pass the event to the next
        middleware (or the final handler).  Do NOT call `next` to
        short-circuit processing.
        """
        ...
```

### 8.1 Example: Simple Logger

```python
async def log_middleware(event: BaseEvent, next: EventHandler) -> None:
    print(f"[{event.event_timestamp:%H:%M:%S}] {event.type} in {event.channel_id}")
    await next(event)

bot.use(log_middleware)
```

### 8.2 Example: Permission Guard

```python
ALLOWED_USERS = {"user_abc123", "user_def456"}

async def permission_guard(event: BaseEvent, next: EventHandler) -> None:
    match event:
        case SlashCommandEvent(user_id=uid) if uid not in ALLOWED_USERS:
            await bot.send_ephemeral(event.channel_id, uid, "Permission denied.")
            return  # Short-circuit: do not call next()
        case _:
            await next(event)

bot.use(permission_guard)
```

### 8.3 Example: Shared Context (Via `asyncio.ContextVar`)

```python
from contextvars import ContextVar

current_channel: ContextVar[str | None] = ContextVar("current_channel", default=None)

async def channel_tracker(event: BaseEvent, next: EventHandler) -> None:
    token = current_channel.set(event.channel_id)
    try:
        await next(event)
    finally:
        current_channel.reset(token)

bot.use(channel_tracker)
```

---

## 9. Rate Limiter

The SDK includes a **client-side asynchronous token-bucket** rate limiter. It is enabled by default (120 API calls per minute) and wraps every outgoing API call. When the server returns `429 Too Many Requests` with a `Retry-After` header, the SDK enters a **global pause** for the specified duration.

### 9.1 Configuration

```python
from nexus_bot_sdk import RateLimitConfig

# 60 API calls per minute (1 per second sustained)
bot = NexusBot(
    token="nxbot_v1_xxx",
    rate_limit=RateLimitConfig(max_per_minute=60),
)
```

### 9.2 Manual Rate-Limit Interaction

```python
class NexusBot:
    @property
    def rate_limit_remaining(self) -> int:
        """Approximate number of tokens remaining in the current window."""
        ...

    @property
    def rate_limit_reset_after_ms(self) -> float:
        """Milliseconds until the bucket fully refills."""
        ...
```

### 9.3 Implementation Sketch

The limiter uses a simple token bucket refilled proportionally to elapsed time:

```
                   max_per_minute tokens
         ────────────────────────────────────────
         │                                      │
    ─────┼────── leak: 1 token per API call ────┼────────> time
         │                                      │
         └── refill: (elapsed / 60_000) * max   │
```

When `global_pause` is active (triggered by a 429 response), all API calls block until the pause expires.

---

## 10. Reconnection Strategy

The SDK implements **exponential backoff with full jitter** for automatic reconnection.

### 10.1 Algorithm

```
delay = min(initial_delay × 2ᵃᵗᵗᵉᵐᵖᵗ, max_delay)
if jitter:
    delay = delay × (0.5 + random(0, 0.5))    # 50%–100% of computed delay
```

This yields the sequence (with jitter, approximate):  
`1000 ms → 2000 ms → 4000 ms → 8000 ms → 16 000 ms → 30 000 ms → 30 000 ms → ...`

### 10.2 Configuration

```python
from nexus_bot_sdk import ReconnectConfig

bot = NexusBot(
    token="nxbot_v1_xxx",
    reconnect=ReconnectConfig(
        enabled=True,
        max_retries=10,           # Give up after 10 attempts
        initial_delay_ms=1000,    # Start at 1 second
        max_delay_ms=30_000,      # Cap at 30 seconds
        jitter=True,              # Randomise to avoid thundering herd
    ),
)
```

Set `max_retries=0` for infinite retries (the bot never gives up).

### 10.3 Events

Reconnection lifecycle events are exposed as a special event type:

```python
from nexus_bot_sdk import ReconnectEvent

@bot.on("_reconnect")
async def on_reconnect(event: ReconnectEvent) -> None:
    print(f"Reconnect attempt {event.attempt}/{event.max_retries} "
          f"after {event.delay_ms} ms")

@bot.on("_connected")
async def on_connected(event: object) -> None:
    print("Connection established")
```

---

## 11. Slash Command Registration

### 11.1 Individual Command Definition

```python
from nexus_bot_sdk import SlashCommand

HELP_COMMAND = SlashCommand(
    name="help",
    description="Show available commands and their usage.",
    usage="/mybot help",
)

WEATHER_COMMAND = SlashCommand(
    name="weather",
    description="Get the current weather for a city.",
    usage="/mybot weather <city> [--metric]",
    args=[
        SlashCommandArg(name="city", description="City name", required=True, type="string"),
        SlashCommandArg(name="mode", description="Unit system", required=False, type="string"),
    ],
)
```

### 11.2 Registration at Bot Startup

```python
bot = NexusBot(token="nxbot_v1_xxx")

bot.register_command(HELP_COMMAND)
bot.register_command(WEATHER_COMMAND)

# Or pass all commands to the constructor:
bot = NexusBot(
    token="nxbot_v1_xxx",
    commands=[HELP_COMMAND, WEATHER_COMMAND],
)
```

Registration sends the command definitions to the server during the `SUBSCRIBED` handshake phase. The server validates them against the bot's declared scopes and makes them available for autocomplete in the client.

### 11.3 Handling Commands

```python
@bot.on("slash_command")
async def on_slash_command(event: SlashCommandEvent) -> None:
    match event.command:
        case "help":
            await bot.send_message(event.channel_id, "Usage: /mybot weather <city>")
        case "weather":
            city = event.args[0] if event.args else "unknown"
            await bot.send_message(
                event.channel_id,
                f"Weather for {city}: 22°C, partly cloudy.",
            )
        case _:
            await bot.send_ephemeral(
                event.channel_id,
                event.user_id,
                f"Unknown command: /{event.command}",
            )
```

### 11.4 Command Models

```python
from pydantic import BaseModel
from typing import Literal, Sequence

class SlashCommandArg(BaseModel):
    name: str
    description: str
    required: bool = False
    type: Literal["string", "number", "user", "channel"] = "string"

class SlashCommand(BaseModel):
    name: str                      # Must match /^[a-z][a-z0-9_-]*$/, max 32 chars
    description: str               # Max 100 chars
    usage: str | None = None       # Max 200 chars, e.g. "/weather <city>"
    args: Sequence[SlashCommandArg] = Field(default_factory=list)
```

---

## 12. Bot Manifest

A manifest is a static declaration of the bot's identity, capabilities, and commands. It is validated by the server during bot registration.

### 12.1 Manifest Model

```python
from pydantic import BaseModel, HttpUrl
from typing import Literal, Sequence

class BotManifest(BaseModel):
    """Declares a bot's identity, required scopes, and supported commands."""
    name: str                      # Max 50 chars
    description: str               # Max 500 chars
    commands: Sequence[SlashCommand] = Field(default_factory=list, max_length=50)
    scopes: Sequence[str]          # Required permission scopes
    connection_mode: Literal["websocket", "webhook"] = "websocket"
    webhook_url: HttpUrl | None = None
    icon_url: HttpUrl | None = None
```

### 12.2 Available Scopes

| Scope | Required For |
|-------|-------------|
| `messages:read` | Receiving `message`, `message_edited`, `message_deleted` events |
| `messages:write` | `send_message`, `edit_message`, `send_ephemeral` |
| `channels:read` | `get_channel_info`, `channel_created`, `channel_archived` events |
| `channels:manage` | Creating and archiving channels |
| `members:read` | `get_member_list`, `member_joined`, `member_left` events |
| `commands` | Registering and responding to slash commands |
| `interactions` | Receiving `button_clicked` events |
| `files:read` | Receiving file-related events |
| `files:write` | Uploading files |

### 12.3 Example Manifest

```python
MANIFEST = BotManifest(
    name="WeatherBot",
    description="Provides current weather and forecasts for cities worldwide.",
    commands=[WEATHER_COMMAND, HELP_COMMAND],
    scopes=["messages:read", "messages:write", "commands"],
    connection_mode="websocket",
    icon_url="https://example.com/weatherbot-icon.png",
)
```

---

## 13. Error Handling

### 13.1 Exception Hierarchy

```
NexusBotError                    # Base for all SDK errors
├── AuthenticationError          # Token invalid or expired (fatal)
├── ConnectionError              # WebSocket transport failure (recoverable)
│   ├── ConnectionTimeoutError   # Handshake did not complete in time
│   └── ConnectionClosedError    # Connection dropped unexpectedly
├── APIError                     # Server returned an error for an API call
│   ├── PermissionError_         # Bot lacks required scope
│   ├── RateLimitError           # 429 Too Many Requests
│   ├── NotFoundError            # Channel / message / user not found
│   └── ValidationError_         # Request payload failed server-side validation
├── EventParseError              # Inbound event JSON did not match any known model
└── ReconnectExhaustedError      # max_retries reached without successful reconnect
```

### 13.2 Catching Errors

```python
from nexus_bot_sdk import (
    AuthenticationError,
    APIError,
    PermissionError_,
    RateLimitError,
    NexusBotError,
)

@bot.on("message")
async def on_message(event: MessageEvent) -> None:
    try:
        await bot.send_message(event.channel_id, "Processing...")
    except PermissionError_:
        # Bot lacks messages:write scope — log and skip
        pass
    except RateLimitError as e:
        # Server told us to slow down; SDK already paused globally
        print(f"Rate limited; retry after {e.retry_after} s")
    except APIError as e:
        print(f"API error {e.code}: {e.message}")
    except NexusBotError:
        # Catch-all for any SDK error
        raise
```

### 13.3 Global Error Handler

Register a catch-all for unhandled event processing errors:

```python
@bot.on("_error")
async def on_error(event: Exception) -> None:
    import logging
    logging.exception("Unhandled error in bot event pipeline")
```

### 13.4 Error Model

```python
class NexusBotError(Exception):
    """Base class for all SDK exceptions."""

class AuthenticationError(NexusBotError):
    """Token was rejected by the server.  Do not retry without a new token."""

class ConnectionError(NexusBotError):
    """WebSocket transport error."""

class ConnectionTimeoutError(ConnectionError):
    """WebSocket handshake timed out."""

class ConnectionClosedError(ConnectionError):
    """Connection dropped with a non-normal close code."""
    code: int
    reason: str

class APIError(NexusBotError):
    """Server returned an error response for an API call."""
    code: str                     # e.g. "permission_denied"
    message: str
    status_code: int

class PermissionError_(APIError):
    """Bot lacks a required scope for this operation."""

class RateLimitError(APIError):
    """Rate limit exceeded."""
    retry_after: float            # Seconds to wait

class NotFoundError(APIError):
    """Target resource (channel, message, user) was not found."""

class ValidationError_(APIError):
    """Request payload failed server-side validation."""

class EventParseError(NexusBotError):
    """Inbound event could not be deserialised to any known model."""
    raw_data: str

class ReconnectExhaustedError(NexusBotError):
    """Maximum reconnection attempts reached."""
    attempts: int
    max_retries: int
```

---

## 14. Webhook Adapter

For bots that cannot maintain a persistent WebSocket connection (serverless functions, CI/CD pipelines), nexus-chat supports **webhook delivery** (Phase 1.5). The Python SDK provides a FastAPI-compatible adapter for verifying webhook signatures and parsing event payloads.

### 14.1 Signature Verification

```python
import hashlib
import hmac
import time

def verify_webhook_signature(
    body: str,
    signature_header: str,
    secret: str,
    *,
    tolerance_seconds: int = 300,
) -> bool:
    """Verify an X-Nexus-Signature header against the bot's signing secret.

    The header format is: t=1719000000,v1=<hex_hmac>
    Rejects timestamps older than `tolerance_seconds`.
    Uses constant-time comparison to prevent timing attacks.
    """
    parts = {}
    for item in signature_header.split(","):
        k, v = item.split("=", 1)
        parts[k] = v

    timestamp_str = parts.get("t", "0")
    signature = parts.get("v1", "")

    if abs(time.time() - int(timestamp_str)) > tolerance_seconds:
        return False

    signed_payload = f"{timestamp_str}.{body}"
    expected = hmac.new(
        secret.encode(),
        signed_payload.encode(),
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(signature, expected)
```

### 14.2 FastAPI Adapter

```python
from fastapi import FastAPI, Request, HTTPException, Header
from nexus_bot_sdk import (
    BotEvent,
    bot_event_adapter,
    verify_webhook_signature,
    EventParseError,
)
import os

app = FastAPI()
BOT_SIGNING_SECRET = os.environ["NEXUS_BOT_SIGNING_SECRET"]

@app.post("/webhook")
async def webhook(
    request: Request,
    x_nexus_signature: str = Header(alias="X-Nexus-Signature"),
    x_nexus_event: str = Header(alias="X-Nexus-Event"),
    x_nexus_delivery: str = Header(alias="X-Nexus-Delivery"),
    x_nexus_retry: str = Header(default="0", alias="X-Nexus-Retry"),
) -> dict[str, str]:
    body = await request.body()
    body_str = body.decode()

    if not verify_webhook_signature(body_str, x_nexus_signature, BOT_SIGNING_SECRET):
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        event = bot_event_adapter.validate_json(body_str)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Event parse error: {e}")

    # ── Route event to your bot logic ──────────────────
    await handle_event(event)

    return {"status": "ok"}

async def handle_event(event: BotEvent) -> None:
    match event:
        case MessageEvent():
            print(f"Message from {event.user_id}: {event.text}")
        case SlashCommandEvent():
            print(f"Command /{event.command} with args {event.args}")
```

### 14.3 Webhook Headers

| Header | Description |
|--------|-------------|
| `X-Nexus-Signature` | HMAC-SHA256 signature: `t=<unix_ts>,v1=<hex>` |
| `X-Nexus-Event` | Event type, e.g. `message.created` |
| `X-Nexus-Delivery` | Unique delivery ID for deduplication |
| `X-Nexus-Retry` | Retry attempt number (0 = initial delivery) |

### 14.4 Webhook Retry Policy

| Attempt | Delay | Cumulative |
|---------|-------|------------|
| 1 (initial) | — | 0 s |
| 2 | 5 s | 5 s |
| 3 | 15 s | 20 s |
| 4 (final) | 45 s | 65 s |

After 3 failed retries, the event is moved to the **dead letter queue** and the bot is notified via its status dashboard.

---

## 15. Complete Examples

### 15.1 Echo Bot

The simplest possible bot — echoes back every message it receives.

```python
# echo_bot.py
import asyncio
import os
from nexus_bot_sdk import NexusBot, MessageEvent

async def main() -> None:
    bot = NexusBot(
        token=os.environ["NEXUS_BOT_TOKEN"],
    )

    @bot.on("message")
    async def echo(event: MessageEvent) -> None:
        if event.text.startswith("/"):
            return  # Ignore slash commands
        await bot.send_message(
            event.channel_id,
            f"You said: {event.text}",
            thread_id=event.thread_id,
        )

    await bot.connect()
    await bot.wait_until_closed()

if __name__ == "__main__":
    asyncio.run(main())
```

### 15.2 Poll Bot with argparse

A bot that creates polls via slash commands, demonstrating argument parsing and structured responses.

```python
# poll_bot.py
import asyncio
import os
import argparse
from nexus_bot_sdk import (
    NexusBot,
    SlashCommandEvent,
    SlashCommand,
    SlashCommandArg,
)

async def main() -> None:
    bot = NexusBot(
        token=os.environ["NEXUS_BOT_TOKEN"],
    )

    bot.register_command(SlashCommand(
        name="poll",
        description="Create a poll with up to 5 options.",
        usage="/pollbot poll \"Question?\" \"Option A\" \"Option B\" \"Option C\"",
        args=[
            SlashCommandArg(name="question", description="The question to ask", required=True),
            SlashCommandArg(name="options", description="Space-separated options", required=True),
        ],
    ))

    @bot.on("slash_command")
    async def handle_poll(event: SlashCommandEvent) -> None:
        if event.command != "poll":
            return

        question = event.args[0] if len(event.args) > 0 else "No question"
        options = event.args[1:6]  # Limit to 5 options

        if len(options) < 2:
            await bot.send_ephemeral(
                event.channel_id, event.user_id,
                "A poll needs at least 2 options.",
            )
            return

        emoji = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]
        lines = [f"**{question}**", ""]
        for i, opt in enumerate(options):
            lines.append(f"{emoji[i]} {opt}")

        await bot.send_message(event.channel_id, "\n".join(lines))

    await bot.connect()
    await bot.wait_until_closed()

if __name__ == "__main__":
    asyncio.run(main())
```

### 15.3 Full-Featured Bot with Middleware, Typing, and Error Handling

```python
# full_bot.py
import asyncio
import logging
import os
from contextvars import ContextVar
from typing import Any, Awaitable, Callable

from nexus_bot_sdk import (
    NexusBot,
    # Events
    BaseEvent,
    MessageEvent,
    MemberJoinedEvent,
    SlashCommandEvent,
    ButtonClickedEvent,
    # Models
    SlashCommand,
    SlashCommandArg,
    ReconnectConfig,
    RateLimitConfig,
    # Errors
    NexusBotError,
    APIError,
    RateLimitError,
    PermissionError_,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

current_user: ContextVar[str | None] = ContextVar("current_user", default=None)

async def main() -> None:
    bot = NexusBot(
        token=os.environ["NEXUS_BOT_TOKEN"],
        reconnect=ReconnectConfig(max_retries=10, jitter=True),
        rate_limit=RateLimitConfig(max_per_minute=100),
    )

    # ── Register slash commands ──────────────────────────
    bot.register_command(SlashCommand(name="help", description="Show help"))
    bot.register_command(SlashCommand(
        name="echo",
        description="Echo back the provided text.",
        args=[SlashCommandArg(name="text", description="Text to echo", required=True)],
    ))

    # ── Middleware: logging ──────────────────────────────
    async def log_event(event: BaseEvent, next: Callable[[Any], Awaitable[None]]) -> None:
        logger.info("event=%s channel=%s user=%s", event.type, event.channel_id, getattr(event, "user_id", "-"))
        await next(event)

    bot.use(log_event)

    # ── Middleware: user context tracking ────────────────
    async def user_context(event: BaseEvent, next: Callable[[Any], Awaitable[None]]) -> None:
        uid = getattr(event, "user_id", None)
        token = current_user.set(uid)
        try:
            await next(event)
        finally:
            current_user.reset(token)

    bot.use(user_context)

    # ── Event handlers ───────────────────────────────────
    @bot.on("member_joined")
    async def greet_new_member(event: MemberJoinedEvent) -> None:
        try:
            await bot.send_message(
                event.channel_id,
                f"Welcome <@{event.user_id}>! Type `/help` to see what I can do.",
            )
        except RateLimitError:
            logger.warning("Rate limited while greeting member")

    @bot.on("message")
    async def handle_message(event: MessageEvent) -> None:
        if event.text.startswith("/"):
            return  # Slash commands are handled separately

        if "hello" in event.text.lower():
            await bot.send_message(event.channel_id, f"Hello <@{event.user_id}>!")

    @bot.on("slash_command")
    async def handle_slash(event: SlashCommandEvent) -> None:
        try:
            match event.command:
                case "help":
                    await bot.send_message(
                        event.channel_id,
                        "**Available commands:**\n• `/help` — Show this message\n• `/echo <text>` — Echo back text",
                    )
                case "echo":
                    text = event.args[0] if event.args else "nothing"
                    await bot.send_message(event.channel_id, text)
                case _:
                    await bot.send_ephemeral(
                        event.channel_id, event.user_id,
                        f"Unknown command: `/{event.command}`",
                    )
        except PermissionError_ as e:
            logger.error("Permission denied: %s", e)
        except APIError as e:
            logger.error("API error %s: %s", e.code, e.message)

    @bot.on("_error")
    async def global_error_handler(error: Exception) -> None:
        logger.exception("Unhandled error in bot pipeline")

    @bot.on("_connected")
    async def on_connect(_: object) -> None:
        logger.info("Bot connected successfully")
        await bot.set_presence("online")

    # ── Connect ──────────────────────────────────────────
    try:
        await bot.connect()
    except NexusBotError as e:
        logger.critical("Failed to connect: %s", e)
        return

    await bot.wait_until_closed()

if __name__ == "__main__":
    asyncio.run(main())
```

### 15.4 Bot with Button Interactions

```python
# button_bot.py
import asyncio
import os
from nexus_bot_sdk import (
    NexusBot,
    MessageEvent,
    SlashCommandEvent,
    ButtonClickedEvent,
    SlashCommand,
    Block,
    BlockElement,
)

async def main() -> None:
    bot = NexusBot(token=os.environ["NEXUS_BOT_TOKEN"])

    bot.register_command(SlashCommand(
        name="confirm",
        description="Ask a yes/no confirmation question.",
        args=[],
    ))

    @bot.on("slash_command")
    async def ask_confirm(event: SlashCommandEvent) -> None:
        if event.command != "confirm":
            return

        blocks = [
            Block(
                type="section",
                text="Are you sure you want to proceed?",
            ),
            Block(
                type="actions",
                elements=[
                    BlockElement(type="button", text="Yes", action_id="confirm_yes", value="proceed"),
                    BlockElement(type="button", text="No", action_id="confirm_no", value="cancel"),
                ],
            ),
        ]
        await bot.send_message(event.channel_id, "", blocks=blocks)

    @bot.on("button_clicked")
    async def handle_click(event: ButtonClickedEvent) -> None:
        if event.action_id == "confirm_yes":
            await bot.send_message(event.channel_id, f"<@{event.user_id}> confirmed: proceeding!")
        elif event.action_id == "confirm_no":
            await bot.send_message(event.channel_id, f"<@{event.user_id}> cancelled.")

    await bot.connect()
    await bot.wait_until_closed()

if __name__ == "__main__":
    asyncio.run(main())
```

### 15.5 CLI Entry Point with argparse

```python
# run_bot.py
"""Generic bot launcher with CLI argument parsing."""
import argparse
import asyncio
import os
from nexus_bot_sdk import NexusBot, MessageEvent

async def run_bot(token: str, gateway_url: str) -> None:
    bot = NexusBot(token=token, gateway_url=gateway_url)

    @bot.on("message")
    async def on_message(event: MessageEvent) -> None:
        if event.text == "/ping":
            await bot.send_message(event.channel_id, "Pong!")

    await bot.connect()
    await bot.wait_until_closed()

def main() -> None:
    parser = argparse.ArgumentParser(description="Nexus Chat Bot Runner")
    parser.add_argument(
        "--token",
        default=os.environ.get("NEXUS_BOT_TOKEN"),
        help="Bot token (default: $NEXUS_BOT_TOKEN)",
    )
    parser.add_argument(
        "--gateway-url",
        default=os.environ.get("NEXUS_BOT_GATEWAY_URL", "wss://gateway.nexus.chat/bot-ws"),
        help="WebSocket gateway URL",
    )
    args = parser.parse_args()

    if not args.token:
        parser.error("No token provided. Set NEXUS_BOT_TOKEN or pass --token.")

    asyncio.run(run_bot(args.token, args.gateway_url))

if __name__ == "__main__":
    main()
```

---

## 16. Type Reference

### 16.1 Public API Surface

```python
# Re-exports from nexus_bot_sdk

# ── Main class ──────────────────────────────────────────
from nexus_bot_sdk import NexusBot

# ── Configuration ───────────────────────────────────────
from nexus_bot_sdk import ReconnectConfig, RateLimitConfig

# ── Event models ────────────────────────────────────────
from nexus_bot_sdk import (
    BaseEvent,
    MessageEvent,
    MessageEditedEvent,
    MessageDeletedEvent,
    ChannelCreatedEvent,
    ChannelArchivedEvent,
    MemberJoinedEvent,
    MemberLeftEvent,
    SlashCommandEvent,
    ButtonClickedEvent,
    Attachment,
    BotEvent,                # Discriminated union of all event types
    bot_event_adapter,       # pydantic.TypeAdapter[BotEvent]
)

# ── Command models ──────────────────────────────────────
from nexus_bot_sdk import SlashCommand, SlashCommandArg

# ── Response models ─────────────────────────────────────
from nexus_bot_sdk import (
    Message,
    ChannelInfo,
    MemberInfo,
    Block,
    BlockElement,
)

# ── Manifest ────────────────────────────────────────────
from nexus_bot_sdk import BotManifest

# ── Webhook utilities ───────────────────────────────────
from nexus_bot_sdk import verify_webhook_signature

# ── Exceptions ──────────────────────────────────────────
from nexus_bot_sdk import (
    NexusBotError,
    AuthenticationError,
    ConnectionError,
    ConnectionTimeoutError,
    ConnectionClosedError,
    APIError,
    PermissionError_,
    RateLimitError,
    NotFoundError,
    ValidationError_,
    EventParseError,
    ReconnectExhaustedError,
)
```

### 16.2 Module Layout

```
nexus_bot_sdk/
├── __init__.py              # Public API re-exports
├── _bot.py                  # NexusBot class
├── _config.py               # ReconnectConfig, RateLimitConfig
├── _events.py               # Pydantic event models + BotEvent union
├── _commands.py             # SlashCommand, SlashCommandArg
├── _models.py               # Message, ChannelInfo, MemberInfo, Block, etc.
├── _manifest.py             # BotManifest
├── _transport/              # WebSocket connection, frame protocol
│   ├── __init__.py
│   └── _ws.py
├── _middleware/             # Middleware pipeline
│   ├── __init__.py
│   └── _pipeline.py
├── _rate_limiter.py         # Async token bucket
├── _reconnect.py            # Exponential backoff manager
├── _webhook.py              # verify_webhook_signature, FastAPI helpers
├── _errors.py               # Exception hierarchy
└── py.typed                 # PEP 561 marker
```

