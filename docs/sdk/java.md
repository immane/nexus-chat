---
lang: en
---

# Nexus Chat Java Bot SDK

> **Package**: `chat.nexus:nexus-bot-sdk` · **Java 17+** · **Maven / Gradle**  
> Repository: `https://github.com/nexus-chat/nexus-bot-sdk`  
> License: MIT

---

## Table of Contents

1. [Installation](#1-installation)
2. [Quick Start](#2-quick-start)
3. [Core Concepts](#3-core-concepts)
4. [NexusBot — Constructor & Options](#4-nexusbot--constructor--options)
5. [Event System](#5-event-system)
6. [Event Types](#6-event-types)
7. [Sending Messages](#7-sending-messages)
8. [Channel API](#8-channel-api)
9. [Middleware Pipeline](#9-middleware-pipeline)
10. [Slash Commands](#10-slash-commands)
11. [Reconnection](#11-reconnection)
12. [Rate Limiting](#12-rate-limiting)
13. [Bot Manifest](#13-bot-manifest)
14. [Exception Hierarchy](#14-exception-hierarchy)
15. [Thread Safety](#15-thread-safety)
16. [Complete Examples](#16-complete-examples)

---

## 1. Installation

### Maven

```xml
<dependency>
    <groupId>chat.nexus</groupId>
    <artifactId>nexus-bot-sdk</artifactId>
    <version>1.0.0</version>
</dependency>
```

With OkHttp 4.x (transitive):

```xml
<dependency>
    <groupId>com.squareup.okhttp3</groupId>
    <artifactId>okhttp</artifactId>
    <version>4.12.0</version>
</dependency>
```

### Gradle (Kotlin DSL)

```kotlin
implementation("chat.nexus:nexus-bot-sdk:1.0.0")
implementation("com.squareup.okhttp3:okhttp:4.12.0")
```

### Gradle (Groovy DSL)

```groovy
implementation 'chat.nexus:nexus-bot-sdk:1.0.0'
implementation 'com.squareup.okhttp3:okhttp:4.12.0'
```

### Dependencies

| Library | Version | Purpose |
|----------|---------|--------|
| `com.squareup.okhttp3:okhttp` | 4.12.x | WebSocket transport |
| `com.fasterxml.jackson.core:jackson-databind` | 2.17.x | JSON serialisation |
| `org.slf4j:slf4j-api` | 2.0.x | Structured logging |
| `com.fasterxml.jackson.datatype:jackson-datatype-jsr310` | 2.17.x | Java time support |

---

## 2. Quick Start

```java
import chat.nexus.bot.NexusBot;
import chat.nexus.bot.NexusBot.Options;
import chat.nexus.bot.event.MessageEvent;

public class PingBot {

    public static void main(String[] args) {
        NexusBot bot = new NexusBot(Options.builder()
            .token("nxbot_v1_xxxx")
            .gatewayUrl("wss://gateway.nexus.chat/bot-ws")
            .reconnectEnabled(true)
            .build());

        bot.on("message", (MessageEvent event) -> {
            if ("/ping".equals(event.getText())) {
                bot.sendMessage(event.getChannelId(), "Pong!");
            }
        });

        bot.connect();
    }
}
```

Compile and run:

```bash
javac -cp nexus-bot-sdk-1.0.0.jar PingBot.java
java -cp .:nexus-bot-sdk-1.0.0.jar:okhttp-4.12.0.jar:jackson-databind-2.17.0.jar:... PingBot
```

---

## 3. Core Concepts

The SDK follows an **event-driven** model with a **builder pattern** for construction:

1. **Create** a `NexusBot` instance via `Options.builder()`.
2. **Register** event handlers with `bot.on(eventType, handler)`.
3. **Attach** middleware with `bot.use(middleware)`.
4. **Connect** by calling `bot.connect()`. The SDK manages the WebSocket lifecycle, heartbeat, and automatic reconnection.

All communication with the Nexus gateway is over a persistent `wss://` connection. Events dispatched by the server are deserialised into strongly-typed, immutable Java records.

---

## 4. NexusBot — Constructor & Options

### 4.1 Options Builder

```java
import chat.nexus.bot.NexusBot.Options;

Options opts = Options.builder()
    .token("nxbot_v1_xxxxxxxx")                            // required
    .gatewayUrl("wss://gateway.nexus.chat/bot-ws")          // required
    .connectTimeout(Duration.ofSeconds(10))                 // default: 10 s
    .heartbeatInterval(Duration.ofSeconds(30))              // default: 30 s
    .reconnectEnabled(true)                                 // default: true
    .reconnectMaxRetries(10)                                // default: 10, 0 = infinite
    .reconnectInitialDelay(Duration.ofSeconds(1))           // default: 1 s
    .reconnectMaxDelay(Duration.ofSeconds(30))              // default: 30 s
    .reconnectJitter(true)                                  // default: true
    .rateLimitMaxPerMinute(120)                             // default: 120
    .build();
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | `String` | **required** | Bot token (`nxbot_v1_xxx`) |
| `gatewayUrl` | `String` | **required** | WebSocket gateway URL |
| `connectTimeout` | `Duration` | 10 s | Handshake timeout |
| `heartbeatInterval` | `Duration` | 30 s | Ping interval |
| `reconnectEnabled` | `boolean` | `true` | Enable automatic reconnection |
| `reconnectMaxRetries` | `int` | 10 | Max retries (0 = infinite) |
| `reconnectInitialDelay` | `Duration` | 1 s | First backoff delay |
| `reconnectMaxDelay` | `Duration` | 30 s | Maximum backoff cap |
| `reconnectJitter` | `boolean` | `true` | Apply randomised jitter |
| `rateLimitMaxPerMinute` | `int` | 120 | Client-side token bucket ceiling |

### 4.2 Connection Lifecycle Methods

```java
NexusBot bot = new NexusBot(options);

bot.connect();          // Connect to gateway (non-blocking; fires on a daemon thread)
bot.disconnect();       // Graceful close with 2500 ms timeout
boolean connected = bot.isConnected();
```

`connect()` initiates the handshake on an OkHttp dispatcher thread. The server sends a `connected` frame once authentication succeeds; after that, events begin flowing to registered handlers. The method returns immediately — use event callbacks or the robot's `connected` event to react to state changes.

### 4.3 ConnectionState Enum

```java
public enum ConnectionState {
    CONNECTING,
    AUTHENTICATING,
    SUBSCRIBED,
    ACTIVE,
    DISCONNECTED
}
```

Query the current state with:

```java
ConnectionState state = bot.getConnectionState();
```

Listen for state transitions:

```java
bot.onConnect(() -> log.info("Bot connected with session {}", bot.getSessionId()));
bot.onDisconnect(reason -> log.warn("Disconnected: {}", reason));
```

---

## 5. Event System

### 5.1 Registering Event Handlers

```java
bot.on("message", (MessageEvent event) -> {
    // Handle incoming message
});

bot.on("member_joined", (MemberJoinedEvent event) -> {
    // Handle member join
});

bot.on("slash_command", (SlashCommandEvent event) -> {
    // Handle slash command
});
```

The first argument is the event type string. The second is a typed functional consumer. Event type strings are declared as constants in `BotEventType`:

```java
import chat.nexus.bot.event.BotEventType;

bot.on(BotEventType.MESSAGE,               this::onMessage);
bot.on(BotEventType.MEMBER_JOINED,         this::onMemberJoined);
bot.on(BotEventType.MEMBER_LEFT,           this::onMemberLeft);
bot.on(BotEventType.CHANNEL_CREATED,       this::onChannelCreated);
bot.on(BotEventType.CHANNEL_ARCHIVED,      this::onChannelArchived);
bot.on(BotEventType.SLASH_COMMAND,         this::onSlashCommand);
bot.on(BotEventType.BUTTON_CLICKED,        this::onButtonClicked);
```

### 5.2 Event Interface Hierarchy

All events implement the sealed interface `BotEvent`:

```java
public sealed interface BotEvent
    permits MessageEvent,
            MessageEditedEvent,
            MessageDeletedEvent,
            ChannelCreatedEvent,
            ChannelArchivedEvent,
            MemberJoinedEvent,
            MemberLeftEvent,
            SlashCommandEvent,
            ButtonClickedEvent {

    String getEventId();
    String getEventType();
    String getWorkspaceId();
    String getIdempotencyKey();
    Instant getTimestamp();
}
```

### 5.3 Removing Handlers

```java
// Remove a specific handler reference
bot.off("message", handlerRef);

// Remove all handlers for an event type
bot.off("message");
```

---

## 6. Event Types

All event payloads are Java 17 records, immutable and suitable for concurrent access.

### 6.1 MessageEvent

Received when a user sends a message in a subscribed channel.

```java
public record MessageEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String userId,
    String messageId,
    String text,
    String threadId,              // nullable — null if not in a thread
    List<String> mentions,        // list of @mentioned user IDs
    List<Attachment> attachments
) implements BotEvent {

    public String getText() { return text; }
    public String getChannelId() { return channelId; }
    public String getUserId() { return userId; }
    public Optional<String> getThreadId() { return Optional.ofNullable(threadId); }
}

public record Attachment(
    String id,
    String filename,
    String mimeType,
    long sizeBytes,
    String url
) {}
```

### 6.2 MessageEditedEvent

```java
public record MessageEditedEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String messageId,
    String oldText,
    String newText
) implements BotEvent {}
```

### 6.3 MessageDeletedEvent

```java
public record MessageDeletedEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String messageId
) implements BotEvent {}
```

### 6.4 ChannelCreatedEvent

```java
public record ChannelCreatedEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String name,
    String createdBy
) implements BotEvent {}
```

### 6.5 ChannelArchivedEvent

```java
public record ChannelArchivedEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String archivedBy
) implements BotEvent {}
```

### 6.6 MemberJoinedEvent

```java
public record MemberJoinedEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String userId
) implements BotEvent {}
```

### 6.7 MemberLeftEvent

```java
public record MemberLeftEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String userId
) implements BotEvent {}
```

### 6.8 SlashCommandEvent

Dispatched when a user invokes a slash command that targets this bot.

```java
public record SlashCommandEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String userId,
    String commandName,
    List<String> args,
    String triggerId              // 3-second response window token
) implements BotEvent {

    /**
     * Convenience: returns the full invocation, e.g. "/weather tokyo".
     */
    public String getInvocation() {
        return "/" + commandName + " " + String.join(" ", args);
    }
}
```

### 6.9 ButtonClickedEvent

```java
public record ButtonClickedEvent(
    String eventId,
    String eventType,
    String workspaceId,
    String idempotencyKey,
    Instant timestamp,

    String channelId,
    String userId,
    String actionId,
    String value,
    String messageId
) implements BotEvent {}
```

### 6.10 Pattern-Matching Dispatch

Java 17+ pattern matching makes event handling concise:

```java
bot.on("*", (BotEvent event) -> {
    switch (event) {
        case MessageEvent e       -> handleMessage(e);
        case MemberJoinedEvent e  -> handleJoin(e);
        case SlashCommandEvent e  -> handleCommand(e);
        default                   -> log.debug("Unhandled: {}", event.getEventType());
    }
});
```

---

## 7. Sending Messages

### 7.1 Basic Send

```java
// Send plain text
bot.sendMessage("ch_abc123", "Hello, world!");

// Send with options (thread, blocks)
MessageOptions opts = MessageOptions.builder()
    .threadId("thread_xyz")
    .blocks(List.of(
        Block.section("**Bold** and *italic*"),
        Block.divider(),
        Block.context("Powered by Nexus Chat")
    ))
    .build();

bot.sendMessage("ch_abc123", "Fallback text for notifications", opts);
```

### 7.2 Editing and Deleting

```java
bot.editMessage("ch_abc123", "msg_xyz", "Updated text");
bot.deleteMessage("ch_abc123", "msg_xyz");
```

### 7.3 Ephemeral Messages

Visible only to the specified user; never persisted to channel history.

```java
bot.sendEphemeral("ch_abc123", "user_xyz", "This is visible only to you.");
```

### 7.4 MessageOptions Builder

```java
public final class MessageOptions {

    public static Builder builder() { return new Builder(); }

    public static final class Builder {
        private String threadId;
        private List<Block> blocks = List.of();

        public Builder threadId(String threadId) { this.threadId = threadId; return this; }
        public Builder blocks(List<Block> blocks)    { this.blocks = blocks;    return this; }

        public MessageOptions build() {
            return new MessageOptions(threadId, blocks);
        }
    }
}
```

### 7.5 Block Types

```java
public sealed interface Block
    permits Block.Section, Block.Divider, Block.Context, Block.Actions {

    record Section(String text)                implements Block {}
    record Divider()                           implements Block {}
    record Context(String text)                implements Block {}
    record Actions(List<ActionElement> elements) implements Block {}
}

public record ActionElement(
    String actionId,
    String text,
    ActionStyle style      // PRIMARY, DANGER, DEFAULT
) {}

public enum ActionStyle { PRIMARY, DANGER, DEFAULT }
```

---

## 8. Channel API

Query channel metadata and member lists. All calls return `CompletableFuture<T>`.

```java
import chat.nexus.bot.model.ChannelInfo;
import chat.nexus.bot.model.Member;

// Fetch channel information
CompletableFuture<ChannelInfo> infoFuture = bot.getChannelInfo("ch_abc123");
ChannelInfo info = infoFuture.join();   // or chain with .thenAccept()

// Fetch member list
CompletableFuture<List<Member>> membersFuture = bot.getMemberList("ch_abc123");
List<Member> members = membersFuture.join();
```

### 8.1 ChannelInfo Record

```java
public record ChannelInfo(
    String id,
    String name,
    String description,
    String createdBy,
    Instant createdAt,
    boolean isArchived,
    boolean isEncrypted,
    int memberCount
) {}
```

### 8.2 Member Record

```java
public record Member(
    String userId,
    String displayName,
    String avatarUrl,
    MemberRole role,            // ADMIN, MEMBER, GUEST
    Instant joinedAt
) {}

public enum MemberRole { ADMIN, MEMBER, GUEST }
```

**Important**: Channel API calls that touch E2E-encrypted channels will return a `NexusBotException` with the error code `e2e_bots_disabled`. Bots cannot access encrypted channels under any circumstances.

---

## 9. Middleware Pipeline

Middleware intercepts every inbound event and outbound API call. This is useful for logging, metrics, filtering, and custom rate limiting.

### 9.1 Functional Interface

```java
@FunctionalInterface
public interface Middleware {
    /**
     * Process an event before it reaches the main handler.
     * Call {@code next.process(event)} to pass control to the next middleware
     * or the final handler. Return without calling next to short-circuit.
     */
    void process(BotEvent event, Next next);
}

@FunctionalInterface
public interface Next {
    void process(BotEvent event);
}
```

### 9.2 Registering Middleware

```java
// Log every event
bot.use((event, next) -> {
    log.info("Event: type={} id={}", event.getEventType(), event.getEventId());
    next.process(event);
});

// Block spam channels
bot.use((event, next) -> {
    if (event instanceof MessageEvent msg && SPAM_CHANNELS.contains(msg.getChannelId())) {
        return; // Drop event — never reaches handlers
    }
    next.process(event);
});

// Measure processing latency
bot.use((event, next) -> {
    long start = System.nanoTime();
    next.process(event);
    long duration = Duration.ofNanos(System.nanoTime() - start).toMillis();
    metrics.record(event.getEventType(), duration);
});
```

Middleware executes in registration order. Each middleware receives the event and must explicitly call `next.process(event)` to pass it down the chain.

---

## 10. Slash Commands

### 10.1 Server-Side Command Format

Slash commands use the format `/botname command [args...]`:

```
/weather tokyo
/poll "Lunch?" "Pizza" "Sushi" "Salad"
/deploy service-cart staging
```

The server parses this client-side, routes to the correct bot, and dispatches a `SlashCommandEvent` to the bot's WebSocket.

### 10.2 Handling Slash Commands

```java
bot.on(BotEventType.SLASH_COMMAND, (SlashCommandEvent event) -> {
    switch (event.getCommandName()) {
        case "weather" -> handleWeather(event);
        case "poll"    -> handlePoll(event);
        default        -> bot.sendEphemeral(event.getChannelId(), event.getUserId(),
                               "Unknown command: /" + event.getCommandName());
    }
});

private void handleWeather(SlashCommandEvent event) {
    String city = event.getArgs().isEmpty() ? "Tokyo" : event.getArgs().get(0);
    String report = fetchWeatherReport(city);
    bot.sendMessage(event.getChannelId(), report);
}
```

### 10.3 Declaring Commands in the Manifest

See [§13 Bot Manifest](#13-bot-manifest) for registering commands so they appear in the client's slash-command autocomplete.

---

## 11. Reconnection

The SDK implements exponential backoff with jitter, mirroring the TypeScript reference implementation.

### 11.1 Algorithm

```
attempt 0 → delay   1 s → jittered   500 ms ..  1500 ms
attempt 1 → delay   2 s → jittered  1000 ms ..  3000 ms
attempt 2 → delay   4 s → jittered  2000 ms ..  6000 ms
attempt 3 → delay   8 s → jittered  4000 ms .. 12000 ms
attempt 4 → delay  16 s → jittered  8000 ms .. 24000 ms
attempt 5 → delay  30 s (capped) → jittered 15000 ms .. 45000 ms
...
```

After `maxRetries` attempts (default: 10), the SDK stops reconnecting and fires `onPermanentDisconnect`:

```java
bot.onPermanentDisconnect(() -> {
    log.error("Giving up after {} failed reconnect attempts. Exiting.", maxRetries);
    System.exit(1);
});
```

Set `reconnectMaxRetries(0)` for infinite retry.

### 11.2 Configuration in Options

```java
Options.builder()
    .reconnectEnabled(true)
    .reconnectMaxRetries(10)
    .reconnectInitialDelay(Duration.ofSeconds(1))
    .reconnectMaxDelay(Duration.ofSeconds(30))
    .reconnectJitter(true)
    .build();
```

### 11.3 Internal Implementation Sketch

```java
final class ReconnectManager {

    private int attempt;
    private final Options opts;
    private final ScheduledExecutorService scheduler;

    void schedule(Runnable connect) {
        if (opts.getReconnectMaxRetries() > 0 && attempt >= opts.getReconnectMaxRetries()) {
            firePermanentDisconnect();
            return;
        }
        long base = Math.min(
            opts.getReconnectInitialDelay().toMillis() * (1L << attempt),
            opts.getReconnectMaxDelay().toMillis()
        );
        long delay = opts.isReconnectJitter()
            ? (long) (base * (0.5 + ThreadLocalRandom.current().nextDouble() * 0.5))
            : base;

        scheduler.schedule(() -> {
            attempt++;
            try {
                connect.run();
                attempt = 0; // Reset on success
            } catch (Exception e) {
                schedule(connect);
            }
        }, delay, TimeUnit.MILLISECONDS);
    }

    void reset() {
        attempt = 0;
    }
}
```

---

## 12. Rate Limiting

### 12.1 Client-Side Token Bucket

The SDK includes a **client-side token bucket** that smooths outgoing API calls. This is distinct from the server-side rate limiter; it acts as a first line of defence to avoid triggering `429 Too Many Requests`.

```java
Options.builder()
    .rateLimitMaxPerMinute(120)   // 120 API calls per minute
    .build();
```

### 12.2 How It Works

- The bucket starts full (`maxPerMinute` tokens).
- Each API call consumes 1 token.
- Tokens refill continuously at `maxPerMinute` / 60 000 tokens per millisecond.
- If the bucket is empty, `sendMessage()` and other API methods block until a token is available.
- When the server returns `429`, the SDK reads the `Retry-After` header and pauses **all** outgoing calls for the specified duration.

### 12.3 Internal Sketch

```java
final class RateLimiter {

    private final double maxTokens;
    private double tokens;
    private long lastRefill;
    private volatile long globalPauseUntil; // monotonic millis from 429 responses

    RateLimiter(int maxPerMinute) {
        this.maxTokens = maxPerMinute;
        this.tokens = maxPerMinute;
        this.lastRefill = System.currentTimeMillis();
    }

    synchronized void acquire() throws InterruptedException {
        refill();
        long now = System.currentTimeMillis();
        if (now < globalPauseUntil) {
            Thread.sleep(globalPauseUntil - now);
            now = System.currentTimeMillis();
            refill();
        }
        if (tokens < 1.0) {
            long waitMs = (long) ((1.0 - tokens) / (maxTokens / 60_000.0));
            if (waitMs > 0) Thread.sleep(waitMs);
            refill();
        }
        tokens = Math.max(0.0, tokens - 1.0);
    }

    private void refill() {
        long now = System.currentTimeMillis();
        long elapsed = now - lastRefill;
        tokens = Math.min(maxTokens, tokens + (elapsed / 60_000.0) * maxTokens);
        lastRefill = now;
    }

    synchronized void handle429(int retryAfterSeconds) {
        globalPauseUntil = System.currentTimeMillis() + retryAfterSeconds * 1000L;
        tokens = 0;
    }
}
```

### 12.4 Server-Side Limits (Reference)

| Level | Limit | Key Pattern |
|-------|-------|-------------|
| Bot-level | 120 req/min per bot | `ratelimit:bot:{botId}:minute` |
| Workspace-level | 1000 events/min | `ratelimit:ws:{workspaceId}:minute` |

The client-side token bucket should be configured at or below the bot-level limit.

---

## 13. Bot Manifest

The manifest declares a bot's identity, capabilities, and permission scopes. It is submitted at bot registration time and validated by the server.

### 13.1 Manifest as a Java Class

```java
import chat.nexus.bot.manifest.BotManifest;
import chat.nexus.bot.manifest.BotCommand;
import chat.nexus.bot.manifest.CommandArg;
import chat.nexus.bot.manifest.ConnectionMode;
import chat.nexus.bot.manifest.ManifestScope;

BotManifest manifest = BotManifest.builder()
    .name("WeatherBot")
    .description("Provides current weather information for any city.")
    .connectionMode(ConnectionMode.WEBSOCKET)
    .scopes(List.of(
        ManifestScope.MESSAGES_READ,
        ManifestScope.MESSAGES_WRITE,
        ManifestScope.COMMANDS
    ))
    .iconUrl("https://example.com/weatherbot-icon.png")
    .commands(List.of(
        BotCommand.builder()
            .name("weather")
            .description("Get current weather for a city")
            .usage("/weather <city>")
            .args(List.of(
                CommandArg.builder()
                    .name("city")
                    .description("City name, e.g. 'Tokyo' or 'London'")
                    .required(true)
                    .type(CommandArgType.STRING)
                    .build()
            ))
            .build()
    ))
    .build();
```

### 13.2 Record Definitions

```java
public record BotManifest(
    String name,
    String description,
    ConnectionMode connectionMode,
    List<ManifestScope> scopes,
    List<BotCommand> commands,
    String iconUrl,            // nullable
    String webhookUrl          // nullable — required if connectionMode == WEBHOOK
) {
    public static Builder builder() { return new Builder(); }
    // Builder class omitted for brevity; follows standard pattern
}

public record BotCommand(
    String name,
    String description,
    String usage,              // nullable, e.g. "/weather <city>"
    List<CommandArg> args
) {
    public static Builder builder() { return new Builder(); }
}

public record CommandArg(
    String name,
    String description,
    boolean required,
    CommandArgType type
) {
    public static Builder builder() { return new Builder(); }
}

public enum CommandArgType { STRING, NUMBER, USER, CHANNEL }
public enum ConnectionMode { WEBSOCKET, WEBHOOK }

public enum ManifestScope {
    MESSAGES_READ,
    MESSAGES_WRITE,
    CHANNELS_READ,
    CHANNELS_MANAGE,
    MEMBERS_READ,
    COMMANDS,
    INTERACTIONS,
    FILES_READ,
    FILES_WRITE
}
```

### 13.3 Manifest as JSON / YAML

The manifest can also be defined as a standalone file, loaded at startup:

**manifest.json**

```json
{
  "name": "WeatherBot",
  "description": "Provides current weather information for any city.",
  "connectionMode": "websocket",
  "scopes": ["messages:read", "messages:write", "commands"],
  "iconUrl": "https://example.com/weatherbot-icon.png",
  "commands": [
    {
      "name": "weather",
      "description": "Get current weather for a city",
      "usage": "/weather <city>",
      "args": [
        {
          "name": "city",
          "description": "City name, e.g. 'Tokyo' or 'London'",
          "required": true,
          "type": "string"
        }
      ]
    }
  ]
}
```

Load it with:

```java
BotManifest manifest = BotManifest.fromJson(Files.readString(Path.of("manifest.json")));
```

---

## 14. Exception Hierarchy

All SDK exceptions extend `NexusBotException`.

```java
public sealed class NexusBotException extends RuntimeException
    permits AuthenticationException,
            ConnectionException,
            RateLimitException {

    private final String errorCode;

    public NexusBotException(String errorCode, String message) {
        super(message);
        this.errorCode = errorCode;
    }

    public NexusBotException(String errorCode, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
    }

    public String getErrorCode() { return errorCode; }
}

public final class AuthenticationException extends NexusBotException {
    public AuthenticationException(String message) {
        super("auth_failed", message);
    }
}

public final class RateLimitException extends NexusBotException {
    private final int retryAfterSeconds;

    public RateLimitException(String message, int retryAfterSeconds) {
        super("rate_limited", message);
        this.retryAfterSeconds = retryAfterSeconds;
    }

    public int getRetryAfterSeconds() { return retryAfterSeconds; }
}

public final class ConnectionException extends NexusBotException {
    public ConnectionException(String message, Throwable cause) {
        super("connection_failed", message, cause);
    }
}
```

### 14.1 Server Error Codes

| Error Code | Exception | Meaning |
|------------|-----------|---------|
| `auth_failed` | `AuthenticationException` | Invalid or expired bot token |
| `rate_limited` | `RateLimitException` | Bot exceeded rate limit; includes `Retry-After` |
| `connection_failed` | `ConnectionException` | WebSocket handshake or transport failure |
| `e2e_bots_disabled` | `NexusBotException` | Cannot access encrypted channel |
| `permission_denied` | `NexusBotException` | Bot lacks required scope for the operation |
| `channel_not_found` | `NexusBotException` | Referenced channel does not exist |
| `invalid_message` | `NexusBotException` | Message payload validation failed |

---

## 15. Thread Safety

### 15.1 Guarantees

- **All event records are immutable** (`record` types). Once constructed, they can be safely shared across threads without synchronisation.
- **`NexusBot` is thread-safe**. The public API (`sendMessage`, `on`, `off`, `use`, `connect`, `disconnect`) can be called from any thread. Internal state is guarded by `ReentrantReadWriteLock` or `synchronized` blocks on the connection and handler registry.
- **Handlers execute sequentially per event type** on a single-threaded dispatcher by default. If you spawn work in a handler, manage your own synchronisation.

### 15.2 Handler Execution Model

```java
// Handlers for the same event type run on a dedicated single-thread executor.
// Different event types may run on different threads.
// Do NOT block the handler thread with long-running work.

// BAD — blocks the dispatcher:
bot.on("message", event -> {
    String result = heavyDatabaseQuery();  // blocks the message dispatcher
    bot.sendMessage(event.getChannelId(), result);
});

// GOOD — offload to a separate executor:
private final ExecutorService worker = Executors.newFixedThreadPool(4);

bot.on("message", event -> {
    worker.submit(() -> {
        String result = heavyDatabaseQuery();
        bot.sendMessage(event.getChannelId(), result);
    });
});
```

### 15.3 Concurrent API Calls

`sendMessage`, `editMessage`, `deleteMessage`, `getChannelInfo`, and `getMemberList` are all safe to call from multiple threads. The underlying `OkHttpClient` is shared and thread-safe by design. The `RateLimiter` uses `synchronized` to serialise token acquisition.

### 15.4 Bot Instance Lifecycle

- Create **one** `NexusBot` instance per bot token.
- Call `connect()` once. Reconnection is handled internally.
- After `disconnect()`, the instance should not be reused. Create a new `NexusBot` if you need to reconnect.
- Use the `ConnectionState` enum to guard operations:

```java
if (bot.getConnectionState() == ConnectionState.ACTIVE) {
    bot.sendMessage(channelId, text);
}
```

---

## 16. Complete Examples

### 16.1 EchoBot

Replies to every message by echoing it back.

```java
import chat.nexus.bot.NexusBot;
import chat.nexus.bot.NexusBot.Options;
import chat.nexus.bot.event.MessageEvent;
import chat.nexus.bot.event.MemberJoinedEvent;

public class EchoBot {

    public static void main(String[] args) {
        NexusBot bot = new NexusBot(Options.builder()
            .token(System.getenv("NEXUS_BOT_TOKEN"))
            .gatewayUrl("wss://gateway.nexus.chat/bot-ws")
            .reconnectEnabled(true)
            .build());

        bot.on("message", (MessageEvent event) -> {
            String echo = String.format("You said: %s", event.getText());
            bot.sendMessage(event.getChannelId(), echo);
        });

        bot.on("member_joined", (MemberJoinedEvent event) -> {
            bot.sendMessage(event.getChannelId(),
                String.format("Welcome <@%s>! Type something and I'll echo it back.", event.getUserId()));
        });

        bot.onConnect(() -> System.out.println("EchoBot is online."));
        bot.onDisconnect(reason -> System.out.println("EchoBot disconnected: " + reason));

        bot.connect();
    }
}
```

### 16.2 PollBot

Creates interactive polls via slash commands.

```java
import chat.nexus.bot.NexusBot;
import chat.nexus.bot.NexusBot.Options;
import chat.nexus.bot.event.SlashCommandEvent;
import chat.nexus.bot.model.Block;

import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

public class PollBot {

    public static void main(String[] args) {
        NexusBot bot = new NexusBot(Options.builder()
            .token(System.getenv("NEXUS_BOT_TOKEN"))
            .gatewayUrl("wss://gateway.nexus.chat/bot-ws")
            .build());

        bot.on("slash_command", (SlashCommandEvent event) -> {
            if (!"poll".equals(event.getCommandName())) return;

            List<String> args = event.getArgs();
            if (args.size() < 3) {
                bot.sendEphemeral(event.getChannelId(), event.getUserId(),
                    "Usage: /poll \"Question\" \"Option1\" \"Option2\" [\"Option3\"...]");
                return;
            }

            String question = args.get(0);
            List<String> options = args.subList(1, args.size());

            String body = IntStream.range(0, options.size())
                .mapToObj(i -> String.format("%d. %s", i + 1, options.get(i)))
                .collect(Collectors.joining("\n"));

            String pollMessage = String.format("**Poll: %s**\n%s\n\nReact with the number to vote!", question, body);

            bot.sendMessage(event.getChannelId(), pollMessage);
        });

        bot.connect();
    }
}
```

### 16.3 CICDBot

Receives deployment events and posts status updates to subscribed channels.

```java
import chat.nexus.bot.NexusBot;
import chat.nexus.bot.NexusBot.Options;
import chat.nexus.bot.event.MessageEvent;
import chat.nexus.bot.model.Block;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class CICDBot {

    private final NexusBot bot;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    public CICDBot() {
        this.bot = new NexusBot(Options.builder()
            .token(System.getenv("NEXUS_BOT_TOKEN"))
            .gatewayUrl("wss://gateway.nexus.chat/bot-ws")
            .reconnectEnabled(true)
            .reconnectMaxRetries(0) // infinite retry
            .build());

        registerHandlers();
    }

    private void registerHandlers() {
        bot.on("message", (MessageEvent event) -> {
            String text = event.getText().trim();

            switch (text) {
                case "/deploy status" -> {
                    DeploymentStatus status = fetchDeploymentStatus();
                    bot.sendMessage(event.getChannelId(), status.toSlackFormat(),
                        MessageOptions.builder()
                            .blocks(List.of(
                                Block.section(status.summary()),
                                Block.context("Last updated: " + Instant.now())
                            ))
                            .build());
                }
                case "/deploy trigger" -> {
                    String deployId = triggerDeployment(event.getUserId());
                    bot.sendMessage(event.getChannelId(),
                        String.format("Deployment `%s` triggered by <@%s>. Monitoring...",
                            deployId, event.getUserId()));

                    // Poll deployment status every 10 seconds for up to 5 minutes
                    monitorDeployment(event.getChannelId(), deployId);
                }
                default -> {
                    // Ignore non-command messages
                }
            }
        });
    }

    private void monitorDeployment(String channelId, String deployId) {
        scheduler.scheduleAtFixedRate(() -> {
            DeploymentStatus status = fetchDeploymentStatusByDeployId(deployId);
            bot.sendMessage(channelId, status.toSlackFormat());

            if (status.isTerminal()) {
                throw new RuntimeException("STOP_SCHEDULING"); // crude but effective
            }
        }, 10, 10, TimeUnit.SECONDS);
    }

    public void start() {
        bot.connect();
    }

    // —— Stub implementations ——

    private record DeploymentStatus(String id, String stage, String status, boolean isTerminal) {
        String toSlackFormat() {
            return String.format("**Deploy `%s`** | Stage: `%s` | Status: `%s`", id, stage, status);
        }
        String summary() {
            return String.format("Deploy %s: %s (%s)", id, stage, status);
        }
    }

    private DeploymentStatus fetchDeploymentStatus() {
        return new DeploymentStatus("d_123", "deploy", "success", true);
    }

    private DeploymentStatus fetchDeploymentStatusByDeployId(String deployId) {
        return new DeploymentStatus(deployId, "deploy", "in_progress", false);
    }

    private String triggerDeployment(String userId) {
        return "d_" + System.currentTimeMillis();
    }

    public static void main(String[] args) {
        new CICDBot().start();
    }
}
```

### 16.4 Bot with Middleware — Auditing

```java
import chat.nexus.bot.NexusBot;
import chat.nexus.bot.NexusBot.Options;
import chat.nexus.bot.event.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;

public class AuditedBot {

    private static final Logger log = LoggerFactory.getLogger(AuditedBot.class);
    private static final Path AUDIT_LOG = Path.of("/var/log/nexus-bot/audit.jsonl");

    public static void main(String[] args) throws Exception {
        Files.createDirectories(AUDIT_LOG.getParent());

        NexusBot bot = new NexusBot(Options.builder()
            .token(System.getenv("NEXUS_BOT_TOKEN"))
            .gatewayUrl("wss://gateway.nexus.chat/bot-ws")
            .build());

        // Middleware 1: JSONL audit trail
        bot.use((event, next) -> {
            String json = String.format(
                "{\"ts\":\"%s\",\"type\":\"%s\",\"id\":\"%s\",\"ws\":\"%s\"}\n",
                Instant.now(), event.getEventType(), event.getEventId(), event.getWorkspaceId());
            Files.writeString(AUDIT_LOG, json, StandardOpenOption.APPEND);
            next.process(event);
        });

        // Middleware 2: Structured logging
        bot.use((event, next) -> {
            log.info("Dispatching event type={} idempotencyKey={}",
                event.getEventType(), event.getIdempotencyKey());
            next.process(event);
        });

        // Middleware 3: Reject encrypted channel events (defence in depth)
        bot.use((event, next) -> {
            if (event instanceof MessageEvent msg) {
                bot.getChannelInfo(msg.getChannelId())
                    .thenAccept(info -> {
                        if (info.isEncrypted()) {
                            log.warn("Ignoring event from encrypted channel {}", info.id());
                            return;
                        }
                    });
            }
            next.process(event);
        });

        bot.on("message", (MessageEvent event) -> {
            bot.sendMessage(event.getChannelId(), "Received: " + event.getText());
        });

        bot.connect();
    }
}
```

---

## Appendix A — BotEventType Constants

```java
package chat.nexus.bot.event;

public final class BotEventType {

    private BotEventType() {}

    public static final String MESSAGE           = "message";
    public static final String MESSAGE_EDITED    = "message_edited";
    public static final String MESSAGE_DELETED   = "message_deleted";
    public static final String CHANNEL_CREATED   = "channel_created";
    public static final String CHANNEL_ARCHIVED  = "channel_archived";
    public static final String MEMBER_JOINED     = "member_joined";
    public static final String MEMBER_LEFT       = "member_left";
    public static final String SLASH_COMMAND     = "slash_command";
    public static final String BUTTON_CLICKED    = "button_clicked";
}
```

## Appendix B — Logging Configuration

The SDK uses SLF4J. Bind a concrete implementation at runtime. For development, use Logback:

**logback.xml**

```xml
<configuration>
    <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
        <encoder>
            <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n</pattern>
        </encoder>
    </appender>
    <logger name="chat.nexus.bot" level="INFO"/>
    <root level="WARN">
        <appender-ref ref="STDOUT"/>
    </root>
</configuration>
```

Gradle dependency:

```kotlin
runtimeOnly("ch.qos.logback:logback-classic:1.5.6")
```

---

## Appendix C — Public API Surface Summary

| Method | Return Type | Description |
|--------|------------|-------------|
| `NexusBot(Options)` | — | Constructor |
| `connect()` | `void` | Initiate WebSocket connection (async) |
| `disconnect()` | `void` | Graceful disconnect |
| `isConnected()` | `boolean` | Connection status |
| `getConnectionState()` | `ConnectionState` | Detailed state enum |
| `getSessionId()` | `Optional<String>` | Session ID after auth |
| `on(String eventType, Consumer<T> handler)` | `void` | Register event handler |
| `off(String eventType)` | `void` | Remove all handlers for type |
| `off(String eventType, Consumer<?> handler)` | `void` | Remove specific handler |
| `use(Middleware middleware)` | `void` | Register middleware |
| `onConnect(Runnable callback)` | `void` | Connected callback |
| `onDisconnect(Consumer<String> callback)` | `void` | Disconnect callback (reason) |
| `onPermanentDisconnect(Runnable callback)` | `void` | Reconnect exhausted callback |
| `sendMessage(String channelId, String text)` | `void` | Send plain message |
| `sendMessage(String channelId, String text, MessageOptions opts)` | `void` | Send rich message |
| `editMessage(String channelId, String messageId, String text)` | `void` | Edit message |
| `deleteMessage(String channelId, String messageId)` | `void` | Delete message |
| `sendEphemeral(String channelId, String userId, String text)` | `void` | Ephemeral (single-user) message |
| `getChannelInfo(String channelId)` | `CompletableFuture<ChannelInfo>` | Channel metadata |
| `getMemberList(String channelId)` | `CompletableFuture<List<Member>>` | Channel members |

---

> **Related Documents**:
> - [Async Bot Engine & Event Dispatch Layer — Design Document](../design/04_Async_Bot_Engine_and_Event_Dispatch_Layer.md)
> - [Bot Engine & Microservices — Research Report](../research/bot-engine-microservices.md)
