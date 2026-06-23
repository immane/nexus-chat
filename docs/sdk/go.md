---
lang: en
---

# Nexus Chat — Go Bot SDK

> **Module**: `github.com/nexus-chat/bot-sdk-go`
> **Minimum Go version**: 1.21 (generics, `log/slog` structured logging)
> **Dependencies**: `gorilla/websocket`, `golang.org/x/time/rate` (stdlib `encoding/json`, `crypto/hmac`, `crypto/sha256`, `math/rand`, `sync`, `context`, `log/slog`, `net/http`, `time`)
> **Status**: v1.0.0

---

## Table of Contents

1. [Installation](#1-installation)
2. [Quick Start](#2-quick-start)
3. [Core Concepts](#3-core-concepts)
   - [3.1 Bot Lifecycle](#31-bot-lifecycle)
   - [3.2 Event-Driven Architecture](#32-event-driven-architecture)
   - [3.3 Goroutine Safety & Concurrency Model](#33-goroutine-safety--concurrency-model)
4. [API Reference](#4-api-reference)
   - [4.1 Constructor](#41-constructor)
   - [4.2 Event Handler Registration](#42-event-handler-registration)
   - [4.3 Sending Messages](#43-sending-messages)
   - [4.4 Channel API](#44-channel-api)
   - [4.5 Connection Management](#45-connection-management)
   - [4.6 Middleware](#46-middleware)
   - [4.7 Rate Limiter](#47-rate-limiter)
5. [Event Types](#5-event-types)
   - [5.1 The Event Interface](#51-the-event-interface)
   - [5.2 Message Events](#52-message-events)
   - [5.3 Channel Events](#53-channel-events)
   - [5.4 Membership Events](#54-membership-events)
   - [5.5 Interaction Events](#55-interaction-events)
   - [5.6 Slash Command Event](#56-slash-command-event)
   - [5.7 Bot Lifecycle Events](#57-bot-lifecycle-events)
6. [Slash Command Framework](#6-slash-command-framework)
   - [6.1 Command Manifest](#61-command-manifest)
   - [6.2 Command Handler Registration](#62-command-handler-registration)
   - [6.3 Argument Parsing](#63-argument-parsing)
   - [6.4 E2E Channel Constraint](#64-e2e-channel-constraint)
7. [Error Handling](#7-error-handling)
   - [7.1 Custom Error Types](#71-custom-error-types)
   - [7.2 Error Inspection](#72-error-inspection)
   - [7.3 Retryable vs Non-Retryable](#73-retryable-vs-non-retryable)
   - [7.4 Server-Reported Errors](#74-server-reported-errors)
8. [Reconnection](#8-reconnection)
   - [8.1 Exponential Backoff with Jitter](#81-exponential-backoff-with-jitter)
   - [8.2 State Transitions](#82-state-transitions)
   - [8.3 Heartbeat](#83-heartbeat)
9. [Structured Logging with slog](#9-structured-logging-with-slog)
10. [Complete Examples](#10-complete-examples)
    - [10.1 Echo Bot](#101-echo-bot)
    - [10.2 Poll Bot](#102-poll-bot)
    - [10.3 CI/CD Bot](#103-cicd-bot)
    - [10.4 Kubernetes Operator Bot](#104-kubernetes-operator-bot)
    - [10.5 Moderation Bot with Middleware](#105-moderation-bot-with-middleware)
11. [Connection Security](#11-connection-security)
12. [Performance Tuning](#12-performance-tuning)
13. [Migration Guide (TypeScript → Go)](#13-migration-guide-typescript--go)

---

## 1. Installation

```bash
go get github.com/nexus-chat/bot-sdk-go@v1.0.0
```

The SDK depends on `gorilla/websocket` for the WebSocket transport layer and `golang.org/x/time/rate` for the client-side token-bucket rate limiter. All other dependencies come from the Go standard library.

Your `go.mod` will resolve to:

```
require (
    github.com/gorilla/websocket v1.5.3
    github.com/nexus-chat/bot-sdk-go v1.0.0
    golang.org/x/time v0.6.0
)
```

---

## 2. Quick Start

The minimal bot listens for `message` events and responds to `/ping` with `Pong!`.

```go
package main

import (
    "context"
    "log"
    "os"

    nexus "github.com/nexus-chat/bot-sdk-go"
)

func main() {
    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),      // "nxbot_v1_xxxx"
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
    })
    if err != nil {
        log.Fatal(err)
    }

    bot.On("message", func(ctx context.Context, evt nexus.Event) error {
        msg := evt.(*nexus.MessageEvent)
        if msg.Text == "/ping" {
            return bot.SendMessage(ctx, msg.ChannelID, "Pong!")
        }
        return nil
    })

    if err := bot.Connect(context.Background()); err != nil {
        log.Fatal(err)
    }
}
```

The `Connect` call blocks until the caller invokes `bot.Disconnect()`, or until the OS sends a signal. Use `signal.NotifyContext` for graceful shutdown:

```go
ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)
defer cancel()

if err := bot.Connect(ctx); err != nil {
    slog.Error("bot exited", "error", err)
}
```

---

## 3. Core Concepts

### 3.1 Bot Lifecycle

A Go bot's lifecycle follows the state machine defined in the [Async Bot Engine Design](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#32-connection-lifecycle):

```
NewBot() ──► Connect(ctx) ──► WebSocket handshake ──► identity frame
                                                          │
                    ┌─────────────────────────────────────┘
                    ▼
              SUBSCRIBED ──► ACTIVE (events flowing)
                    ▲              │
                    │              │ error / timeout / ctx cancel
                    │              ▼
                    │         DISCONNECTED
                    │              │
                    └──────────────┘
               (reconnect with backoff)
```

- `NewBot` creates the struct and validates options; it does **not** open any network connection.
- `Connect(ctx)` performs the WebSocket handshake, sends the `identity` frame with the bot token, subscribes to channels, and enters the event loop.
- The connection persists until `ctx` is cancelled, or `Disconnect()` is called, or the server closes the connection.
- Reconnection is automatic and transparent (see [§8](#8-reconnection)).

### 3.2 Event-Driven Architecture

All bot logic is event-driven. The SDK does **not** expose polling loops or callback registries. You register handlers for event types:

```go
bot.On("message",        messageHandler)
bot.On("slash_command",  slashCommandHandler)
bot.On("member_joined",  welcomeHandler)
```

Handlers are invoked asynchronously in dedicated goroutines (see [§3.3](#33-goroutine-safety--concurrency-model)). **Handlers for the same event type are guaranteed sequential** (order is preserved per channel), but handlers for different event types run concurrently. Block in a handler only as long as necessary.

Every handler receives a `context.Context`. This context:
- Carries a deadline derived from the gateway's event-processing timeout (default 30 s).
- Is cancelled if the bot disconnects while the handler is still running.
- Is the **same instance** passed to API calls (`SendMessage`, `EditMessage`, etc.).

### 3.3 Goroutine Safety & Concurrency Model

| Component | Strategy |
|-----------|----------|
| Event dispatch | One serial goroutine per event type, dispatched via a buffered channel (capacity 256). |
| API calls (`SendMessage`, etc.) | Write to the WebSocket connection is serialised by a dedicated send goroutine fed by a channel of outgoing frames. |
| `BotOptions` and immutable fields | Safe for concurrent reads after construction. |
| Internal connection state (`IsConnected`) | Protected by `sync.RWMutex`. |
| Handler registration (`On`, `Off`) | Must be called **before** `Connect`. Registration after connection is a no-op. |

**Golden rule**: Handlers receive a **value copy** of the event struct (not a pointer shared across goroutines). You may safely read (but not mutate) the event in multiple handlers. If you need to pass data between handlers, use the context:

```go
ctx = context.WithValue(ctx, myKey, myData)
```

---

## 4. API Reference

### 4.1 Constructor

```go
func NewBot(opts BotOptions) (*Bot, error)
```

#### `BotOptions`

```go
type BotOptions struct {
    // Token is the bot authentication token, formatted as "nxbot_v1_<base64url>".
    // Required.
    Token string

    // GatewayURL is the WebSocket endpoint for the bot relay.
    // Default: "wss://gateway.nexus.chat/bot-ws"
    GatewayURL string

    // Reconnect configures automatic reconnection. If nil, defaults are used.
    Reconnect *ReconnectConfig

    // RateLimit configures the client-side token-bucket rate limiter.
    // If nil, the default (120 req/min) is used.
    RateLimit *RateLimitConfig

    // Logger is a *slog.Logger for structured logging. If nil, slog.Default() is used.
    Logger *slog.Logger

    // HTTPClient is used for REST API calls (channel info, member list).
    // If nil, http.DefaultClient is used.
    HTTPClient *http.Client

    // HeartbeatInterval is the WebSocket ping interval. Default: 25 s.
    HeartbeatInterval time.Duration

    // HandshakeTimeout is the deadline for the WebSocket dial + identity exchange.
    // Default: 10 s.
    HandshakeTimeout time.Duration

    // Manifest declares the bot's slash commands and required scopes.
    Manifest BotManifest
}

type ReconnectConfig struct {
    Enabled        bool          // Default: true
    MaxRetries     int           // Default: 10; 0 = infinite
    InitialDelay   time.Duration // Default: 1 s
    MaxDelay       time.Duration // Default: 30 s
    Jitter         bool          // Default: true
}

type RateLimitConfig struct {
    MaxPerMinute int // Default: 120
}
```

#### Validation

`NewBot` validates:
- `Token` is non-empty and matches the prefix `nxbot_v1_`.
- `GatewayURL` parses as a valid `wss://` URL.
- `HeartbeatInterval` is at least 5 s.

If validation fails, a descriptive `*ErrInvalidOption` is returned.

---

### 4.2 Event Handler Registration

```go
func (b *Bot) On(eventType string, handler EventHandler)
func (b *Bot) Off(eventType string, handler EventHandler) // remove previously registered handler
```

**Event handler signature:**

```go
type EventHandler func(ctx context.Context, evt Event) error
```

`On` appends the handler to the internal dispatch table for `eventType`. Handlers are invoked in registration order.

`Off` removes a previously registered handler. The comparison is pointer-based — you must pass the exact same function value.

**Must be called before `Connect`.** Registrations after `Connect` has been called are silently ignored.

Valid `eventType` strings are listed in [§5](#5-event-types). Unknown event types are accepted silently; the handler will simply never fire.

---

### 4.3 Sending Messages

```go
func (b *Bot) SendMessage(ctx context.Context, channelID, text string, opts ...MessageOption) (*Message, error)
func (b *Bot) EditMessage(ctx context.Context, channelID, messageID, text string) (*Message, error)
func (b *Bot) DeleteMessage(ctx context.Context, channelID, messageID string) error
func (b *Bot) SendEphemeral(ctx context.Context, channelID, userID, text string) error
```

#### `MessageOption` Variadic Helpers

```go
type MessageOption func(*messageRequest)

// WithThreadID attaches the message to a thread.
func WithThreadID(threadID string) MessageOption

// WithBlocks attaches Block Kit blocks for rich formatting.
func WithBlocks(blocks []Block) MessageOption

// WithMentions explicitly mentions users (e.g. "<@U123>").
func WithMentions(userIDs []string) MessageOption

// WithAttachments attaches file references.
func WithAttachments(attachments []Attachment) MessageOption
```

#### Structs

```go
type Message struct {
    ID        string       `json:"id"`
    ChannelID string       `json:"channel_id"`
    UserID    string       `json:"user_id"`
    Text      string       `json:"text"`
    ThreadID  string       `json:"thread_id,omitempty"`
    Blocks    []Block      `json:"blocks,omitempty"`
    CreatedAt time.Time    `json:"created_at"`
    EditedAt  *time.Time   `json:"edited_at,omitempty"`
}

type Block struct {
    Type     string         `json:"type"`           // "section", "actions", "divider", "context"
    Text     *BlockText     `json:"text,omitempty"`
    Elements []BlockElement `json:"elements,omitempty"`
}

type BlockText struct {
    Type     string `json:"type"`  // "plain_text" | "mrkdwn"
    Text     string `json:"text"`
    Verbatim bool   `json:"verbatim,omitempty"`
}

type BlockElement struct {
    Type     string `json:"type"`     // "button", "datepicker", "static_select"
    ActionID string `json:"action_id"`
    Text     BlockText `json:"text"`
    Value    string    `json:"value,omitempty"`
    Style    string    `json:"style,omitempty"` // "primary" | "danger"
}

type Attachment struct {
    ID       string `json:"id"`
    Filename string `json:"filename"`
    MimeType string `json:"mime_type"`
    Size     int64  `json:"size"`
    URL      string `json:"url"`
}
```

#### Example — Sending with blocks

```go
err := bot.SendMessage(ctx, channelID, "Deployment status:", 
    nexus.WithBlocks([]nexus.Block{
        {
            Type: "section",
            Text: &nexus.BlockText{Type: "mrkdwn", Text: "*staging* — `v2.7.1` deployed successfully :white_check_mark:"},
        },
        {
            Type: "actions",
            Elements: []nexus.BlockElement{
                {Type: "button", ActionID: "rollback", Text: nexus.BlockText{Type: "plain_text", Text: "Rollback"}, Style: "danger", Value: "v2.7.0"},
                {Type: "button", ActionID: "view_logs", Text: nexus.BlockText{Type: "plain_text", Text: "View Logs"}, Value: "build-7821"},
            },
        },
    }),
)
```

---

### 4.4 Channel API

```go
func (b *Bot) GetChannelInfo(ctx context.Context, channelID string) (*ChannelInfo, error)
func (b *Bot) GetMemberList(ctx context.Context, channelID string, opts ...MemberListOption) (*MemberListPage, error)
```

```go
type ChannelInfo struct {
    ID          string    `json:"id"`
    Name        string    `json:"name"`
    Topic       string    `json:"topic,omitempty"`
    IsEncrypted bool      `json:"is_encrypted"`
    IsArchived  bool      `json:"is_archived"`
    MemberCount int       `json:"member_count"`
    CreatedBy   string    `json:"created_by"`
    CreatedAt   time.Time `json:"created_at"`
}

type Member struct {
    UserID    string    `json:"user_id"`
    Username  string    `json:"username"`
    DisplayName string  `json:"display_name"`
    IsAdmin   bool      `json:"is_admin"`
    JoinedAt  time.Time `json:"joined_at"`
}

type MemberListPage struct {
    Members    []Member `json:"members"`
    NextCursor string   `json:"next_cursor,omitempty"`
    HasMore    bool     `json:"has_more"`
}

type MemberListOption func(*memberListRequest)

func WithMemberCursor(cursor string) MemberListOption
func WithMemberLimit(limit int) MemberListOption // max 200
```

---

### 4.5 Connection Management

```go
func (b *Bot) Connect(ctx context.Context) error
func (b *Bot) Disconnect() error
func (b *Bot) IsConnected() bool
```

| Method | Behaviour |
|--------|-----------|
| `Connect(ctx)` | Performs WebSocket handshake, auth, channel subscription, then blocks on the event loop. Returns when `ctx` is cancelled or after fatal errors (token rejected, max retries exhausted). |
| `Disconnect()` | Sends a graceful close frame, stops the event loop, and marks the bot disconnected. Can be called multiple times safely. |
| `IsConnected()` | Returns `true` when the bot is in the ACTIVE state and receiving events. Thread-safe. |

---

### 4.6 Middleware

The SDK supports a pluggable middleware chain that wraps every event handler invocation — similar to HTTP middleware in `net/http`.

```go
type Middleware func(ctx context.Context, evt Event, next Handler) error
type Handler func(ctx context.Context, evt Event) error

func (b *Bot) Use(middlewares ...Middleware)
```

Middleware is executed in registration order before the event handler. A middleware can:
- **Modify the context** (inject values, deadlines).
- **Log / measure** the handler duration.
- **Short-circuit** by returning an error without calling `next`.
- **Recover from panics** inside handlers.

**Example — logging and panic recovery middleware:**

```go
// Logging middleware.
func loggingMiddleware(logger *slog.Logger) nexus.Middleware {
    return func(ctx context.Context, evt nexus.Event, next nexus.Handler) error {
        start := time.Now()
        err := next(ctx, evt)
        logger.Info("event handled",
            "type", evt.EventType(),
            "duration_ms", time.Since(start).Milliseconds(),
        )
        return err
    }
}

// Panic recovery middleware.
func recoveryMiddleware(logger *slog.Logger) nexus.Middleware {
    return func(ctx context.Context, evt nexus.Event, next nexus.Handler) error {
        defer func() {
            if r := recover(); r != nil {
                logger.Error("handler panicked",
                    "event_type", evt.EventType(),
                    "panic", r,
                )
            }
        }()
        return next(ctx, evt)
    }
}

// Authorization middleware — reject events from blocked users.
func blocklistMiddleware(blocked map[string]bool) nexus.Middleware {
    return func(ctx context.Context, evt nexus.Event, next nexus.Handler) error {
        if msg, ok := evt.(*nexus.MessageEvent); ok {
            if blocked[msg.UserID] {
                return nil // silently drop
            }
        }
        return next(ctx, evt)
    }
}

func main() {
    bot, _ := nexus.NewBot(nexus.BotOptions{Token: "...", GatewayURL: "..."})

    bot.Use(
        recoveryMiddleware(slog.Default()),
        loggingMiddleware(slog.Default()),
        blocklistMiddleware(map[string]bool{"U_bot_spammer": true}),
    )

    bot.On("message", func(ctx context.Context, evt nexus.Event) error {
        // ... handler logic
        return nil
    })

    bot.Connect(context.Background())
}
```

---

### 4.7 Rate Limiter

The SDK embeds a **client-side token-bucket rate limiter** (backed by `golang.org/x/time/rate`). Outbound API calls (`SendMessage`, `EditMessage`, `DeleteMessage`, etc.) consume one token each.

If the token bucket is empty, the call blocks until a token becomes available (respecting the context deadline).

When the server responds with HTTP `429 Too Many Requests`, the SDK reads the `Retry-After` header and **globally pauses** all outgoing calls for that duration.

```go
// Configuration
bot, _ := nexus.NewBot(nexus.BotOptions{
    RateLimit: &nexus.RateLimitConfig{
        MaxPerMinute: 60, // override the default 120
    },
    // ...
})
```

**Internal implementation sketch:**

```go
import "golang.org/x/time/rate"

type rateLimiter struct {
    limiter      *rate.Limiter
    globalPause  atomic.Int64   // UnixNano timestamp until which ALL calls are paused
}

func (rl *rateLimiter) wait(ctx context.Context) error {
    // 1. Respect global pause from 429 response.
    if until := time.Unix(0, rl.globalPause.Load()); time.Now().Before(until) {
        d := time.Until(until)
        select {
        case <-time.After(d):
        case <-ctx.Done():
            return ctx.Err()
        }
    }
    // 2. Wait for token-bucket token.
    return rl.limiter.Wait(ctx)
}
```

---

## 5. Event Types

### 5.1 The Event Interface

All event structs implement the `Event` interface:

```go
type Event interface {
    // EventType returns the event type string (e.g. "message", "slash_command").
    EventType() string

    // WorkspaceID identifies the workspace where the event originated.
    WorkspaceID() string

    // Timestamp is the server-side time when the event was generated.
    Timestamp() time.Time
}
```

Events are dispatched by `eventType` string. Use type-switching in handlers to access specific fields:

```go
bot.On("message", func(ctx context.Context, evt nexus.Event) error {
    switch e := evt.(type) {
    case *nexus.MessageEvent:
        // handle message
    default:
        // unknown payload for "message" type
    }
    return nil
})
```

### 5.2 Message Events

```go
type MessageEvent struct {
    ID          string       `json:"id"`
    ChannelID   string       `json:"channel_id"`
    UserID      string       `json:"user_id"`
    Text        string       `json:"text"`
    ThreadID    string       `json:"thread_id,omitempty"`
    Mentions    []string     `json:"mentions,omitempty"`
    Attachments []Attachment `json:"attachments,omitempty"`
    EditedAt    *time.Time   `json:"edited_at,omitempty"`
    WsID        string       `json:"workspace_id"`
    Ts          time.Time    `json:"timestamp"`
}

func (e *MessageEvent) EventType() string   { return "message" }
func (e *MessageEvent) WorkspaceID() string { return e.WsID }
func (e *MessageEvent) Timestamp() time.Time { return e.Ts }
```

| Event Type        | Trigger                         | Go Struct               |
|-------------------|---------------------------------|-------------------------|
| `message`         | User sends a message            | `*MessageEvent`         |
| `message_edited`  | User edits an existing message  | `*MessageEditedEvent`   |
| `message_deleted` | User deletes a message          | `*MessageDeletedEvent`  |

```go
type MessageEditedEvent struct {
    ID        string    `json:"id"`
    ChannelID string    `json:"channel_id"`
    UserID    string    `json:"user_id"`
    OldText   string    `json:"old_text"`
    NewText   string    `json:"new_text"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *MessageEditedEvent) EventType() string   { return "message_edited" }
func (e *MessageEditedEvent) WorkspaceID() string { return e.WsID }
func (e *MessageEditedEvent) Timestamp() time.Time { return e.Ts }

type MessageDeletedEvent struct {
    ID        string    `json:"id"`
    ChannelID string    `json:"channel_id"`
    UserID    string    `json:"user_id"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *MessageDeletedEvent) EventType() string   { return "message_deleted" }
func (e *MessageDeletedEvent) WorkspaceID() string { return e.WsID }
func (e *MessageDeletedEvent) Timestamp() time.Time { return e.Ts }
```

### 5.3 Channel Events

```go
type ChannelCreatedEvent struct {
    ChannelID string    `json:"channel_id"`
    Name      string    `json:"name"`
    CreatedBy string    `json:"created_by"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *ChannelCreatedEvent) EventType() string   { return "channel_created" }
func (e *ChannelCreatedEvent) WorkspaceID() string { return e.WsID }
func (e *ChannelCreatedEvent) Timestamp() time.Time { return e.Ts }

type ChannelArchivedEvent struct {
    ChannelID  string    `json:"channel_id"`
    ArchivedBy string    `json:"archived_by"`
    WsID       string    `json:"workspace_id"`
    Ts         time.Time `json:"timestamp"`
}

func (e *ChannelArchivedEvent) EventType() string   { return "channel_archived" }
func (e *ChannelArchivedEvent) WorkspaceID() string { return e.WsID }
func (e *ChannelArchivedEvent) Timestamp() time.Time { return e.Ts }
```

### 5.4 Membership Events

```go
type MemberJoinedEvent struct {
    ChannelID string    `json:"channel_id"`
    UserID    string    `json:"user_id"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *MemberJoinedEvent) EventType() string   { return "member_joined" }
func (e *MemberJoinedEvent) WorkspaceID() string { return e.WsID }
func (e *MemberJoinedEvent) Timestamp() time.Time { return e.Ts }

type MemberLeftEvent struct {
    ChannelID string    `json:"channel_id"`
    UserID    string    `json:"user_id"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *MemberLeftEvent) EventType() string   { return "member_left" }
func (e *MemberLeftEvent) WorkspaceID() string { return e.WsID }
func (e *MemberLeftEvent) Timestamp() time.Time { return e.Ts }
```

### 5.5 Interaction Events

```go
type ButtonClickedEvent struct {
    ActionID  string    `json:"action_id"`
    Value     string    `json:"value"`
    MessageID string    `json:"message_id"`
    ChannelID string    `json:"channel_id"`
    UserID    string    `json:"user_id"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *ButtonClickedEvent) EventType() string   { return "button_clicked" }
func (e *ButtonClickedEvent) WorkspaceID() string { return e.WsID }
func (e *ButtonClickedEvent) Timestamp() time.Time { return e.Ts }
```

### 5.6 Slash Command Event

```go
type SlashCommandEvent struct {
    Command   string    `json:"command"`    // e.g. "deploy"
    Args      []string  `json:"args"`       // positional arguments
    TriggerID string    `json:"trigger_id"` // 3-second response window token
    ChannelID string    `json:"channel_id"`
    UserID    string    `json:"user_id"`
    WsID      string    `json:"workspace_id"`
    Ts        time.Time `json:"timestamp"`
}

func (e *SlashCommandEvent) EventType() string   { return "slash_command" }
func (e *SlashCommandEvent) WorkspaceID() string { return e.WsID }
func (e *SlashCommandEvent) Timestamp() time.Time { return e.Ts }
```

**Important**: The `TriggerID` is valid for **3 seconds**. The bot must respond within this window; otherwise the client displays a "Bot did not respond" error. Use `bot.SendMessage` with the same channel — the server automatically links the response to the slash command invocation.

### 5.7 Bot Lifecycle Events

```go
type BotInstalledEvent struct {
    InstalledBy string    `json:"installed_by"`
    WsID        string    `json:"workspace_id"`
    Ts          time.Time `json:"timestamp"`
}

func (e *BotInstalledEvent) EventType() string   { return "bot_installed" }
func (e *BotInstalledEvent) WorkspaceID() string { return e.WsID }
func (e *BotInstalledEvent) Timestamp() time.Time { return e.Ts }

type BotUninstalledEvent struct {
    UninstalledBy string    `json:"uninstalled_by"`
    WsID          string    `json:"workspace_id"`
    Ts            time.Time `json:"timestamp"`
}

func (e *BotUninstalledEvent) EventType() string   { return "bot_uninstalled" }
func (e *BotUninstalledEvent) WorkspaceID() string { return e.WsID }
func (e *BotUninstalledEvent) Timestamp() time.Time { return e.Ts }
```

---

## 6. Slash Command Framework

Slash commands follow the format `/botname command [args...]`. The server parses the message text, resolves the target bot, verifies the command is declared in the bot's manifest, and dispatches a `slash_command` event.

### 6.1 Command Manifest

Every bot declares its commands at construction time via `BotOptions.Manifest`:

```go
type BotManifest struct {
    Name        string          `json:"name"`         // max 50 characters
    Description string          `json:"description"`  // max 500 characters
    Commands    []BotCommand    `json:"commands"`     // max 50 commands
    Scopes      []string        `json:"scopes"`       // required permission scopes
    IconURL     string          `json:"icon_url,omitempty"`
}

type BotCommand struct {
    Name        string         `json:"name"`         // ^[a-z][a-z0-9_-]{0,31}$
    Description string         `json:"description"`  // max 100 characters
    Usage       string         `json:"usage,omitempty"` // e.g. "/weather <city>"
    Args        []CommandArg   `json:"args,omitempty"`
}

type CommandArg struct {
    Name        string `json:"name"`
    Description string `json:"description"`
    Required    bool   `json:"required"`
    Type        string `json:"type"` // "string" | "number" | "user" | "channel"
}
```

**Example manifest:**

```go
nexus.BotManifest{
    Name:        "Weather Bot",
    Description: "Provides real-time weather information for cities worldwide.",
    Commands: []nexus.BotCommand{
        {
            Name:        "weather",
            Description: "Get current weather for a city",
            Usage:       "/weather <city>",
            Args: []nexus.CommandArg{
                {Name: "city", Description: "City name (e.g. Tokyo, London)", Required: true, Type: "string"},
            },
        },
        {
            Name:        "forecast",
            Description: "Get 5-day forecast for a city",
            Usage:       "/forecast <city>",
            Args: []nexus.CommandArg{
                {Name: "city", Description: "City name", Required: true, Type: "string"},
            },
        },
    },
    Scopes: []string{"messages:write", "commands"},
}
```

### 6.2 Command Handler Registration

The SDK provides a convenience method that registers a handler specifically for slash commands:

```go
func (b *Bot) OnCommand(command string, handler SlashCommandHandler)

type SlashCommandHandler func(ctx context.Context, cmd SlashCommandEvent) error
```

This is syntactic sugar over `bot.On("slash_command", ...)` with a built-in command name filter:

```go
bot.OnCommand("weather", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
    city := evt.Args[0]
    report := fetchWeather(city)
    return bot.SendMessage(ctx, evt.ChannelID, report)
})

bot.OnCommand("forecast", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
    city := evt.Args[0]
    report := fetchForecast(city)
    return bot.SendMessage(ctx, evt.ChannelID, report)
})
```

### 6.3 Argument Parsing

`Args` is a `[]string` populated by the server-side parser which handles quoted arguments:

```
/deploy "service-cart" staging    →  Args = ["service-cart", "staging"]
/poll "Lunch?" "Pizza" "Sushi"   →  Args = ["Lunch?", "Pizza", "Sushi"]
```

Validate required argument counts in your handler:

```go
bot.OnCommand("deploy", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
    if len(evt.Args) < 2 {
        return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID,
            "Usage: /deploy <service> <environment>")
    }
    service := evt.Args[0]
    env     := evt.Args[1]
    // ...
    return nil
})
```

### 6.4 E2E Channel Constraint

Slash commands for bots are **fully disabled** in end-to-end encrypted channels. The server rejects any slash-command invocation targeting a bot in an encrypted channel with error `e2e_bots_disabled`. The client also disables the slash-command autocomplete UI in E2E channels, so your bot will never receive a `slash_command` event from one.

---

## 7. Error Handling

### 7.1 Custom Error Types

The SDK defines sentinel errors and custom error types for typical failure scenarios:

```go
var (
    // ErrAuth is returned when the bot token is rejected (invalid, revoked, or expired).
    // This error is non-retryable — reconnection will NOT be attempted.
    ErrAuth = errors.New("nexus: authentication failed")

    // ErrRateLimit is returned when the server returns 429 and the SDK's own
    // retry-after pause has been exhausted and the context deadline has passed.
    ErrRateLimit = errors.New("nexus: rate limited")

    // ErrConnection is returned for WebSocket-level failures (dial timeout,
    // unexpected close, protocol error).
    ErrConnection = errors.New("nexus: connection failed")

    // ErrTimeout is returned when a handshake, API call, or handler exceeds the
    // context deadline.
    ErrTimeout = errors.New("nexus: operation timed out")

    // ErrDisconnected is returned when an API call is attempted while the bot
    // is not connected.
    ErrDisconnected = errors.New("nexus: not connected")
)
```

### 7.2 Error Inspection

Use `errors.Is` and `errors.As` for programmatic inspection:

```go
if errors.Is(err, nexus.ErrAuth) {
    log.Println("Token is invalid — check your bot token in the Nexus admin panel")
    os.Exit(1)
}

var apiErr *nexus.APIError
if errors.As(err, &apiErr) {
    fmt.Printf("Server error %d: %s\n", apiErr.Code, apiErr.Message)
}

if nexus.IsRetryable(err) {
    // can retry
}
```

### 7.3 Retryable vs Non-Retryable

```go
type NexusError struct {
    Code    string `json:"code"`     // machine-readable code: "e2e_bots_disabled", "scope_denied", "channel_not_found"
    Message string `json:"message"`  // human-readable description
    Status  int    `json:"status"`   // HTTP status code
}

func (e *NexusError) Error() string { return fmt.Sprintf("nexus: [%s] %s", e.Code, e.Message) }

func IsRetryable(err error) bool
```

`IsRetryable` returns `true` for transient failures (network timeouts, 5xx responses) and `false` for permanent failures (auth errors, 4xx, scope denied).

### 7.4 Server-Reported Errors

API calls may return a `*NexusError` with a structured machine-readable `Code`:

| Code                 | Meaning                                | Retryable |
|----------------------|----------------------------------------|-----------|
| `invalid_token`      | Token format or database hash lookup failed | No        |
| `token_expired`      | Token has been manually revoked        | No        |
| `scope_denied`       | Bot lacks the required permission scope| No        |
| `channel_not_found`  | Channel does not exist or bot not in it| No        |
| `e2e_bots_disabled`  | Operation blocked in E2E channel       | No        |
| `rate_limited`       | Too many requests; check `Retry-After` | Yes       |
| `internal_error`     | Server-side fault                      | Yes       |
| `service_unavailable`| Relay or DB temporarily down           | Yes       |

---

## 8. Reconnection

### 8.1 Exponential Backoff with Jitter

The SDK implements the same exponential backoff algorithm as the TypeScript SDK (see [Design §3.5](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#35-auto-reconnect-sdk-responsibility)), adapted for Go:

```go
type reconnectManager struct {
    config  ReconnectConfig
    attempt int
    mu      sync.Mutex
    timer   *time.Timer
}

func (rm *reconnectManager) schedule(ctx context.Context, connect func() error) {
    rm.mu.Lock()
    if rm.config.MaxRetries > 0 && rm.attempt >= rm.config.MaxRetries {
        rm.mu.Unlock()
        return // Give up — Connect() will return the last error
    }

    delay := time.Duration(float64(rm.config.InitialDelay) * math.Pow(2, float64(rm.attempt)))
    if delay > rm.config.MaxDelay {
        delay = rm.config.MaxDelay
    }
    if rm.config.Jitter {
        delay = time.Duration(float64(delay) * (0.5 + rand.Float64()*0.5))
    }
    rm.attempt++
    rm.mu.Unlock()

    rm.timer = time.AfterFunc(delay, func() {
        if err := connect(); err != nil {
            rm.schedule(ctx, connect) // retry
        } else {
            rm.mu.Lock()
            rm.attempt = 0 // Reset on success
            rm.mu.Unlock()
        }
    })
}

func (rm *reconnectManager) reset() {
    rm.mu.Lock()
    defer rm.mu.Unlock()
    rm.attempt = 0
    if rm.timer != nil {
        rm.timer.Stop()
    }
}
```

**Backoff schedule** (default config: `InitialDelay` = 1 s, `MaxDelay` = 30 s, `Jitter` = true):

| Attempt | Delay (with jitter range) |
|---------|---------------------------|
| 1st     | 0.5 – 1.0 s               |
| 2nd     | 1.0 – 2.0 s               |
| 3rd     | 2.0 – 4.0 s               |
| 4th     | 4.0 – 8.0 s               |
| 5th     | 8.0 – 16.0 s              |
| 6th+    | 15.0 – 30.0 s             |

### 8.2 State Transitions

During reconnection, the bot's public state transitions as follows:

| State | `IsConnected()` | Handlers invoked? | API calls accepted? |
|-------|-----------------|-------------------|---------------------|
| CONNECTING | `false` | No | Buffered (up to 64; older dropped) |
| AUTHENTICATING | `false` | No | Buffered |
| SUBSCRIBED | `false` | No | Buffered |
| ACTIVE | `true` | Yes | Yes |
| DISCONNECTED | `false` | No | Return `ErrDisconnected` |

Once reconnection succeeds and the bot returns to ACTIVE, handlers begin receiving events again. There is no event replay — events that occurred during the disconnected window are **not** redelivered.

### 8.3 Heartbeat

The SDK sends a WebSocket `PING` frame every `HeartbeatInterval` (default 25 s). The server responds with a `PONG`. If no `PONG` is received within 2× the heartbeat interval (60 s), the SDK considers the connection dead and initiates reconnection.

---

## 9. Structured Logging with `slog`

The SDK integrates with Go's `log/slog` package (Go 1.21+). Pass your own `*slog.Logger` via `BotOptions.Logger`; if omitted, `slog.Default()` is used.

**Internal SDK log records** (all at `Debug` or `Info` level unless they represent real problems):

```go
logger.Debug("connecting to gateway", "url", gatewayURL)
logger.Info("authenticated", "session_id", sessionID)
logger.Debug("event received", "type", evt.EventType(), "channel_id", channelID)
logger.Warn("handler returned error", "type", evt.EventType(), "error", err)
logger.Error("reconnect exhausted", "attempts", attempt, "last_error", err)
logger.Debug("api call", "method", "sendMessage", "channel_id", channelID)
logger.Warn("rate limited by server", "retry_after_sec", retryAfter)
logger.Info("reconnecting", "attempt", attempt, "delay_ms", delayMs)
logger.Info("connected", "gateway_url", gatewayURL)
logger.Info("disconnecting", "reason", reason)
```

**Example — application-level structured logging:**

```go
func main() {
    handler := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})
    logger := slog.New(handler)

    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
        Logger:     logger,
    })
    if err != nil {
        logger.Error("failed to create bot", "error", err)
        os.Exit(1)
    }

    bot.On("message", func(ctx context.Context, evt nexus.Event) error {
        msg := evt.(*nexus.MessageEvent)
        logger.Info("message received",
            "text", msg.Text,
            "user_id", msg.UserID,
            "channel_id", msg.ChannelID,
        )
        return nil
    })

    if err := bot.Connect(context.Background()); err != nil {
        logger.Error("bot exited with error", "error", err)
        os.Exit(1)
    }
}
```

---

## 10. Complete Examples

### 10.1 Echo Bot

Replies to every message with its own content. Demonstrates the minimal viable bot.

```go
package main

import (
    "context"
    "log"
    "os"

    nexus "github.com/nexus-chat/bot-sdk-go"
)

func main() {
    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
        Manifest: nexus.BotManifest{
            Name:        "Echo",
            Description: "Echoes back everything you say.",
            Scopes:      []string{"messages:read", "messages:write"},
        },
    })
    if err != nil {
        log.Fatal(err)
    }

    bot.On("message", func(ctx context.Context, evt nexus.Event) error {
        msg := evt.(*nexus.MessageEvent)

        // Don't echo bot's own messages.
        if msg.UserID == bot.ID() {
            return nil
        }

        return bot.SendMessage(ctx, msg.ChannelID, "You said: "+msg.Text,
            nexus.WithThreadID(msg.ThreadID),
        )
    })

    log.Fatal(bot.Connect(context.Background()))
}
```

### 10.2 Poll Bot

Creates simple polls via slash command. Demonstrates slash command handling and Block Kit messages.

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "strings"

    nexus "github.com/nexus-chat/bot-sdk-go"
)

func main() {
    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
        Manifest: nexus.BotManifest{
            Name:        "Poll Bot",
            Description: "Create quick polls in channels.",
            Commands: []nexus.BotCommand{
                {
                    Name:        "poll",
                    Description: "Create a poll",
                    Usage:       "/poll \"Question\" \"Option A\" \"Option B\" [\"Option C\" ...]",
                    Args: []nexus.CommandArg{
                        {Name: "question", Description: "The poll question", Required: true, Type: "string"},
                        {Name: "options", Description: "At least 2 options", Required: true, Type: "string"},
                    },
                },
            },
            Scopes: []string{"messages:write", "commands"},
        },
    })
    if err != nil {
        log.Fatal(err)
    }

    bot.OnCommand("poll", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
        if len(evt.Args) < 3 {
            return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID,
                "Usage: `/poll \"Question\" \"Option A\" \"Option B\" ...`")
        }

        question := evt.Args[0]
        options  := evt.Args[1:]

        blocks := []nexus.Block{
            {
                Type: "section",
                Text: &nexus.BlockText{Type: "mrkdwn", Text: fmt.Sprintf(":bar_chart: *%s*", question)},
            },
        }

        for i, opt := range options {
            blocks = append(blocks, nexus.Block{
                Type: "section",
                Text: &nexus.BlockText{Type: "mrkdwn", Text: fmt.Sprintf("%d. %s", i+1, opt)},
            })
        }

        return bot.SendMessage(ctx, evt.ChannelID, "",
            nexus.WithBlocks(blocks),
        )
    })

    // Handle button clicks for voting (poll_vote action).
    bot.On("button_clicked", func(ctx context.Context, evt nexus.Event) error {
        btn := evt.(*nexus.ButtonClickedEvent)
        if !strings.HasPrefix(btn.ActionID, "poll_vote_") {
            return nil
        }
        // Increment vote count in your data store...
        return bot.SendEphemeral(ctx, btn.ChannelID, btn.UserID,
            fmt.Sprintf(":white_check_mark: Vote recorded for option %s", btn.Value))
    })

    log.Fatal(bot.Connect(context.Background()))
}
```

### 10.3 CI/CD Bot

A deployment notification bot that listens for webhooks from external CI systems and posts styled status updates. Demonstrates HTTP ingestion → Nexus message flow, middleware, and rich Block Kit usage.

```go
package main

import (
    "context"
    "encoding/json"
    "fmt"
    "log"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "sync"
    "time"

    nexus "github.com/nexus-chat/bot-sdk-go"
)

type DeployEvent struct {
    Service     string `json:"service"`
    Environment string `json:"environment"`
    Version     string `json:"version"`
    Status      string `json:"status"` // "success" | "failed" | "in_progress"
    CommitSHA   string `json:"commit_sha"`
    BuildURL    string `json:"build_url"`
    TriggeredBy string `json:"triggered_by"`
}

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
        Logger:     logger,
        Manifest: nexus.BotManifest{
            Name:        "Deploy Bot",
            Description: "Posts deployment status updates from CI/CD pipelines.",
            Commands: []nexus.BotCommand{
                {
                    Name:        "deploy",
                    Description: "Trigger a deployment",
                    Usage:       "/deploy <service> <environment>",
                    Args: []nexus.CommandArg{
                        {Name: "service", Description: "Service name", Required: true, Type: "string"},
                        {Name: "environment", Description: "Target environment", Required: true, Type: "string"},
                    },
                },
            },
            Scopes: []string{"messages:read", "messages:write", "commands", "channels:read"},
        },
    })
    if err != nil {
        log.Fatal(err)
    }

    // Channel monitor map: track which channels care about which services.
    var (
        channelSubs   = make(map[string]map[string]bool) // channelID -> set of service names
        channelSubsMu sync.RWMutex
    )

    // Slash command: subscribe channel to a service's deployments.
    bot.OnCommand("deploy", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
        if len(evt.Args) < 2 {
            return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID,
                "Usage: /deploy <service> <environment>")
        }
        service := evt.Args[0]
        env     := evt.Args[1]

        channelSubsMu.Lock()
        if channelSubs[evt.ChannelID] == nil {
            channelSubs[evt.ChannelID] = make(map[string]bool)
        }
        channelSubs[evt.ChannelID][service] = true
        channelSubsMu.Unlock()

        return bot.SendMessage(ctx, evt.ChannelID,
            fmt.Sprintf(":white_check_mark: This channel will now receive deployment notifications for *%s* (%s)", service, env))
    })

    // HTTP endpoint for CI systems to POST deployment events.
    http.HandleFunc("/webhook/deploy", func(w http.ResponseWriter, r *http.Request) {
        var ev DeployEvent
        if err := json.NewDecoder(r.Body).Decode(&ev); err != nil {
            http.Error(w, "invalid payload", 400)
            return
        }
        defer r.Body.Close()

        logger.Info("deployment event received",
            "service", ev.Service,
            "status", ev.Status,
            "version", ev.Version,
        )

        blocks := buildDeployBlocks(ev)

        channelSubsMu.RLock()
        defer channelSubsMu.RUnlock()

        for channelID, services := range channelSubs {
            for svc := range services {
                if svc == ev.Service || svc == "*" {
                    go func(ch string) {
                        ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
                        defer cancel()
                        if sendErr := bot.SendMessage(ctx, ch, "", nexus.WithBlocks(blocks)); sendErr != nil {
                            logger.Error("failed to send deploy notification", "channel", ch, "error", sendErr)
                        }
                    }(channelID)
                }
            }
        }

        w.WriteHeader(202)
        json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
    })

    // Start HTTP server.
    go func() {
        addr := ":8080"
        logger.Info("CI webhook listener", "addr", addr)
        if err := http.ListenAndServe(addr, nil); err != nil {
            logger.Error("http server", "error", err)
        }
    }()

    ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, os.Kill)
    defer cancel()

    if err := bot.Connect(ctx); err != nil {
        logger.Error("bot exited", "error", err)
    }
}

func buildDeployBlocks(ev DeployEvent) []nexus.Block {
    statusEmoji := map[string]string{
        "success":     ":white_check_mark:",
        "failed":      ":x:",
        "in_progress": ":hourglass_flowing_sand:",
    }[ev.Status]

    return []nexus.Block{
        {
            Type: "section",
            Text: &nexus.BlockText{Type: "mrkdwn", Text: fmt.Sprintf(
                "%s *Deployment %s*\n*Service:* `%s`\n*Environment:* `%s`\n*Version:* `%s`\n*Commit:* `%s`\n*Triggered by:* %s",
                statusEmoji, ev.Status, ev.Service, ev.Environment, ev.Version, ev.CommitSHA[:8], ev.TriggeredBy,
            )},
        },
        {
            Type: "actions",
            Elements: []nexus.BlockElement{
                {Type: "button", ActionID: "view_build", Text: nexus.BlockText{Type: "plain_text", Text: "View Build"}, Value: ev.BuildURL},
                {Type: "button", ActionID: "deploy_rollback", Text: nexus.BlockText{Type: "plain_text", Text: "Rollback"}, Style: "danger", Value: ev.Service},
            },
        },
    }
}
```

### 10.4 Kubernetes Operator Bot

A bot that queries a Kubernetes cluster and reports pod status in response to slash commands. Demonstrates integration with an external API, context propagation with deadlines, and structured error responses.

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "strings"
    "time"

    nexus "github.com/nexus-chat/bot-sdk-go"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
    "k8s.io/client-go/tools/clientcmd"
)

func main() {
    // Load kubeconfig.
    kubeconfig := os.Getenv("KUBECONFIG")
    config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
    if err != nil {
        log.Fatalf("kubeconfig: %v", err)
    }
    clientset, err := kubernetes.NewForConfig(config)
    if err != nil {
        log.Fatalf("clientset: %v", err)
    }

    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
        Manifest: nexus.BotManifest{
            Name:        "Kube Bot",
            Description: "Query Kubernetes clusters from Nexus Chat.",
            Commands: []nexus.BotCommand{
                {
                    Name:        "pods",
                    Description: "List pods in a namespace",
                    Usage:       "/pods <namespace>",
                    Args: []nexus.CommandArg{
                        {Name: "namespace", Description: "Kubernetes namespace", Required: true, Type: "string"},
                    },
                },
                {
                    Name:        "deployments",
                    Description: "List deployments in a namespace",
                    Usage:       "/deployments <namespace>",
                    Args: []nexus.CommandArg{
                        {Name: "namespace", Description: "Kubernetes namespace", Required: true, Type: "string"},
                    },
                },
            },
            Scopes: []string{"messages:write", "commands"},
        },
    })
    if err != nil {
        log.Fatal(err)
    }

    bot.OnCommand("pods", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
        return handlePods(ctx, bot, evt, clientset)
    })

    bot.OnCommand("deployments", func(ctx context.Context, evt nexus.SlashCommandEvent) error {
        return handleDeployments(ctx, bot, evt, clientset)
    })

    log.Fatal(bot.Connect(context.Background()))
}

func handlePods(ctx context.Context, bot *nexus.Bot, evt nexus.SlashCommandEvent, cs *kubernetes.Clientset) error {
    if len(evt.Args) < 1 {
        return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID, "Usage: /pods <namespace>")
    }
    namespace := evt.Args[0]

    // Create a sub-context with a 3-second deadline for the K8s API call.
    kctx, cancel := context.WithTimeout(ctx, 3*time.Second)
    defer cancel()

    pods, err := cs.CoreV1().Pods(namespace).List(kctx, metav1.ListOptions{Limit: 20})
    if err != nil {
        return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID,
            fmt.Sprintf(":x: Failed to list pods in `%s`: %v", namespace, err))
    }

    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("*Pods in `%s`* (%d total):\n", namespace, len(pods.Items)))
    for _, pod := range pods.Items {
        status := string(pod.Status.Phase)
        statusEmoji := ":white_check_mark:"
        if pod.Status.Phase != "Running" && pod.Status.Phase != "Succeeded" {
            statusEmoji = ":warning:"
        }
        ready := "0/0"
        if len(pod.Status.ContainerStatuses) > 0 {
            readyCount := 0
            for _, cs := range pod.Status.ContainerStatuses {
                if cs.Ready {
                    readyCount++
                }
            }
            ready = fmt.Sprintf("%d/%d", readyCount, len(pod.Status.ContainerStatuses))
        }
        age := time.Since(pod.CreationTimestamp.Time).Truncate(time.Second)
        sb.WriteString(fmt.Sprintf("%s `%s` — %s | Ready: %s | Age: %s\n",
            statusEmoji, pod.Name, status, ready, age))
    }

    return bot.SendMessage(ctx, evt.ChannelID, sb.String())
}

func handleDeployments(ctx context.Context, bot *nexus.Bot, evt nexus.SlashCommandEvent, cs *kubernetes.Clientset) error {
    if len(evt.Args) < 1 {
        return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID, "Usage: /deployments <namespace>")
    }
    namespace := evt.Args[0]

    kctx, cancel := context.WithTimeout(ctx, 3*time.Second)
    defer cancel()

    deps, err := cs.AppsV1().Deployments(namespace).List(kctx, metav1.ListOptions{Limit: 20})
    if err != nil {
        return bot.SendEphemeral(ctx, evt.ChannelID, evt.UserID,
            fmt.Sprintf(":x: Failed to list deployments in `%s`: %v", namespace, err))
    }

    var sb strings.Builder
    sb.WriteString(fmt.Sprintf("*Deployments in `%s`* (%d total):\n", namespace, len(deps.Items)))
    for _, dep := range deps.Items {
        replicas := fmt.Sprintf("%d/%d", dep.Status.ReadyReplicas, dep.Status.Replicas)
        if dep.Status.ReadyReplicas == dep.Status.Replicas {
            sb.WriteString(fmt.Sprintf(":white_check_mark: `%s` — %s\n", dep.Name, replicas))
        } else {
            sb.WriteString(fmt.Sprintf(":warning: `%s` — %s\n", dep.Name, replicas))
        }
    }

    return bot.SendMessage(ctx, evt.ChannelID, sb.String())
}
```

### 10.5 Moderation Bot with Middleware

A bot that enforces content policies using middleware and a keyword filter. Demonstrates the middleware pipeline, `SendEphemeral`, and `DeleteMessage`.

```go
package main

import (
    "context"
    "fmt"
    "log"
    "log/slog"
    "os"
    "strings"
    "sync"
    "time"

    nexus "github.com/nexus-chat/bot-sdk-go"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

    bot, err := nexus.NewBot(nexus.BotOptions{
        Token:      os.Getenv("NEXUS_BOT_TOKEN"),
        GatewayURL: "wss://gateway.nexus.chat/bot-ws",
        Logger:     logger,
        Manifest: nexus.BotManifest{
            Name:        "Moderation Bot",
            Description: "Enforces content policies with keyword filtering.",
            Scopes:      []string{"messages:read", "messages:write"},
        },
    })
    if err != nil {
        log.Fatal(err)
    }

    // ── Rate-limit tracker (simplistic in-memory; use Redis in production) ──
    type userWindow struct {
        counts []time.Time
    }
    var (
        userLimits   = make(map[string]*userWindow)
        userLimitsMu sync.Mutex
        maxPerMinute = 10
    )

    // ── Middleware chain ──

    // 1. Rate-limit middleware — drop messages from users sending > N msg/min.
    bot.Use(func(ctx context.Context, evt nexus.Event, next nexus.Handler) error {
        msg, ok := evt.(*nexus.MessageEvent)
        if !ok {
            return next(ctx, evt)
        }

        userLimitsMu.Lock()
        uw, exists := userLimits[msg.UserID]
        if !exists {
            uw = &userWindow{}
            userLimits[msg.UserID] = uw
        }

        now := time.Now()
        cutoff := now.Add(-1 * time.Minute)
        valid := uw.counts[:0]
        for _, t := range uw.counts {
            if t.After(cutoff) {
                valid = append(valid, t)
            }
        }
        uw.counts = append(valid, now)
        userLimitsMu.Unlock()

        if len(uw.counts) > maxPerMinute {
            logger.Warn("rate-limited user", "user_id", msg.UserID, "count", len(uw.counts))
            return nil // silently drop
        }

        return next(ctx, evt)
    })

    // 2. Keyword filter middleware.
    blockedWords := map[string]bool{
        "spamword1": true,
        "spamword2": true,
    }

    bot.Use(func(ctx context.Context, evt nexus.Event, next nexus.Handler) error {
        msg, ok := evt.(*nexus.MessageEvent)
        if !ok {
            return next(ctx, evt)
        }

        for _, word := range strings.Fields(msg.Text) {
            if blockedWords[strings.ToLower(word)] {
                // Delete the offending message.
                if err := bot.DeleteMessage(ctx, msg.ChannelID, msg.ID); err != nil {
                    logger.Error("failed to delete offending message", "error", err)
                }
                // Warn the user privately.
                _ = bot.SendEphemeral(ctx, msg.ChannelID, msg.UserID,
                    ":no_entry_sign: Your message was removed because it contained prohibited content.")
                logger.Info("message moderated",
                    "user_id", msg.UserID,
                    "channel_id", msg.ChannelID,
                    "word", word,
                )
                return nil // do not pass to next handler
            }
        }
        return next(ctx, evt)
    })

    // ── Handlers ──

    bot.On("message", func(ctx context.Context, evt nexus.Event) error {
        msg := evt.(*nexus.MessageEvent)
        logger.Debug("message passed moderation",
            "user_id", msg.UserID,
            "text_len", len(msg.Text),
        )
        return nil
    })

    log.Fatal(bot.Connect(context.Background()))
}
```

---

## 11. Connection Security

| Property | Detail |
|----------|--------|
| **Transport** | `wss://` — TLS 1.3 WebSocket |
| **Token format** | `nxbot_v1_<base64url(random_32_bytes)>` |
| **Token storage** | Never logged; redacted in error messages. Store in environment variables or a secrets manager. |
| **Server auth** | Server validates prefix/version, hashes the token, and resolves `SHA256(token)` in the database before the `connected` frame. |
| **E2E channels** | Bots are excluded from E2E-encrypted channels at the routing layer. No event from an encrypted channel enters the bot dispatch path. |
| **Scope enforcement** | Every API call is validated against the bot's declared scopes. |

Never hardcode tokens in source code. Use `os.Getenv`, a `.env` file (loaded via `godotenv`), or a dedicated secrets manager (Vault, AWS Secrets Manager, GCP Secret Manager).

---

## 12. Performance Tuning

| Knob | Default | Guidance |
|------|---------|----------|
| `HeartbeatInterval` | 25 s | Reduce to 15 s in high-churn network environments. |
| `RateLimitConfig.MaxPerMinute` | 120 | Adjust based on your workspace plan. The server enforces a hard cap per bot (see [Design §8.3](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#83-two-tier-rate-limiting)). |
| Handler goroutines | 1 per event type | Keep handlers non-blocking. Offload CPU-intensive or I/O work to a worker pool. |
| Buffer size | 256 events per type | If your handler is slow, the buffer fills and newer events are dropped (logged as a warning). Scale horizontally by running multiple bot instances if needed. |
| `ReconnectConfig.MaxRetries` | 10 | Set to 0 for infinite retries in production. |
| `ReconnectConfig.MaxDelay` | 30 s | Capped to avoid connection storms. The server enforces a 10/s connection rate limit per workspace. |

---

## 13. Migration Guide (TypeScript → Go)

The Go SDK mirrors the TypeScript SDK design (see [Design §4](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#4-bot-sdk-design-typescript)) with idiomatic adaptations:

| Concept | TypeScript | Go |
|---------|------------|----|
| Constructor | `new NexusBot({ token, gatewayUrl })` | `nexus.NewBot(nexus.BotOptions{Token, GatewayURL})` |
| Event registration | `bot.on('message', handler)` | `bot.On("message", handler)` |
| Handler args | `(event: BotEvent.Message)` | `(ctx context.Context, evt nexus.Event)` |
| Type narrowing | `if (event.text === '/ping')` | `msg := evt.(*nexus.MessageEvent)` |
| Async API calls | `await bot.sendMessage(...)` | `bot.SendMessage(ctx, ...)` |
| Error handling | `catch (e)` / `instanceof` | `errors.Is(err, nexus.ErrAuth)` |
| Middleware | `bot.use((event, next) => ...)` | `bot.Use(func(ctx, evt, next) error { return next(ctx, evt) })` |
| Logger | Console (`console.log`) | `*slog.Logger` injected via `BotOptions` |
| Reconnection | Built-in, configurable | Built-in, configurable via `ReconnectConfig` |
| Context propagation | Implicit via closures | Explicit `context.Context` parameter |

**Key differences to internalise:**

1. Go handlers **must** type-assert `evt` to the concrete event struct (`*nexus.MessageEvent`). The TypeScript SDK narrows the type automatically via the `event.type` discriminant.
2. Go API calls accept `context.Context` as the first argument. Use the context passed into your handler — it carries the gateway's processing deadline.
3. Go uses explicit, checked error returns. Return an error from a handler to signal failure; return `nil` for success. The SDK logs non-nil handler errors at `Warn` level.
4. Go middleware uses the standard `(ctx, evt, next)` pattern. Call `next(ctx, evt)` to proceed; return early to short-circuit.

---

> **Related Documents**:
> - [Async Bot Engine & Event Dispatch Layer — Design](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)
> - [Bot Engine & Microservices — Research Report](../research/bot-engine-microservices.md)
> - [Long Connection & Core Gateway Layer — Design](../design/02_Long_Connection_and_Core_Gateway_Layer.md)
