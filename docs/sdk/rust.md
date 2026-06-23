---
lang: en
---

# nexus-bot-sdk &mdash; Rust Bot SDK

> nexus-chat · Slack-like IM application  
> SDK version: 0.1.0 · Minimum Rust version: 1.75  
> Design reference: [Async Bot Engine & Event Dispatch Layer](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)

---

## Table of Contents

1. [Package](#1-package)
2. [Quick Start](#2-quick-start)
3. [API Reference](#3-api-reference)
   - 3.1 [Constructor](#31-constructor)
   - 3.2 [Event Handlers](#32-event-handlers)
   - 3.3 [Context API](#33-context-api)
   - 3.4 [Direct API](#34-direct-api)
   - 3.5 [Connection Lifecycle](#35-connection-lifecycle)
   - 3.6 [Middleware](#36-middleware)
   - 3.7 [Rate Limiter](#37-rate-limiter)
   - 3.8 [Reconnect Strategy](#38-reconnect-strategy)
4. [Event Types](#4-event-types)
5. [Slash Command Registration](#5-slash-command-registration)
6. [Error Handling](#6-error-handling)
7. [Async Model](#7-async-model)
8. [Reconnection Strategy (Detailed)](#8-reconnection-strategy-detailed)
9. [Observability with `tracing`](#9-observability-with-tracing)
10. [Cargo Features](#10-cargo-features)
11. [Complete Examples](#11-complete-examples)
    - 11.1 [Echo Bot](#111-echo-bot)
    - 11.2 [Poll Bot](#112-poll-bot)
    - 11.3 [Actix-web Webhook Adapter](#113-actix-web-webhook-adapter)
    - 11.4 [CI/CD Bot](#114-cicd-bot)

---

## 1. Package

The `nexus-bot-sdk` crate provides an idiomatic, async-first Rust client for building bots on the nexus-chat platform. It communicates over WebSocket (default) or HTTP webhooks (opt-in feature flag), handles automatic reconnection, enforces client-side rate limiting, and offers a pluggable middleware pipeline.

### Crate &mdash; `Cargo.toml`

```toml
[dependencies]
nexus-bot-sdk = "0.1"
```

Or via the command line:

```bash
cargo add nexus-bot-sdk
```

### Minimum Supported Rust Version

**Rust 1.75+** is required. The SDK relies on:

| Dependency | Version | Purpose |
|---|---|---|
| `tokio` | 1.x | Async runtime, TCP/TLS, timers |
| `tokio-tungstenite` | 0.21 | WebSocket transport |
| `serde` / `serde_json` | 1.x | Event serialisation |
| `tracing` | 0.1 | Structured, async-aware logging |
| `thiserror` | 1.x | Ergonomic error derivation |
| `governor` | 0.6 | Token-bucket rate limiter |
| `tower` | 0.4 | Middleware layering |
| `futures-core` | 0.3 | `BoxFuture` type alias |
| `hmac` / `sha2` | 0.12 | Webhook signature verification |
| `jsonwebtoken` | 9 | JWT webhook payloads |
| `rand` | 0.8 | Jitter for exponential backoff |

### Crate Feature Flags

| Feature | Default | Description |
|---|---|---|
| `websocket` | **yes** | WebSocket transport (tokio-tungstenite) |
| `webhook` | no | Inbound webhook verification and server adapters |

---

## 2. Quick Start

```rust
use nexus_bot_sdk::{BotOptions, Event, NexusBot};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialise tracing subscriber (see §9 for details)
    tracing_subscriber::fmt()
        .with_env_filter("nexus_bot_sdk=info")
        .init();

    let bot = NexusBot::new(BotOptions {
        token: "nxbot_v1_xxxx".into(),
        gateway_url: "wss://gateway.nexus.chat/bot-ws".into(),
        ..Default::default()
    })?;

    bot.on("message", |ctx, event| {
        Box::pin(async move {
            if let Event::Message(msg) = event {
                if msg.text == "/ping" {
                    ctx.send_message(&msg.channel_id, "Pong!").await?;
                }
            }
            Ok(())
        })
    });

    bot.connect().await?;

    // Wait for CTRL+C
    tokio::signal::ctrl_c().await?;
    bot.disconnect().await?;

    Ok(())
}
```

### Handler Signature

Every event handler has the same type:

```rust
use std::future::Future;
use std::pin::Pin;

type HandlerFuture = Pin<Box<dyn Future<Output = Result<()>> + Send + 'static>>;

// Handler: Fn(Context, Event) -> HandlerFuture
```

Because Rust 1.75 stabilised `async fn` in traits, handlers can be written with `async move {}` blocks wrapped in `Box::pin(...)`.

---

## 3. API Reference

### 3.1 Constructor

```rust
/// Creates a new NexusBot instance.
///
/// # Errors
///
/// Returns `BotError::ConfigError` if the token format is invalid or
/// required TLS roots cannot be loaded.
pub fn new(options: BotOptions) -> Result<Self, BotError>
```

```rust
/// Options for constructing a NexusBot instance.
#[derive(Debug, Clone)]
pub struct BotOptions {
    /// Bot authentication token. Format: `nxbot_v1_<base64url>`.
    pub token: String,

    /// WebSocket gateway URL, e.g. `"wss://gateway.nexus.chat/bot-ws"`.
    pub gateway_url: String,

    /// Maximum reconnection attempts. Set to `0` for infinite retries.
    /// Default: `10`.
    pub max_reconnect_attempts: u32,

    /// Initial backoff delay in milliseconds.
    /// Default: `1000`.
    pub initial_backoff_ms: u64,

    /// Maximum backoff delay in milliseconds.
    /// Default: `30_000`.
    pub max_backoff_ms: u64,

    /// Enable jitter on backoff delays.
    /// Default: `true`.
    pub jitter: bool,

    /// Heartbeat interval in seconds. The SDK sends a `PING` frame at
    /// this interval. The server expects pings within 30 s.
    /// Default: `25`.
    pub heartbeat_interval_secs: u64,

    /// Client-side rate limit: maximum API calls per minute.
    /// Default: `120`.
    pub rate_limit_per_minute: u32,

    /// Additional HTTP headers sent during the WebSocket handshake.
    /// Default: empty.
    pub extra_headers: HashMap<String, String>,
}

impl Default for BotOptions {
    fn default() -> Self {
        Self {
            token: String::new(),
            gateway_url: String::new(),
            max_reconnect_attempts: 10,
            initial_backoff_ms: 1_000,
            max_backoff_ms: 30_000,
            jitter: true,
            heartbeat_interval_secs: 25,
            rate_limit_per_minute: 120,
            extra_headers: HashMap::new(),
        }
    }
}
```

### 3.2 Event Handlers

```rust
impl NexusBot {
    /// Registers a handler for the given event type.
    ///
    /// The `event_type` string matches the wire-format event key:
    /// `"message"`, `"message_edited"`, `"message_deleted"`,
    /// `"channel_created"`, `"channel_archived"`, `"member_joined"`,
    /// `"member_left"`, `"slash_command"`, `"button_clicked"`.
    ///
    /// Multiple handlers may be registered for the same event type;
    /// they execute sequentially within the event, in registration order.
    ///
    /// # Panics
    ///
    /// Panics if called after `connect()` has been called.
    pub fn on<F>(&mut self, event_type: &str, handler: F) -> &mut Self
    where
        F: Fn(Context, Event) -> HandlerFuture + Send + Sync + 'static;

    /// Removes all handlers for the given event type.
    pub fn off(&mut self, event_type: &str) -> &mut Self;

    /// Removes all registered handlers.
    pub fn clear_handlers(&mut self) -> &mut Self;
}
```

### 3.3 Context API

The `Context` struct is passed to every handler and provides a scoped API surface:

```rust
/// Per-event execution context.
///
/// All methods respect the bot's configured rate limiter and
/// forward calls through the active WebSocket connection.
pub struct Context {
    // (internal fields omitted)
}

impl Context {
    /// Sends a message to a channel.
    ///
    /// Returns the created `Message` with its server-assigned ID.
    pub async fn send_message(
        &self,
        channel_id: &str,
        text: &str,
    ) -> Result<Message, BotError>;

    /// Sends a message with optional thread and block attachments.
    pub async fn send_message_with_opts(
        &self,
        channel_id: &str,
        text: &str,
        opts: SendMessageOpts<'_>,
    ) -> Result<Message, BotError>;

    /// Edits an existing message.
    ///
    /// Only messages authored by this bot may be edited.
    pub async fn edit_message(
        &self,
        channel_id: &str,
        message_id: &str,
        new_text: &str,
    ) -> Result<Message, BotError>;

    /// Deletes an existing message.
    ///
    /// Only messages authored by this bot may be deleted.
    pub async fn delete_message(
        &self,
        channel_id: &str,
        message_id: &str,
    ) -> Result<(), BotError>;

    /// Sends an ephemeral (visible-only-to-target-user) message.
    pub async fn send_ephemeral(
        &self,
        channel_id: &str,
        user_id: &str,
        text: &str,
    ) -> Result<(), BotError>;

    /// Retrieves metadata for a channel.
    pub async fn get_channel_info(
        &self,
        channel_id: &str,
    ) -> Result<Channel, BotError>;

    /// Retrieves the member list for a channel.
    ///
    /// Paginated; use `cursor` to fetch subsequent pages.
    pub async fn get_member_list(
        &self,
        channel_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<MemberList, BotError>;

    /// Creates a new channel in the workspace.
    ///
    /// Requires the `channels:manage` scope.
    pub async fn create_channel(
        &self,
        name: &str,
        is_private: bool,
    ) -> Result<Channel, BotError>;

    /// Archives a channel.
    ///
    /// Requires the `channels:manage` scope.
    pub async fn archive_channel(
        &self,
        channel_id: &str,
    ) -> Result<(), BotError>;
}

/// Options for `send_message_with_opts`.
#[derive(Debug, Default)]
pub struct SendMessageOpts<'a> {
    /// Reply to a thread.
    pub thread_id: Option<&'a str>,

    /// Rich layout blocks (buttons, sections, dividers).
    pub blocks: Option<&'a [Block]>,
}
```

### 3.4 Direct API

In addition to the handler-scoped `Context`, the `NexusBot` struct exposes the same methods directly. These are convenience wrappers that construct an internal context for ad-hoc calls outside event handlers.

```rust
impl NexusBot {
    /// Sends a message directly (not from within an event handler).
    pub async fn send_message(
        &self,
        channel_id: &str,
        text: &str,
    ) -> Result<Message, BotError>;

    /// Edits a message directly.
    pub async fn edit_message(
        &self,
        channel_id: &str,
        message_id: &str,
        new_text: &str,
    ) -> Result<Message, BotError>;

    /// Deletes a message directly.
    pub async fn delete_message(
        &self,
        channel_id: &str,
        message_id: &str,
    ) -> Result<(), BotError>;

    /// Retrieves channel info directly.
    pub async fn get_channel_info(
        &self,
        channel_id: &str,
    ) -> Result<Channel, BotError>;

    /// Retrieves member list directly.
    pub async fn get_member_list(
        &self,
        channel_id: &str,
        cursor: Option<&str>,
        limit: Option<u32>,
    ) -> Result<MemberList, BotError>;
}
```

### 3.5 Connection Lifecycle

```rust
impl NexusBot {
    /// Opens a WebSocket connection to the gateway, performs the
    /// identity handshake, subscribes to channels, and enters the
    /// event loop.
    ///
    /// This method blocks until the bot is fully active (state = `Active`).
    /// If the initial connection fails, it schedules a reconnect attempt.
    pub async fn connect(&self) -> Result<(), BotError>;

    /// Gracefully closes the WebSocket connection and stops the
    /// reconnect backoff timer. After calling this, `connect()` must
    /// be called again to resume operation.
    pub async fn disconnect(&self) -> Result<(), BotError>;

    /// Returns `true` if the underlying WebSocket is open and
    /// the connection state is `Active`.
    pub fn is_connected(&self) -> bool;

    /// Returns the current `ConnectionState`.
    pub fn connection_state(&self) -> ConnectionState;
}

/// Represents the bot's connection lifecycle.
///
/// State transitions follow the diagram in the design document
/// (§3.2 Connection Lifecycle).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    /// Initial state; `connect()` has not been called.
    Disconnected,

    /// TCP/TLS handshake and WebSocket upgrade in progress.
    Connecting,

    /// WebSocket is open; identity frame sent, awaiting server ack.
    Authenticating,

    /// Identity accepted; channel subscriptions are being transmitted.
    Subscribing,

    /// Fully active, receiving and processing events.
    Active,

    /// Connection dropped; reconnect backoff timer is running.
    Reconnecting,
}
```

### 3.6 Middleware

The SDK supports a Tower-inspired middleware pipeline. Middleware wraps each event handler invocation, enabling cross-cutting concerns such as logging, metrics, and custom permission checks.

```rust
/// A middleware is an async function that receives a `Context`,
/// the next handler in the chain, and the `Event`.
///
/// It may short-circuit (not call `next`), mutate the event or
/// context, or execute pre/post logic around `next`.
pub trait Middleware: Send + Sync {
    fn call<'a>(
        &'a self,
        ctx: &'a Context,
        event: &'a Event,
        next: Next<'a>,
    ) -> HandlerFuture;
}

/// Alias for the "next" function in the middleware chain.
pub type Next<'a> = Box<dyn FnOnce() -> HandlerFuture + Send + 'a>;

impl NexusBot {
    /// Registers a middleware layer.
    ///
    /// Middlewares are executed in registration order: the first
    /// registered middleware wraps all subsequent ones and the
    /// handler itself.
    pub fn use_middleware<M>(&mut self, middleware: M) -> &mut Self
    where
        M: Middleware + 'static;
}
```

#### Example: Logging Middleware

```rust
use nexus_bot_sdk::{Context, Event, HandlerFuture, Middleware, Next};
use tracing::info;

struct LoggingMiddleware;

impl Middleware for LoggingMiddleware {
    fn call<'a>(
        &'a self,
        ctx: &'a Context,
        event: &'a Event,
        next: Next<'a>,
    ) -> HandlerFuture {
        Box::pin(async move {
            info!(event_type = %event.type_str(), "Processing event");
            let result = next().await;
            if let Err(ref e) = result {
                tracing::error!(error = %e, "Event handler failed");
            }
            result
        })
    }
}
```

### 3.7 Rate Limiter

A token-bucket rate limiter runs client-side to smooth API call bursts before they reach the server. When the server returns `429 Too Many Requests`, the `Retry-After` header value is read and the limiter enters a global pause until that time has elapsed.

```rust
/// Token-bucket rate limiter backed by the `governor` crate.
///
/// Create once, clone cheaply (the underlying state is `Arc`-wrapped).
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<governor::RateLimiter<
        governor::state::direct::NotKeyed,
        governor::state::InMemoryState,
        governor::clock::QuantaClock,
        governor::middleware::NoOpMiddleware,
    >>,
}

impl RateLimiter {
    /// Creates a new limiter allowing `max_per_minute` calls per
    /// 60-second window.
    pub fn new(max_per_minute: u32) -> Self;

    /// Waits until a token is available. If the limiter has been
    /// globally paused due to a 429 response, waits until the pause
    /// lifts, then waits for a token.
    pub async fn wait(&self);

    /// Signals that the server returned a 429 and the limiter should
    /// pause all outgoing calls for `retry_after_secs` seconds.
    pub fn handle_429(&self, retry_after_secs: u64);
}
```

### 3.8 Reconnect Strategy

The `ReconnectManager` drives the exponential backoff loop. It is `Cancel`-safe: dropping the channel handle aborts the pending reconnect.

```rust
/// Manages reconnection with exponential backoff and jitter.
///
/// This is an internal type that `NexusBot` owns. It is exposed for
/// transparency but typically does not need direct use.
pub struct ReconnectManager {
    max_attempts: u32,
    initial_delay: Duration,
    max_delay: Duration,
    jitter: bool,
    attempt: AtomicU32,
    cancel_tx: tokio::sync::watch::Sender<bool>,
}

impl ReconnectManager {
    /// Creates a new `ReconnectManager`.
    pub fn new(config: ReconnectConfig) -> Self;

    /// Computes the delay for the next attempt and sleeps.
    ///
    /// Returns `None` if max attempts have been exhausted.
    pub async fn wait_before_attempt(&self) -> Option<()>;

    /// Resets the attempt counter on successful connection.
    pub fn reset(&self);

    /// Signals cancellation of any in-flight `wait_before_attempt` sleep.
    pub fn cancel(&self);
}

#[derive(Debug, Clone)]
pub struct ReconnectConfig {
    pub max_attempts: u32,   // 0 = infinite
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub jitter: bool,
}
```

---

## 4. Event Types

All event types are `serde`-derived enums and structs. The top-level `Event` enum is the entry point for all dispatched events.

```rust
use serde::{Deserialize, Serialize};

/// The top-level event enum.
///
/// Dispatched to handlers registered via `bot.on(event_type, handler)`.
/// The `event_type` string is produced by `Event::type_str()`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// A user sent a message in a subscribed channel.
    Message(MessageEvent),

    /// A user edited an existing message.
    MessageEdited(MessageEditedEvent),

    /// A user deleted a message.
    MessageDeleted(MessageDeletedEvent),

    /// A channel the bot is a member of was created.
    ChannelCreated(ChannelCreatedEvent),

    /// A channel the bot is a member of was archived.
    ChannelArchived(ChannelArchivedEvent),

    /// A user joined a subscribed channel.
    MemberJoined(MemberJoinedEvent),

    /// A user left a subscribed channel.
    MemberLeft(MemberLeftEvent),

    /// A user invoked a slash command targeting this bot.
    SlashCommand(SlashCommandEvent),

    /// A user clicked an interactive button from this bot.
    ButtonClicked(ButtonClickedEvent),
}

impl Event {
    /// Returns the event type string as sent on the wire, e.g. `"message"`.
    pub fn type_str(&self) -> &'static str {
        match self {
            Event::Message(_) => "message",
            Event::MessageEdited(_) => "message_edited",
            Event::MessageDeleted(_) => "message_deleted",
            Event::ChannelCreated(_) => "channel_created",
            Event::ChannelArchived(_) => "channel_archived",
            Event::MemberJoined(_) => "member_joined",
            Event::MemberLeft(_) => "member_left",
            Event::SlashCommand(_) => "slash_command",
            Event::ButtonClicked(_) => "button_clicked",
        }
    }
}

// ── Message ────────────────────────────────────────────────────────────────

/// Emitted when a user sends a message in a subscribed channel.
///
/// This is the most common event. Handlers can inspect `text`,
/// `mentions`, and `attachments` to decide how to respond.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEvent {
    /// Unique ID of the message.
    pub message_id: String,

    /// The channel where the message was sent.
    pub channel_id: String,

    /// ID of the user who sent the message.
    pub user_id: String,

    /// The plain-text content of the message.
    pub text: String,

    /// If this is a threaded reply, the ID of the parent message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,

    /// Users mentioned in the message (e.g. `<@U123>`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<Mention>,

    /// File attachments on the message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,

    /// ISO-8601 timestamp of when the message was created.
    pub timestamp: String,

    /// The idempotency key for this event: `{message_id}:message.created`.
    pub idempotency_key: String,
}

// ── Message Edited ─────────────────────────────────────────────────────────

/// Emitted when a user edits an existing message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEditedEvent {
    pub message_id: String,
    pub channel_id: String,
    pub user_id: String,

    /// The text before the edit.
    pub old_text: String,

    /// The text after the edit.
    pub new_text: String,

    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Message Deleted ────────────────────────────────────────────────────────

/// Emitted when a user deletes a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageDeletedEvent {
    pub message_id: String,
    pub channel_id: String,
    pub user_id: String,

    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Channel Created ────────────────────────────────────────────────────────

/// Emitted when a channel the bot belongs to is created.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCreatedEvent {
    /// The newly created channel's ID.
    pub channel_id: String,

    /// Name of the channel.
    pub name: String,

    /// ID of the user who created the channel.
    pub created_by: String,

    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Channel Archived ───────────────────────────────────────────────────────

/// Emitted when a channel the bot belongs to is archived.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArchivedEvent {
    pub channel_id: String,

    /// ID of the user who archived the channel.
    pub archived_by: String,

    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Member Joined ──────────────────────────────────────────────────────────

/// Emitted when a user joins a subscribed channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberJoinedEvent {
    pub channel_id: String,
    pub user_id: String,
    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Member Left ────────────────────────────────────────────────────────────

/// Emitted when a user leaves a subscribed channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberLeftEvent {
    pub channel_id: String,
    pub user_id: String,
    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Slash Command ──────────────────────────────────────────────────────────

/// Emitted when a user invokes a slash command targeting this bot.
///
/// The `trigger_id` is valid for 3 seconds; the bot must acknowledge
/// within that window. The `args` vector contains pre-parsed arguments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommandEvent {
    /// The command name, e.g. `"weather"`.
    pub command: String,

    /// Parsed arguments, e.g. `["tokyo"]` for `/weather tokyo`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,

    /// A short-lived ID for the invocation. Use with `respond_to_command()`.
    pub trigger_id: String,

    /// ID of the user who invoked the command.
    pub user_id: String,

    /// The channel where the command was typed.
    pub channel_id: String,

    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Button Clicked ─────────────────────────────────────────────────────────

/// Emitted when a user clicks an interactive button attached to a
/// message sent by this bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ButtonClickedEvent {
    /// The `action_id` assigned when the button was created.
    pub action_id: String,

    /// The value attached to the button when it was created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,

    /// ID of the message the button belongs to.
    pub message_id: String,

    /// ID of the user who clicked.
    pub user_id: String,

    /// ID of the channel.
    pub channel_id: String,

    pub timestamp: String,
    pub idempotency_key: String,
}

// ── Supporting Types ───────────────────────────────────────────────────────

/// A user mention within a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mention {
    /// The user ID referenced by the mention.
    pub user_id: String,

    /// Display name at the time the message was sent.
    pub display_name: String,
}

/// A file attachment on a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    /// Unique attachment ID.
    pub id: String,

    /// Original filename.
    pub filename: String,

    /// MIME type, e.g. `"image/png"`.
    pub mime_type: String,

    /// File size in bytes.
    pub size_bytes: u64,

    /// Download URL (requires authentication).
    pub url: String,

    /// If an image, thumbnail dimensions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<Thumbnail>,
}

/// Thumbnail metadata for image attachments.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thumbnail {
    pub width: u32,
    pub height: u32,
    pub url: String,
}

/// A channel as returned by `get_channel_info`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub is_private: bool,
    pub is_archived: bool,
    pub created_by: String,
    pub created_at: String,
}

/// A member entry returned by `get_member_list`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub user_id: String,
    pub display_name: String,
    pub role: MemberRole,
    pub joined_at: String,
}

/// Role of a member in a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberRole {
    Owner,
    Admin,
    Member,
    Guest,
}

/// Paginated member list result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberList {
    pub members: Vec<Member>,

    /// Opaque cursor for the next page. `None` means no more pages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// A message returned by `send_message` and `edit_message`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub user_id: String,
    pub text: String,
    pub created_at: String,
}

/// Rich layout blocks for message construction.
///
/// Used with `send_message_with_opts` to attach buttons and
/// structured layouts to messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    /// A text section.
    Section {
        /// Plain text or mrkdwn-formatted string.
        text: String,
    },

    /// A visual divider.
    Divider,

    /// An interactive button.
    Button {
        /// Unique action identifier. Received in `ButtonClickedEvent`.
        action_id: String,
        /// Button label text.
        text: String,
        /// Optional value payload sent with the click event.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        /// Button style variant.
        #[serde(default)]
        style: ButtonStyle,
    },
}

/// Visual style of a button block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonStyle {
    Default,
    Primary,
    Danger,
}

impl Default for ButtonStyle {
    fn default() -> Self {
        Self::Default
    }
}
```

---

## 5. Slash Command Registration

Bots declare their slash commands via a manifest. The manifest is sent to the server at registration time and defines every supported command with its arguments and usage hints.

```rust
use serde::{Deserialize, Serialize};

/// The bot's slash-command manifest.
///
/// Submitted during bot registration. Declares all commands the bot
/// can handle, along with the scopes it requires.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotManifest {
    /// Human-readable bot name (max 50 chars).
    pub name: String,

    /// Short description of the bot's purpose (max 500 chars).
    pub description: String,

    /// Registered commands (max 50).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<BotCommand>,

    /// Permission scopes required (e.g. `"messages:write"`, `"commands"`).
    pub scopes: Vec<String>,

    /// Connection mode: `"websocket"` (default) or `"webhook"`.
    /// Used only if the `webhook` feature is enabled.
    #[serde(default = "default_connection_mode")]
    pub connection_mode: ConnectionMode,

    /// Webhook URL (required when `connection_mode` is `"webhook"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook_url: Option<String>,

    /// Public URL to the bot's icon image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

fn default_connection_mode() -> ConnectionMode {
    ConnectionMode::WebSocket
}

/// A single slash command registered by the bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotCommand {
    /// Command name, e.g. `"weather"`. Must match `[a-z][a-z0-9_-]*`.
    pub name: String,

    /// Short description shown in autocomplete (max 100 chars).
    pub description: String,

    /// Usage hint, e.g. `"/weather <city>"` (max 200 chars).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,

    /// Argument specification for autocomplete and validation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<CommandArg>,
}

/// An argument to a slash command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandArg {
    /// Argument name (used in usage hints).
    pub name: String,

    /// Human-readable description of the argument.
    pub description: String,

    /// Whether this argument is required.
    #[serde(default)]
    pub required: bool,

    /// Expected type of the argument.
    #[serde(rename = "type")]
    pub arg_type: CommandArgType,
}

/// The type of a slash-command argument.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandArgType {
    String,
    Number,
    User,
    Channel,
}

/// Connection mode for the bot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode {
    WebSocket,
    Webhook,
}
```

### Manifest Builder

For convenience, the SDK provides a builder pattern:

```rust
use nexus_bot_sdk::manifest::{BotManifest, BotCommand, CommandArg, CommandArgType};

let manifest = BotManifest {
    name: "pollbot".into(),
    description: "Create and manage polls in channels.".into(),
    scopes: vec![
        "messages:read".into(),
        "messages:write".into(),
        "commands".into(),
        "interactions".into(),
    ],
    commands: vec![
        BotCommand {
            name: "poll".into(),
            description: "Create a new poll with options.".into(),
            usage: Some(r#"/poll "Question" "Option A" "Option B" ..."#.into()),
            args: vec![
                CommandArg {
                    name: "question".into(),
                    description: "The poll question.".into(),
                    required: true,
                    arg_type: CommandArgType::String,
                },
                CommandArg {
                    name: "options".into(),
                    description: "Poll options (2–10).".into(),
                    required: true,
                    arg_type: CommandArgType::String,
                },
            ],
        },
    ],
    ..Default::default()
};
```

---

## 6. Error Handling

All fallible operations in the SDK return `Result<T, BotError>`. `BotError` is a `thiserror`-derived enum with structured variants.

```rust
use thiserror::Error;

/// The unified error type for the nexus-bot-sdk.
#[derive(Debug, Error)]
pub enum BotError {
    /// Authentication failed (invalid token, expired, or revoked).
    #[error("authentication failed: {0}")]
    AuthError(String),

    /// The bot has been rate-limited. Check the `Retry-After` hint.
    #[error("rate limited: retry after {retry_after_secs}s")]
    RateLimitError {
        retry_after_secs: u64,
    },

    /// The WebSocket connection was lost or could not be established.
    #[error("connection error: {0}")]
    ConnectionError(String),

    /// An operation timed out.
    #[error("timeout: {0}")]
    TimeoutError(String),

    /// The server returned an API-level error.
    #[error("api error (code={code}): {message}")]
    ApiError {
        code: String,
        message: String,
    },

    /// The bot does not have the required scope.
    #[error("missing scope: {0}")]
    MissingScope(String),

    /// The bot is not authorised for the target channel.
    #[error("channel access denied: {0}")]
    ChannelAccessDenied(String),

    /// Invalid configuration (e.g. malformed token format).
    #[error("configuration error: {0}")]
    ConfigError(String),

    /// Serialisation or deserialisation failure.
    #[error("serialisation error: {0}")]
    SerializationError(#[from] serde_json::Error),

    /// Maximum reconnection attempts exceeded.
    #[error("reconnect exhausted after {attempts} attempts")]
    ReconnectExhausted {
        attempts: u32,
    },

    /// A method was called while the connection is not in the
    /// required state (e.g. `send_message` while `Disconnected`).
    #[error("invalid state ({current_state:?}): {reason}")]
    InvalidState {
        current_state: ConnectionState,
        reason: String,
    },
}

/// Convenience alias for results using `BotError`.
pub type Result<T> = std::result::Result<T, BotError>;
```

---

## 7. Async Model

The SDK is built entirely on `tokio`. All public async functions are `Send + Sync` safe, enabling use in multi-threaded runtimes.

### Runtime Requirements

```rust
// The SDK expects a Tokio multi-threaded runtime with the `full` feature set.
#[tokio::main]
async fn main() {
    // ...
}
```

### Send + Sync Guarantees

- `NexusBot` is `Send + Sync`. It can be shared across tasks via `Arc<NexusBot>`.
- `Context` is `Send + Sync`. It can be held across `.await` points inside handlers.
- `Event` and all event inner types are `Send + Sync`.
- `BotOptions` is `Send + Sync + Clone`.
- Handler closures must be `Send + Sync + 'static` because they are spawned as tasks.

### Handler Execution Model

Each incoming event is dispatched to its registered handler on a new `tokio::spawn` task. Multiple events of the same type may run concurrently. If sequential processing is required, implement a mutex or channel guard inside the handler.

```rust
// Sequential processing per channel via a tokio::sync::Mutex map:
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

let per_channel_lock: Arc<Mutex<HashMap<String, ()>>> = Arc::new(Mutex::new(HashMap::new()));

bot.on("message", move |ctx, event| {
    let lock = per_channel_lock.clone();
    Box::pin(async move {
        if let Event::Message(ref msg) = event {
            let _guard = lock.lock().await;
            // Process sequentially per channel
            ctx.send_message(&msg.channel_id, "processed").await?;
        }
        Ok(())
    })
});
```

---

## 8. Reconnection Strategy (Detailed)

The reconnect manager uses **exponential backoff with full jitter**, following the algorithm recommended by AWS Architecture Blog for distributed system retries.

### Algorithm

```
delay = min(initial_delay * 2^attempt, max_delay)
delay = jitter ? delay * (0.5 + random(0.0, 0.5)) : delay
```

### Implementation

```rust
use rand::Rng;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
use tokio::sync::watch;
use tokio::time::sleep;
use tracing::{info, warn};

pub struct ReconnectManager {
    config: ReconnectConfig,
    attempt: AtomicU32,
    cancel_rx: watch::Receiver<bool>,
    cancel_tx: watch::Sender<bool>,
}

impl ReconnectManager {
    pub fn new(config: ReconnectConfig) -> Self {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        Self {
            config,
            attempt: AtomicU32::new(0),
            cancel_rx,
            cancel_tx,
        }
    }

    /// Waits for the backoff delay. Returns `None` if max attempts
    /// have been exhausted or cancellation was requested.
    pub async fn wait_before_attempt(&self) -> Option<()> {
        let attempt = self.attempt.fetch_add(1, Ordering::SeqCst);

        if self.config.max_attempts > 0 && attempt >= self.config.max_attempts {
            warn!(
                attempt,
                max_attempts = self.config.max_attempts,
                "Reconnect attempts exhausted"
            );
            return None;
        }

        let backoff = self.config.initial_delay.as_millis() as u64 * 2u64.pow(attempt);
        let capped = backoff.min(self.config.max_delay.as_millis() as u64);

        let delay_ms = if self.config.jitter {
            let mut rng = rand::thread_rng();
            let jitter_factor: f64 = rng.gen_range(0.5..1.0);
            (capped as f64 * jitter_factor) as u64
        } else {
            capped
        };

        info!(
            attempt = attempt + 1,
            delay_ms,
            "Scheduling reconnect attempt"
        );

        tokio::select! {
            _ = sleep(Duration::from_millis(delay_ms)) => Some(()),
            _ = self.cancel_rx.changed() => {
                // Cancel requested
                info!("Reconnect cancelled");
                None
            }
        }
    }

    /// Resets the attempt counter (call on successful connection).
    pub fn reset(&self) {
        self.attempt.store(0, Ordering::SeqCst);
    }

    /// Cancels any in-flight `wait_before_attempt`.
    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }
}
```

### Cancellable Reconnect Loop

The main connect loop integrates the reconnect manager with a cancellation token for graceful shutdown:

```rust
use tokio_util::sync::CancellationToken;

async fn connect_loop(
    bot: &NexusBot,
    reconnect: &ReconnectManager,
    cancel_token: CancellationToken,
) {
    loop {
        tokio::select! {
            result = bot.try_connect_once() => {
                match result {
                    Ok(()) => {
                        reconnect.reset();
                        // Connection is now active; wait for disconnection
                        bot.wait_until_disconnected(cancel_token.child_token()).await;
                        // If we reach here, the connection dropped
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "Connection attempt failed");
                    }
                }
            }
            _ = cancel_token.cancelled() => {
                info!("Shutting down reconnect loop");
                reconnect.cancel();
                break;
            }
        }

        if reconnect.wait_before_attempt().await.is_none() {
            break;
        }
    }
}
```

---

## 9. Observability with `tracing`

The SDK emits structured spans and events using the `tracing` crate. Consumers should install a subscriber to capture these.

### Basic Setup

```rust
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

fn init_tracing() {
    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true).compact())
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("nexus_bot_sdk=info")),
        )
        .init();
}
```

### Key Spans and Events

| Span / Event | Level | Description |
|---|---|---|
| `nexus_bot.connect` | INFO | Bot connection attempt with gateway URL and attempt number |
| `nexus_bot.handshake` | DEBUG | WebSocket upgrade and identity frame exchange |
| `nexus_bot.subscribe` | DEBUG | Channel subscription request/response |
| `nexus_bot.event.dispatch` | DEBUG | Event received and dispatched to handler(s) |
| `nexus_bot.api.call` | DEBUG | Outgoing API call (method + params) |
| `nexus_bot.rate_limit` | WARN | Client-side rate limiter throttling |
| `nexus_bot.rate_limit.429` | WARN | Server returned 429; global pause activated |
| `nexus_bot.reconnect` | INFO | Reconnection scheduled with delay and attempt count |
| `nexus_bot.reconnect.exhausted` | ERROR | Max reconnection attempts reached |
| `nexus_bot.heartbeat` | TRACE | PING/PONG frame sent/received |
| `nexus_bot.error` | ERROR | Processing or transport error |

### Filter Configuration

```bash
# Show only info-level and above
RUST_LOG=nexus_bot_sdk=info cargo run

# Debug a specific bot's event dispatch
RUST_LOG=nexus_bot_sdk::dispatch=debug cargo run

# Trace everything (verbose)
RUST_LOG=nexus_bot_sdk=trace cargo run
```

### Integration with OpenTelemetry

For production deployments, bridge `tracing` spans to OpenTelemetry via `tracing-opentelemetry`:

```rust
use opentelemetry::global;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::layer::SubscriberExt;

fn init_otel_tracing(service_name: &str) {
    global::set_text_map_propagator(TraceContextPropagator::new());

    let tracer = opentelemetry_otlp::new_pipeline()
        .tracing()
        .with_exporter(opentelemetry_otlp::new_exporter().tonic())
        .install_batch(opentelemetry_sdk::runtime::Tokio)
        .expect("Failed to initialise OTLP tracer");

    let telemetry = OpenTelemetryLayer::new(tracer);

    tracing_subscriber::registry()
        .with(telemetry)
        .with(fmt::layer().compact())
        .with(EnvFilter::new("nexus_bot_sdk=info"))
        .init();
}
```

---

## 10. Cargo Features

```toml
# Cargo.toml (library)
[features]
default = ["websocket"]

# WebSocket transport via tokio-tungstenite. Enabled by default.
websocket = ["tokio-tungstenite", "tokio-native-tls"]

# Inbound webhook support: signature verification (HMAC-SHA256),
# JWT payload decoding, and optional server adapters.
webhook = ["hmac", "sha2", "jsonwebtoken", "serde_urlencoded"]
```

### Feature: `websocket` (default)

Enables the full WebSocket-based transport stack. This is the primary mode for real-time bots.

```bash
cargo add nexus-bot-sdk                    # includes websocket
cargo add nexus-bot-sdk --no-default-features  # bare minimum (webhook-only)
```

### Feature: `webhook`

Enables types and utilities for HTTP webhook delivery:

```rust
#[cfg(feature = "webhook")]
use nexus_bot_sdk::webhook::{verify_signature, WebhookEvent, WebhookVerifier};

#[cfg(feature = "webhook")]
pub struct WebhookVerifier {
    signing_secret: Vec<u8>,
}

#[cfg(feature = "webhook")]
impl WebhookVerifier {
    /// Creates a new verifier from the bot's signing secret.
    pub fn new(signing_secret: &[u8]) -> Self;

    /// Verifies the `X-Nexus-Signature` header against the raw body.
    ///
    /// Returns `true` if the signature is valid and within the time
    /// tolerance window (5 minutes).
    pub fn verify(&self, body: &[u8], signature_header: &str) -> bool;
}
```

To use both features:

```bash
cargo add nexus-bot-sdk --features webhook
```

---

## 11. Complete Examples

### 11.1 Echo Bot

A minimal bot that echoes every message it sees:

```rust
// examples/echo_bot.rs
use nexus_bot_sdk::{BotOptions, Event, NexusBot};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(fmt::layer().compact())
        .with(EnvFilter::new("nexus_bot_sdk=info,echo_bot=debug"))
        .init();

    let mut bot = NexusBot::new(BotOptions {
        token: std::env::var("NEXUS_BOT_TOKEN")
            .expect("NEXUS_BOT_TOKEN environment variable required"),
        gateway_url: std::env::var("NEXUS_GATEWAY_URL")
            .unwrap_or_else(|_| "wss://gateway.nexus.chat/bot-ws".into()),
        ..Default::default()
    })?;

    bot.on("message", |ctx, event| {
        Box::pin(async move {
            let Event::Message(msg) = event else { return Ok(()) };
            // Don't echo bot messages to avoid infinite loops
            if msg.text.starts_with('/') || msg.text.is_empty() {
                return Ok(());
            }
            ctx.send_message(&msg.channel_id, &format!("echo: {}", msg.text))
                .await?;
            Ok(())
        })
    });

    bot.connect().await?;
    tracing::info!("Echo bot is running. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    bot.disconnect().await?;

    Ok(())
}
```

### 11.2 Poll Bot

A slash-command bot that creates polls with interactive buttons. Uses `clap` for argument parsing and state management via `DashMap`.

```toml
# examples/poll_bot/Cargo.toml
[package]
name = "poll-bot"
version = "0.1.0"
edition = "2021"

[dependencies]
nexus-bot-sdk = { path = "../../", features = ["websocket"] }
tokio = { version = "1", features = ["full"] }
clap = { version = "4", features = ["derive"] }
dashmap = "5"
uuid = { version = "1", features = ["v4"] }
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

```rust
// examples/poll_bot/src/main.rs
use std::sync::Arc;

use clap::Parser;
use dashmap::DashMap;
use nexus_bot_sdk::{
    Block, BotOptions, ButtonStyle, Context, Event, HandlerFuture, NexusBot,
};
use tracing::{error, info};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Simple poll-bot for nexus-chat.
#[derive(Parser, Debug)]
#[command(version, about)]
struct Cli {
    /// Bot authentication token.
    #[arg(env = "NEXUS_BOT_TOKEN")]
    token: String,

    /// Gateway URL.
    #[arg(
        env = "NEXUS_GATEWAY_URL",
        default_value = "wss://gateway.nexus.chat/bot-ws"
    )]
    gateway_url: String,

    /// Tracing log level.
    #[arg(env = "RUST_LOG", default_value = "poll_bot=info,nexus_bot_sdk=info")]
    log_level: String,
}

/// In-memory poll state.
#[derive(Debug, Clone)]
struct Poll {
    question: String,
    options: Vec<String>,
    votes: Vec<Vec<String>>, // votes[i] = list of user_ids who voted for option i
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();

    tracing_subscriber::registry()
        .with(fmt::layer().compact())
        .with(EnvFilter::new(&cli.log_level))
        .init();

    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(run(cli))
}

async fn run(cli: Cli) -> anyhow::Result<()> {
    let polls: Arc<DashMap<String, Poll>> = Arc::new(DashMap::new());

    let mut bot = NexusBot::new(BotOptions {
        token: cli.token,
        gateway_url: cli.gateway_url,
        ..Default::default()
    })?;

    // ── Handle /poll create ───────────────────────────────────────

    {
        let polls = polls.clone();
        bot.on("slash_command", move |ctx, event| {
            let polls = polls.clone();
            Box::pin(async move {
                let Event::SlashCommand(cmd) = event else { return Ok(()) };

                if cmd.command != "poll" {
                    return Ok(());
                }

                // Parse: /poll "Question" "Option A" "Option B" ...
                if cmd.args.len() < 3 {
                    ctx.send_ephemeral(
                        &cmd.channel_id,
                        &cmd.user_id,
                        "Usage: /poll \"Question\" \"Option A\" \"Option B\" ...",
                    )
                    .await?;
                    return Ok(());
                }

                let question = cmd.args[0].clone();
                let options: Vec<String> = cmd.args[1..].to_vec();

                let poll_id = uuid::Uuid::new_v4().to_string();
                let poll = Poll {
                    question: question.clone(),
                    options: options.clone(),
                    votes: vec![Vec::new(); options.len()],
                };
                polls.insert(poll_id.clone(), poll);

                // Build button blocks
                let blocks: Vec<Block> = options
                    .iter()
                    .enumerate()
                    .map(|(i, opt)| Block::Button {
                        action_id: format!("poll_{}_opt_{}", poll_id, i),
                        text: opt.clone(),
                        value: Some(i.to_string()),
                        style: ButtonStyle::Default,
                    })
                    .collect();

                ctx.send_message_with_opts(
                    &cmd.channel_id,
                    &format!("**Poll**: {}", question),
                    nexus_bot_sdk::SendMessageOpts {
                        blocks: Some(&blocks),
                        ..Default::default()
                    },
                )
                .await?;

                Ok(())
            })
        });
    }

    // ── Handle button clicks ──────────────────────────────────────

    {
        bot.on("button_clicked", move |ctx, event| {
            let polls = polls.clone();
            Box::pin(async move {
                let Event::ButtonClicked(btn) = event else { return Ok(()) };

                // action_id format: poll_{poll_id}_opt_{option_index}
                let parts: Vec<&str> = btn.action_id.split('_').collect();
                if parts.len() != 4 || parts[0] != "poll" {
                    return Ok(());
                }

                let poll_id = parts[1].to_string();
                let opt_idx: usize = match parts[3].parse() {
                    Ok(v) => v,
                    Err(_) => return Ok(()),
                };

                let mut poll = match polls.get_mut(&poll_id) {
                    Some(p) => p,
                    None => {
                        ctx.send_ephemeral(
                            &btn.channel_id,
                            &btn.user_id,
                            "This poll no longer exists.",
                        )
                        .await?;
                        return Ok(());
                    }
                };

                // Remove previous votes from this user, then add new vote
                for votes in poll.votes.iter_mut() {
                    votes.retain(|uid| uid != &btn.user_id);
                }
                poll.votes[opt_idx].push(btn.user_id.clone());

                // Build results message
                let total: usize = poll.votes.iter().map(|v| v.len()).sum();
                let mut results = format!("**{}**\n\n", poll.question);
                for (i, opt) in poll.options.iter().enumerate() {
                    let count = poll.votes[i].len();
                    let bar = "█".repeat(count);
                    results.push_str(&format!("{}: {} ({})\n", opt, bar, count));
                }
                results.push_str(&format!("\n_Total votes: {}_", total));

                ctx.send_message(&btn.channel_id, &results).await?;

                Ok(())
            })
        });
    }

    bot.connect().await?;
    info!("Poll bot is running. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    bot.disconnect().await?;

    Ok(())
}
```

### 11.3 Actix-web Webhook Adapter

When the `webhook` feature is enabled, bots can receive events via HTTP POST. This example shows a server using `actix-web`:

```toml
# examples/webhook_server/Cargo.toml
[dependencies]
nexus-bot-sdk = { path = "../../", default-features = false, features = ["webhook"] }
actix-web = "4"
actix-rt = "2"
tokio = { version = "1", features = ["full"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

```rust
// examples/webhook_server/src/main.rs
use actix_web::{post, web, App, HttpRequest, HttpResponse, HttpServer};
use nexus_bot_sdk::{
    webhook::{verify_signature, WebhookPayload},
    Event,
};
use tracing::{error, info};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

struct AppState {
    signing_secret: Vec<u8>,
}

#[post("/webhook")]
async fn webhook_handler(
    req: HttpRequest,
    body: String,
    state: web::Data<AppState>,
) -> HttpResponse {
    // Extract signature header
    let signature = match req
        .headers()
        .get("X-Nexus-Signature")
        .and_then(|v| v.to_str().ok())
    {
        Some(sig) => sig,
        None => {
            return HttpResponse::Unauthorized().body("Missing signature header");
        }
    };

    // Verify HMAC
    if !verify_signature(body.as_bytes(), signature, &state.signing_secret) {
        return HttpResponse::Unauthorized().body("Invalid signature");
    }

    // Parse the event
    let payload: WebhookPayload = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            error!(error = %e, "Failed to parse webhook payload");
            return HttpResponse::BadRequest().body("Invalid payload");
        }
    };

    let event: Event = match payload.decode_and_verify(&state.signing_secret) {
        Ok(ev) => ev,
        Err(e) => {
            error!(error = %e, "Failed to decode event JWT");
            return HttpResponse::BadRequest().body("Invalid event token");
        }
    };

    // Process the event
    if let Err(e) = handle_event(event).await {
        error!(error = %e, "Event handler failed");
        return HttpResponse::InternalServerError().body("Processing error");
    }

    HttpResponse::Ok().body("OK")
}

async fn handle_event(event: Event) -> Result<(), Box<dyn std::error::Error>> {
    match event {
        Event::Message(msg) => {
            info!(
                channel_id = %msg.channel_id,
                user_id = %msg.user_id,
                text = %msg.text,
                "Received message"
            );

            if msg.text.contains("deploy") {
                info!("Deploy command detected, triggering CI/CD pipeline...");
                // Call your CI/CD system here
            }
        }
        Event::SlashCommand(cmd) => {
            info!(
                command = %cmd.command,
                args = ?cmd.args,
                "Received slash command"
            );
        }
        other => {
            info!(event_type = %other.type_str(), "Received event");
        }
    }
    Ok(())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::registry()
        .with(fmt::layer().compact())
        .with(EnvFilter::new("webhook_server=info"))
        .init();

    let signing_secret = std::env::var("NEXUS_WEBHOOK_SECRET")
        .expect("NEXUS_WEBHOOK_SECRET required")
        .into_bytes();

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".into());

    info!("Starting webhook server on {}", bind_addr);

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(AppState {
                signing_secret: signing_secret.clone(),
            }))
            .service(webhook_handler)
    })
    .bind(&bind_addr)?
    .run()
    .await
}
```

### 11.4 CI/CD Bot

A bot that triggers deployments and reports status back to channels:

```rust
// examples/cicd_bot/src/main.rs
use std::process::Command;
use std::time::Duration;

use nexus_bot_sdk::{BotOptions, Event, NexusBot};
use tokio::sync::Mutex;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[derive(Debug, Clone)]
struct Deployment {
    channel_id: String,
    message_id: String,
    service: String,
    environment: String,
    status: DeploymentStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DeploymentStatus {
    Queued,
    Building,
    Deploying,
    Success,
    Failed(String),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(fmt::layer().compact())
        .with(EnvFilter::new("cicd_bot=info,nexus_bot_sdk=info"))
        .init();

    let token = std::env::var("NEXUS_BOT_TOKEN")
        .expect("NEXUS_BOT_TOKEN required");

    let mut bot = NexusBot::new(BotOptions {
        token,
        gateway_url: std::env::var("NEXUS_GATEWAY_URL")
            .unwrap_or_else(|_| "wss://gateway.nexus.chat/bot-ws".into()),
        ..Default::default()
    })?;

    // ── /deploy handler ───────────────────────────────────────────

    bot.on("slash_command", |ctx, event| {
        Box::pin(async move {
            let Event::SlashCommand(cmd) = event else { return Ok(()) };

            if cmd.command != "deploy" {
                return Ok(());
            }

            // Parse: /deploy <service> <environment>
            if cmd.args.len() < 2 {
                ctx.send_ephemeral(
                    &cmd.channel_id,
                    &cmd.user_id,
                    "Usage: /deploy <service> <environment>",
                )
                .await?;
                return Ok(());
            }

            let service = cmd.args[0].clone();
            let environment = cmd.args[1].clone();

            // Post a status message
            let msg = ctx
                .send_message(
                    &cmd.channel_id,
                    &format!(
                        ":rocket: Deploying `{}` to **{}** &mdash; :hourglass: queued...",
                        service, environment
                    ),
                )
                .await?;

            // Spawn a background task for the actual deployment
            let ctx_clone = ctx.clone();
            let channel_id = cmd.channel_id.clone();
            let message_id = msg.id.clone();
            tokio::spawn(async move {
                if let Err(e) = run_deployment(
                    &ctx_clone,
                    &channel_id,
                    &message_id,
                    &service,
                    &environment,
                )
                .await
                {
                    error!(error = %e, service = %service, "Deployment failed");
                    let _ = ctx_clone
                        .edit_message(
                            &channel_id,
                            &message_id,
                            &format!(":x: Deploy `{}` to **{}** failed: {}", service, environment, e),
                        )
                        .await;
                }
            });

            Ok(())
        })
    });

    bot.connect().await?;
    info!("CI/CD bot is running. Press Ctrl+C to stop.");
    tokio::signal::ctrl_c().await?;
    bot.disconnect().await?;

    Ok(())
}

async fn run_deployment(
    ctx: &nexus_bot_sdk::Context,
    channel_id: &str,
    message_id: &str,
    service: &str,
    environment: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Update: building
    ctx.edit_message(
        channel_id,
        message_id,
        &format!(
            ":rocket: Deploying `{}` to **{}** &mdash; :building_construction: building...",
            service, environment
        ),
    )
    .await?;

    // Run build (simulated)
    tokio::time::sleep(Duration::from_secs(3)).await;

    // Update: deploying
    ctx.edit_message(
        channel_id,
        message_id,
        &format!(
            ":rocket: Deploying `{}` to **{}** &mdash; :arrow_up: deploying...",
            service, environment
        ),
    )
    .await?;

    // Run deploy (simulated)
    tokio::time::sleep(Duration::from_secs(2)).await;

    // Run a health check
    ctx.edit_message(
        channel_id,
        message_id,
        &format!(
            ":rocket: Deploying `{}` to **{}** &mdash; :mag: health check...",
            service, environment
        ),
    )
    .await?;

    let health_ok = tokio::time::timeout(Duration::from_secs(30), async {
        // In a real bot, poll the health endpoint here
        tokio::time::sleep(Duration::from_secs(1)).await;
        true
    })
    .await
    .unwrap_or(false);

    if health_ok {
        ctx.edit_message(
            channel_id,
            message_id,
            &format!(
                ":white_check_mark: `{}` deployed successfully to **{}**",
                service, environment
            ),
        )
        .await?;
    } else {
        return Err("Health check timed out".into());
    }

    Ok(())
}
```

---

> **Related Documents**:
> - [TypeScript Bot SDK Design](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#4-bot-sdk-design-typescript)
> - [Bot Connection Management](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#3-bot-connection-management)
> - [Slash Command Framework](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#5-slash-command-framework)
> - [Bot Permissions & Security](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#8-bot-permissions--security)
> - [Event Pipeline](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md#2-event-pipeline)
