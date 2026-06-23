---
lang: en
---

# Nexus Chat — UI Component Architecture & Plugin Protocol Design Research Report

> Version: v1.0  
> Date: 2026-06-24  
> Scope: Slack-like instant messaging application frontend architecture design

---

## Table of Contents

1. [Componentized UI Architecture Design](#1-componentized-ui-architecture-design)
2. [Message Rendering Components](#2-message-rendering-components)
3. [Plugin Ecosystem Protocol Design](#3-plugin-ecosystem-protocol-design)
4. [UI Extension Point Design](#4-ui-extension-point-design)
5. [Security Isolation](#5-security-isolation)
6. [Future Extension Directions](#6-future-extension-directions)
7. [Summary & Recommended Solution Matrix](#7-summary--recommended-solution-matrix)

---

## 1. Componentized UI Architecture Design

### 1.1 Design System Layering

Adopt **Atomic Design methodology** for three-tier partitioning, combined with a monorepo package isolation strategy:

```
@nexus-chat/
├── ui/                  # Pure UI component package (no business logic)
│   ├── primitives/      # Raw atomic layer
│   │   ├── Button
│   │   ├── Input
│   │   ├── Icon
│   │   ├── Avatar
│   │   ├── Badge
│   │   ├── Tooltip
│   │   ├── DropdownMenu
│   │   └── Dialog/Modal
│   ├── composites/       # Composite component layer
│   │   ├── MessageBubble
│   │   ├── MessageInput
│   │   ├── ChannelItem
│   │   ├── UserPresence
│   │   ├── EmojiPicker
│   │   ├── CodeBlock
│   │   └── FileAttachment
│   └── tokens/           # Design Tokens
│       ├── colors.css
│       ├── typography.css
│       ├── spacing.css
│       └── shadows.css
├── chat/                 # Business module layer
│   ├── ChatView
│   ├── Sidebar
│   ├── ThreadView
│   ├── ChannelHeader
│   └── SearchPanel
└── sdk/                  # Plugin SDK
    ├── types/
    ├── hooks/
    └── components/
```

**Layering Principles**:

| Layer | Responsibility | Dependency Direction | May Contain Business Logic |
|------|------|----------|---------------|
| Primitives | Single UI interaction unit | Only depends on tokens | No |
| Composites | Composition of multiple atoms, reusable UI fragments | Only depends on primitives | No |
| Modules | Connect data sources, orchestrate full pages | Depends on composites + SDK | Yes |

### 1.2 Component Isolation Strategy

Key measures to fully decouple the `@nexus-chat/ui` package from business logic:

- **No global state dependency**: The ui package does not import Redux/Zustand; all state is passed via props
- **Dependency inversion**: The ui package defines interfaces (e.g., `MessageData`), and the business layer implements specific data fetching
- **Event callback pattern**: Callbacks like `onClick`, `onSubmit` are injected by the business layer; ui components do not directly call APIs
- **Webpack/Rollup externals**: Mark large dependencies like React and ReactDOM as external, provided by the host application

```typescript
// ✅ Correct: MessageBubble in the ui package
interface MessageBubbleProps {
  message: MessageData;          // Pure data interface
  onReact: (emoji: string) => void;  // Business behavior injected via callback
  onReply: () => void;
}

// ❌ Incorrect: Things the ui package should NOT do
// import { sendMessage } from '@nexus-chat/api';
// import { useStore } from '@nexus-chat/store';
```

### 1.3 Component Documentation: Storybook vs Ladle vs Histoire

| Dimension | Storybook 10 | Ladle 4.x | Histoire 0.17 |
|------|-------------|-----------|---------------|
| Cold start time | 8.2s | **1.2s** | 2.1s |
| Hot reload | 2.3s | **0.5s** | 0.8s |
| Interactive Props controls | **Complete** | Basic | Good |
| MDX documentation mode | **Supported** | Not supported | Supported |
| Plugin ecosystem | **1000+ plugins** | None | Limited |
| A11y testing | **Built-in plugin** | Not supported | Not supported |
| Visual regression testing | **Chromatic** | Not supported | Not supported |
| Multi-framework support | **React/Vue/Angular** | React only | Vue/React |
| React 19 support | **Yes** | Yes | Yes |
| Static export | **Yes** | Yes | Yes |
| Weekly downloads | ~10M | ~40K | ~80K |
| GitHub Stars | 84K | 2.6K | 3.2K |
| Node Modules size | ~50MB | ~5MB | ~10MB |

**Recommended: Storybook 10 + `@storybook/react-vite`**

Rationale:
- As a design-system-level project, complete MDX documentation, A11y testing, and visual regression capabilities are needed
- Storybook 10 uses the Vite builder, reducing cold start to ~8s, which is acceptable
- CSF 3.0 format is extremely concise, with TypeScript auto-deriving props controls
- Massive ecosystem advantages: `@storybook/addon-a11y`, Chromatic, `storybook-addon-designs`, etc.

```typescript
// .storybook/main.ts
import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../packages/ui/src/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-links',
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
    '@storybook/addon-interactions',
  ],
  framework: { name: '@storybook/react-vite', options: {} },
  docs: { defaultName: 'Documentation' },
};
export default config;
```

### 1.4 Component Testing Strategy

**Recommended combination: Vitest + @testing-library/react + @testing-library/user-event**

| Test Type | Tool | Coverage Target |
|----------|------|----------|
| Unit testing | Vitest | Component rendering, prop changes, event handling |
| Integration testing | @testing-library/react | User interaction flows, form submission flows |
| Snapshot testing | Vitest snapshot | Key UI state consistency |
| Visual regression | Chromatic + Storybook | Cross-browser visual consistency |
| A11y testing | jest-axe / storybook-addon-a11y | WCAG compliance |
| E2E testing | Playwright | Complete user journeys |

```typescript
// MessageBubble.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { MessageBubble } from './MessageBubble';

describe('MessageBubble', () => {
  it('renders message text', () => {
    render(<MessageBubble message={{ id: '1', text: 'Hello', author: {} }} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('shows action toolbar on hover', async () => {
    const user = userEvent.setup();
    render(<MessageBubble message={mockMessage} onReact={vi.fn()} />);
    await user.hover(screen.getByTestId('message-bubble'));
    expect(screen.getByTestId('message-actions')).toBeVisible();
  });
});
```

---

## 2. Message Rendering Components

### 2.1 Rich Text Message Rendering Pipeline

Message rendering uses a **Pipeline pattern**, passing raw text sequentially through multiple parsers:

```
Raw Text → Markdown Parsing → Emoji Parsing → @mention Parsing → #channel Parsing → React Component Tree
```

**Recommended technology choices**:
- Markdown engine: **markdown-it** (rich plugin ecosystem, CommonMark compatible)
- Mention/channel detection: Custom regex + custom markdown-it plugins
- Automatic link detection: markdown-it built-in + `linkify-it`

```typescript
// Message formatting pipeline
import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';

const md = new MarkdownIt({
  html: false,           // XSS protection, disable raw HTML
  linkify: true,         // Auto-link
  breaks: true,          // Newlines to <br>
  typographer: true,     // Smart quotes
  highlight: (code, lang) => {
    return highlighter.codeToHtml(code, { lang: lang || 'text', theme: 'github-dark' });
  },
});

// Custom @mention plugin
md.use(mentionPlugin, {
  parseUserMention: (username: string) => renderMentionNode(username),
});

// Custom #channel plugin
md.use(channelPlugin, {
  parseChannel: (channelName: string) => renderChannelLink(channelName),
});

// Custom :emoji: shortcode plugin
md.use(emojiPlugin, {
  defs: emojiShortcodeMap,
});
```

### 2.2 Message Attachment Rendering Component Tree

Attachments are dispatched to different renderers by MIME type:

```
MessageAttachment (container)
├── ImageAttachment        → <img> + Lightbox
├── FileAttachment         → File icon + Download button
├── VideoAttachment        → <video> player
├── AudioAttachment        → <audio> player (waveform visualization optional)
├── LinkPreview            → Open Graph card
│   ├── OGImage
│   ├── OGTitle
│   └── OGDescription
└── CodeSnippet            → Syntax-highlighted code block (inline attachment form)
```

```typescript
// Attachment type dispatcher
const AttachmentRenderer: React.FC<{ attachment: Attachment }> = ({ attachment }) => {
  switch (attachment.type) {
    case 'image':
      return <ImageAttachment src={attachment.url} width={attachment.width} />;
    case 'video':
      return <VideoAttachment src={attachment.url} />;
    case 'audio':
      return <AudioAttachment src={attachment.url} />;
    case 'file':
      return <FileAttachment name={attachment.name} size={attachment.size} url={attachment.url} />;
    case 'link':
      return <LinkPreviewCard og={attachment.openGraph} />;
    default:
      return <GenericAttachment {...attachment} />;
  }
};
```

### 2.3 Message Action UI Interactions

| Interaction Type | Trigger Condition | Implementation |
|----------|----------|----------|
| Hover toolbar | Mouse hover on message bubble | CSS `:hover` + `visibility` toggles visibility |
| Right-click menu | Right-click on message | `onContextMenu` + custom Context Menu component |
| Keyboard shortcuts | Global keypress | `useKeyboardShortcuts` hook |

Recommended right-click menu library: **@radix-ui/react-context-menu** (unstyled, fully accessible)

```typescript
// Message action toolbar
const MessageActions: React.FC<{ messageId: string }> = ({ messageId }) => (
  <div className="message-actions" role="toolbar" aria-label="Message actions">
    <IconButton icon="emoji" label="Add reaction" onClick={() => openEmojiPicker(messageId)} />
    <IconButton icon="reply" label="Reply" onClick={() => replyTo(messageId)} />
    <IconButton icon="thread" label="Reply in thread" onClick={() => openThread(messageId)} />
    <IconButton icon="share" label="Share" onClick={() => share(messageId)} />
    <IconButton icon="bookmark" label="Bookmark" onClick={() => bookmark(messageId)} />
    <ContextMenu>
      <MenuItem>Copy link</MenuItem>
      <MenuItem>Copy text</MenuItem>
      <MenuItem>Edit message</MenuItem>
      <MenuItem danger>Delete message</MenuItem>
    </ContextMenu>
  </div>
);
```

### 2.4 Code Block Syntax Highlighting Solutions

| Dimension | Shiki v1.x | Prism v1.x | highlight.js v11.x |
|------|-----------|-----------|-------------------|
| Rendering engine | TextMate (VS Code) | Custom Tokenizer | Custom Parser |
| Rendering location | Server/build-time | Client | Client/Server |
| Accuracy | **Highest (matches VS Code)** | Good | Good |
| Supported languages | 200+ | 300+ | 190+ |
| Number of themes | VS Code themes | CSS themes | 300+ CSS themes |
| Light/dark mode switching | **CSS variables native support** | CSS switch | CSS switch |
| Line numbers | Built-in Transformer | Plugin | Plugin |
| Line highlighting | Built-in Transformer | Plugin | Not supported |
| Diff highlighting | Built-in Transformer | Plugin | Supported |
| Client-side JS size | **0 (SSR)** | ~20KB + language packs | ~30KB + language packs |
| Weekly downloads | ~5M | ~5M | ~10M |

**Recommended: Shiki + server-side/Worker rendering**

For IM applications, code blocks in messages are typically <1000 lines. Shiki highlighting asynchronously on the server or in a Web Worker and returning HTML strings is the optimal choice:

- **Zero client-side JS overhead**: Shiki outputs pure HTML + inline style
- **Dual light/dark mode themes**: Automatic switching via CSS variables, no need to re-highlight
- **Highest accuracy**: Uses the same TextMate grammar engine as VS Code

```typescript
// Create Shiki highlighter in a Web Worker
// worker.ts
import { createHighlighter } from 'shiki';

const highlighter = await createHighlighter({
  themes: ['github-light', 'github-dark'],
  langs: ['javascript', 'typescript', 'python', 'rust', 'go', 'json', 'bash', 'sql'],
});

self.onmessage = async (e) => {
  const { code, lang } = e.data;
  const html = highlighter.codeToHtml(code, {
    lang: lang || 'text',
    themes: { light: 'github-light', dark: 'github-dark' },
  });
  self.postMessage({ html });
};
```

### 2.5 Emoji Picker Component Solutions

| Dimension | emoji-picker-react | emoji-mart | Frimousse (Liveblocks) | Custom |
|------|-------------------|------------|------------------------|--------|
| Bundle size | ~2.59MB | ~1.63MB | ~200KB | Depends on implementation |
| Skin tones | Supported | Supported | Supported | Must implement |
| Search | Supported | **Full search** | Basic | Must implement |
| Recently used | Supported | Supported | Not supported | Must implement |
| Custom emoji | Limited | **Full support** | Supported | Flexible |
| Custom styles | CSS variables | CSS variables | **Headless (no styles)** | Full control |
| Keyboard navigation | Supported | Supported | Supported | Must implement |
| React 19 compatible | Yes | Yes (v5) | Yes | N/A |

**Recommended: emoji-mart v5 (for emoji picker) + Custom rendering (in-message emoji)**

Rationale:
- emoji-mart has the most complete features: search, categories, skin tones, custom emoji sets, recently used
- In-message emoji rendering uses `Intl.Segmenter` or `twemoji` lightweight parsing, no need to load the full picker
- Picker component is code-split via `React.lazy()`, loaded on demand

```typescript
// EmojiPicker.tsx - Lazy-loaded emoji picker
import { lazy, Suspense } from 'react';

const EmojiMartPicker = lazy(() => import('@emoji-mart/react'));

export const EmojiPicker: React.FC<Props> = (props) => (
  <Suspense fallback={<EmojiPickerSkeleton />}>
    <EmojiMartPicker
      set="twitter"
      theme="auto"
      locale="zh"
      onEmojiSelect={(emoji) => props.onSelect(emoji.native)}
      {...props}
    />
  </Suspense>
);
```

---

## 3. Plugin Ecosystem Protocol Design

### 3.1 Plugin Loading Mechanism

#### 3.1.1 Comparison of Three Sandboxing Approaches

| Dimension | iframe Sandbox | Web Worker | Dynamic import |
|------|------------|------------|-------------|
| **DOM isolation** | **Full isolation** (independent rendering context) | No DOM access | Shared DOM |
| **JavaScript isolation** | **Full isolation** (independent global scope) | Independent global scope | Shared global scope |
| **CSS isolation** | **Full isolation** | N/A | Requires Shadow DOM assistance |
| **Memory isolation** | **Full isolation** | Partial isolation | No isolation |
| **Communication** | `postMessage` (async, serialized) | `postMessage` (async, structured clone) | Direct call (synchronous) |
| **Performance overhead** | High (full browser context) | Low (no DOM, no rendering) | **Lowest** |
| **Crash isolation** | **One iframe crash does not affect main app** | One Worker crash does not affect main thread | One plugin crash can drag down the app |
| **Security risk** | **Lowest** (CSP + sandbox attribute) | Medium | High |
| **Use case** | Full UI plugin rendering | Background computation/logic plugins | Highly trusted first-party code |

**Recommended: Hybrid strategy with iframe sandbox as primary + Web Worker as auxiliary**

```typescript
// Plugin loading decision tree
function getPluginSandboxType(manifest: PluginManifest): 'iframe' | 'worker' | 'inline' {
  // Plugins that need to render UI → iframe
  if (manifest.permissions.includes('ui:render')) return 'iframe';

  // Pure background logic (message interception, data processing) → Worker
  if (manifest.permissions.every(p => p.startsWith('hook:') || p.startsWith('api:'))) {
    return 'worker';
  }

  // Nexus Chat official plugins or system built-ins → inline (best performance)
  if (manifest.trustLevel === 'system') return 'inline';

  // Default safest
  return 'iframe';
}
```

#### 3.1.2 iframe Sandbox Configuration

```typescript
// PluginSandbox.tsx
const SANDBOX_FLAGS = [
  'allow-scripts',       // Allow JS execution
  'allow-same-origin',   // Required (for postMessage communication, but must pair with CSP constraints)
  'allow-forms',         // Allow forms
  'allow-popups',        // Allow popups (requires user gesture)
  // Explicitly forbidden:
  // 'allow-top-navigation',  // Forbid navigating top-level window
  // 'allow-popups-to-escape-sandbox',
] as const;

interface PluginIframeProps {
  pluginId: string;
  manifest: PluginManifest;
  width?: string;
  height?: string;
}

export const PluginIframe: React.FC<PluginIframeProps> = ({ pluginId, manifest }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Initialize plugin via postMessage
    const initMessage: PluginInitMessage = {
      type: 'plugin:init',
      pluginId,
      theme: currentTheme,
      locale: currentLocale,
      apiKey: generateSessionKey(pluginId),
    };

    iframe.contentWindow?.postMessage(initMessage, manifest.origin);
  }, [pluginId]);

  return (
    <iframe
      ref={iframeRef}
      src={manifest.entryPoint}
      sandbox={SANDBOX_FLAGS.join(' ')}
      style={{ border: 'none', width: '100%', height: '100%' }}
      title={`Plugin: ${manifest.name}`}
      onLoad={() => setLoaded(true)}
    />
  );
};
```

CSP response header configuration:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' https://api.nexus-chat.dev;
  frame-ancestors 'self';
```

#### 3.1.3 Plugin Lifecycle

```
┌─────────┐    ┌──────────┐    ┌────────────┐    ┌──────────────┐
│ INSTALL │───▶│ ACTIVATE │───▶│   RUNNING   │───▶│ DEACTIVATE   │
└─────────┘    └──────────┘    └────────────┘    └──────────────┘
                     │                │                    │
                     │                │                    │
                     ▼                ▼                    ▼
              ┌──────────┐    ┌────────────┐    ┌──────────────┐
              │  ERROR   │    │   UPDATE    │    │  UNINSTALL   │
              └──────────┘    └────────────┘    └──────────────┘
```

```typescript
// Plugin lifecycle interface
interface PluginLifecycle {
  // Called on install (once only). Used to register extension points, initialize storage
  onInstall(ctx: InstallContext): Promise<void>;

  // Called on each activation. Used to establish WebSocket connections, subscribe to events
  onActivate(ctx: ActivateContext): Promise<void>;

  // Called on each deactivation. Used to clean up resources
  onDeactivate(ctx: DeactivateContext): Promise<void>;

  // Called on uninstall (once only). Used to clean up persistent data
  onUninstall(ctx: UninstallContext): Promise<void>;
}
```

#### 3.1.4 Version Management & Compatibility Declaration

```json
// Version declaration in manifest.json
{
  "version": "1.3.0",
  "minAppVersion": "1.0.0",
  "maxAppVersion": "2.0.0",
  "apiVersion": "v1",
  "dependencies": {
    "@nexus-chat/sdk": "^1.0.0"
  }
}
```

- Follows **SemVer** rules
- `minAppVersion` / `maxAppVersion` declares the compatible host application version range
- `apiVersion` declares the API version used by the plugin (API version is independent of app version)
- The host app validates compatibility before loading a plugin; incompatible plugins are marked as "needs update"

---

### 3.2 Plugin API Design

#### 3.2.1 Injecting UI Extension Points

Referencing the Mattermost Registry pattern, define the following extension registration points:

```typescript
// @nexus-chat/sdk — Plugin SDK interface
interface PluginSDK {
  // ===== UI Extension Points =====
  ui: {
    /** Register right sidebar panel component */
    registerSidebarPanel(panel: SidebarPanelConfig): void;

    /** Register message action button */
    registerMessageAction(action: MessageActionConfig): void;

    /** Register channel header button */
    registerChannelHeaderButton(button: ChannelHeaderButtonConfig): void;

    /** Register settings page card */
    registerSettingsSection(section: SettingsSectionConfig): void;

    /** Register main menu item */
    registerMainMenuItem(item: MenuItemConfig): void;

    /** Register banner above message input box */
    registerComposerBanner(banner: ComposerBannerConfig): void;

    /** Register code block action button */
    registerCodeBlockAction(action: CodeBlockActionConfig): void;

    /** Register slash command */
    registerSlashCommand(command: SlashCommandConfig): void;

    /** Register custom route page */
    registerRoute(route: RouteConfig): void;
  };

  // ===== Hook System =====
  hooks: {
    /** Intercept before message send */
    onBeforeMessageSend(handler: (msg: DraftMessage) => DraftMessage | Promise<DraftMessage>): void;

    /** Process after message received */
    onMessageReceived(handler: (msg: Message) => Message | Promise<Message>): void;

    /** Transform before message render */
    onBeforeMessageRender(handler: (msg: Message) => Message): void;

    /** After channel created */
    onChannelCreated(handler: (channel: Channel) => void): void;

    /** User joined channel */
    onUserJoinedChannel(handler: (data: { user: User; channel: Channel }) => void): void;

    /** Intercept before file upload */
    onBeforeFileUpload(handler: (file: File) => File | Promise<File>): void;

    /** Link resolution */
    onLinkResolve(handler: (url: string) => LinkPreview | null): void;
  };

  // ===== Data Storage =====
  storage: {
    /** Plugin-level isolated storage */
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;

    /** Channel-level storage (isolated per channel) */
    getChannel<T>(channelId: string, key: string): Promise<T | null>;
    setChannel<T>(channelId: string, key: string, value: T): Promise<void>;
  };

  // ===== Host App API =====
  api: {
    /** Get current user info */
    getCurrentUser(): User;

    /** Get current channel info */
    getCurrentChannel(): Channel;

    /** Send message (restricted) */
    sendMessage(channelId: string, text: string): Promise<Message>;

    /** Open Modal */
    openModal(component: React.ComponentType, props: Record<string, unknown>): void;

    /** Show notification */
    showNotification(notification: NotificationConfig): void;
  };
}
```

#### 3.2.2 Plugin Data Storage

Each plugin has an isolated key-value storage space, similar to `localStorage` but isolated by plugin ID:

```typescript
// Storage implementation (based on IndexedDB or host app's storage layer)
class PluginStorage implements PluginSDK['storage'] {
  private pluginId: string;
  private db: IDBDatabase;

  async get<T>(key: string): Promise<T | null> {
    return this.read<T>(`plugin:${this.pluginId}:global:${key}`);
  }

  async set<T>(key: string, value: T): Promise<void> {
    const data = JSON.stringify(value);
    if (data.length > 1024 * 1024) { // 1MB limit
      throw new Error('Storage data exceeds 1MB limit');
    }
    await this.write(`plugin:${this.pluginId}:global:${key}`, data);
  }

  async getChannel<T>(channelId: string, key: string): Promise<T | null> {
    // Requires channels:read permission
    this.assertPermission('channels:read');
    return this.read<T>(`plugin:${this.pluginId}:channel:${channelId}:${key}`);
  }
}
```

**Storage quotas**:
- Per-plugin global storage limit: **5MB**
- Per-channel plugin storage limit: **1MB**
- Total plugin storage limit: **50MB**

#### 3.2.3 Plugin Permission Declaration (manifest.json format design)

Referencing **Chrome Extension Manifest V3** + **Mattermost plugin.json**, design the following manifest format:

```json
{
  "$schema": "https://nexus-chat.dev/schemas/plugin-manifest-v1.json",
  "manifest_version": 1,
  "id": "com.example.translate",
  "name": "Real-time Translation Plugin",
  "version": "1.2.0",
  "minAppVersion": "1.0.0",
  "apiVersion": "v1",
  "description": "Provides one-click translation in messages",
  "author": {
    "name": "Example Corp",
    "email": "dev@example.com",
    "url": "https://example.com"
  },
  "homepage_url": "https://example.com/translate-plugin",
  "support_url": "https://github.com/example/translate-plugin/issues",
  "icon": "assets/icon-128.png",

  "entryPoint": "https://plugins.example.com/translate/v1.2.0/index.html",
  "sandbox": {
    "type": "iframe",
    "permissions": ["allow-scripts", "allow-forms"]
  },

  "permissions": [
    "messages:read",
    "ui:message-action",
    "ui:sidebar-panel",
    "storage:plugin",
    "network:api.translate.example.com"
  ],

  "host_permissions": [
    "https://api.translate.example.com/*"
  ],

  "content_security_policy": {
    "sandbox": "sandbox allow-scripts allow-forms; script-src 'self'; connect-src 'self' https://api.translate.example.com"
  },

  "settings": {
    "targetLanguage": {
      "type": "select",
      "default": "zh-CN",
      "label": "Target translation language",
      "options": [
        { "value": "zh-CN", "label": "Simplified Chinese" },
        { "value": "en", "label": "English" },
        { "value": "ja", "label": "日本語" }
      ]
    },
    "autoTranslate": {
      "type": "boolean",
      "default": false,
      "label": "Auto-translate foreign messages"
    }
  }
}
```

**Permission granularity definitions**:

```typescript
// Permission definitions (referencing Chrome Extension Manifest V3)
type PluginPermission =
  // Message permissions
  | 'messages:read'          // Read message content
  | 'messages:write'         // Send messages as user
  | 'messages:delete'        // Delete messages (own only)
  | 'messages:react'         // Add message reactions

  // Channel permissions
  | 'channels:read'          // Read channel list
  | 'channels:write'         // Create/modify channels
  | 'channels:members:read'  // Read channel members

  // User permissions
  | 'users:read'             // Read user info
  | 'users:profile:read'     // Read user profiles
  | 'users:presence:read'    // Read online status

  // UI extension point permissions
  | 'ui:message-action'      // Message action buttons
  | 'ui:sidebar-panel'       // Sidebar panel
  | 'ui:channel-header'      // Channel header
  | 'ui:settings'            // Settings page
  | 'ui:slash-command'       // Slash commands
  | 'ui:route'               // Custom routes

  // Storage permissions
  | 'storage:plugin'         // Plugin global storage
  | 'storage:channel'        // Channel-level storage

  // Network permissions
  | 'network:api'            // Allow outbound network requests

  // Notification permissions
  | 'notifications'          // Send desktop notifications;
```

#### 3.2.4 Inter-Plugin Communication Mechanism

Adopt an **Event Bus** pattern, relayed through the host app. Direct communication between plugins is not allowed to prevent information leaks:

```typescript
// Inter-plugin communication via host app EventBus
interface PluginEventBus {
  // Publish event (requires 'events:publish' permission)
  publish(topic: string, payload: unknown): void;

  // Subscribe to event (requires 'events:subscribe' permission)
  subscribe(topic: string, handler: (payload: unknown) => void): () => void;
}

// Example: Translation plugin publishes event
pluginSDK.events.publish('translate:complete', {
  originalText: 'Hello',
  translatedText: '你好',
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
});

// Logging plugin subscribes to event
pluginSDK.events.subscribe('translate:complete', (data) => {
  logger.info(`Translated: ${data.originalText} → ${data.translatedText}`);
});
```

**Security constraints**:
- Topic must follow naming convention: `pluginId:eventName` (e.g., `com.example.translate:complete`)
- A plugin cannot subscribe to another plugin's internal events (topics prefixed with `:` are plugin-private)
- The host app performs namespace validation on topics

---

### 3.3 References to Existing IM Plugin Systems

#### 3.3.1 Slack App API / Block Kit

**Core design philosophy**:
- **Block Kit** is a JSON-driven structured UI description language consisting of three layers: _Blocks_, _Block Elements_, and _Composition Objects_
- Blocks are composable visual components (section, header, divider, image, actions, etc.)
- Block Elements are interactive components (button, select menu, datepicker, text input)
- All UI is generated as JSON on the server and rendered on the client — meaning **plugin-provided UI is declarative and cross-platform**
- Max 50 blocks per message, 100 blocks per modal/Home tab

**Implications for Nexus Chat**:
- Plugin-declared UI should use similar **structured descriptions** rather than imperative DOM manipulation
- This ensures UI consistency and accessibility
- Suitable for rendering slash command responses

#### 3.3.2 Discord Bot API

**Core characteristics**:
- Focuses on **server-side Bots**, connected via WebSocket Gateway
- **Slash Commands** are the primary interaction method, supporting options and subcommands
- **Activities** (embedded apps): Real-time multiplayer experiences embedded in iframes
- Component system: Buttons, Select Menus, Modals (structured UI similar to Slack)

**Implications for Nexus Chat**:
- Discord's Activities model is a best-practice case for iframe plugins
- Slash Commands' options/subcommand hierarchy can be reused

#### 3.3.3 Mattermost Plugin System

**Most direct reference — also a Slack-like open-source IM**:

- **plugin.json declaration file**: Defines id, name, version, min_server_version, server executables, webapp bundle
- **Server side**: Written in Go, runs as a Mattermost child process, interacts via Hook methods
- **WebApp side**: JavaScript + React + Redux, lifecycle managed through `PluginClass`'s `initialize(registry, store)` and `uninitialize()`
- **Registry registration system**: Provides **50+ registration methods** (see curated list below) covering nearly all UI extension points
- **Webpack Externals strategy**: React, Redux, etc. provided by the host to avoid duplicate bundling

**Curated Mattermost Registry Extension Points** (most relevant to Nexus Chat):

```
registerPostTypeComponent()             — Custom message type rendering
registerMessageWillBePostedHook()       — Pre-send message hook
registerSlashCommandWillBePostedHook()  — Slash command hook
registerMessageWillFormatHook()         — Message formatting hook
registerPostDropdownMenuAction()        — Message right-click menu
registerChannelHeaderButtonAction()     — Channel header button
registerRightHandSidebarComponent()     — Right-side panel
registerMainMenuAction()                — Main menu item
registerLeftSidebarHeaderComponent()    — Sidebar header
registerBottomTeamSidebarComponent()    — Sidebar bottom
registerCustomRoute()                   — Custom route/page
registerFilePreviewComponent()          — File preview override
registerLinkTooltipComponent()          — Link hover card
registerAdminConsoleCustomSetting()     — Admin console custom settings
registerChannelToastComponent()         — Channel toast notification
registerGlobalComponent()               — Global component
registerAppBarComponent()               — App bar
```

**Implications for Nexus Chat**:
- Mattermost's Registry + Hook pattern is the best reference practice for Slack-like IM plugin systems
- Should adopt a similar "register-callback" pattern, but use **iframe isolation** instead of same-thread execution (key improvement)

#### 3.3.4 Matrix Widget API

**Core characteristics**:
- Widgets run in iframes within Matrix clients
- Communication via `postMessage` + structured message protocol
- **Capability Negotiation**: Widgets request needed permissions; users approve to grant them
- Element client provides Widget layout management (sidebar, pop-up, fullscreen)

**Widget API v2 key design**:
- `fromWidget` / `toWidget` message format
- Standardized actions: `send_event`, `get_room_members`, `open_modal`
- Theme/language/layout sent from client to Widget via `widget:init` message

**Implications for Nexus Chat**:
- Matrix Widget's **iframe + postMessage + capability negotiation** pattern is the gold standard for micro-frontend plugin isolation
- Permission requests use a "user approval" flow, enhancing security
- Theme and language parameters are pushed down from the host app, maintaining UI consistency

#### 3.3.5 Comprehensive Comparison

| Feature | Slack | Discord | Mattermost | Matrix Widget | Nexus Chat Recommended |
|------|-------|---------|------------|---------------|-----------------|
| Plugin execution location | Server | Server | Server + same-thread WebApp | Client iframe | **Client iframe** |
| UI description | Block Kit JSON | Structured components | React component registration | Free HTML/React | **Block Kit style + Free rendering** |
| Isolation | API Gateway | API Gateway | Process isolation (server) / None (web) | iframe isolation | **iframe sandbox** |
| Permission model | OAuth Scopes | OAuth2 Scopes | Declarative | Capability negotiation | **Declarative + User authorization** |
| Plugin communication | No direct communication | No direct communication | Props sharing | In-room events | **EventBus relay** |

---

## 4. UI Extension Point Design

### 4.1 Pluggable UI Positions (Designated Slots)

Based on a comprehensive analysis of Mattermost Registry and Slack extension points, define the following standard extension slots:

```
┌──────────────────────────────────────────────────────────┐
│  app:header-left    App Header         app:header-right  │
├──────────┬───────────────────────────────┬───────────────┤
│          │  sidebar:header               │               │
│          │  ┌─────────────────────────┐  │               │
│          │  │                         │  │               │
│ sidebar  │  │     channel:header      │  │  sidebar:     │
│ :channel │  │  ┌───────────────────┐  │  │  right        │
│ :list    │  │  │ channel:header:   │  │  │  (RHS)        │
│          │  │  │ buttons            │  │  │               │
│ sidebar  │  │  └───────────────────┘  │  │  sidebar:     │
│ :bottom  │  │                         │  │  right:       │
│          │  │     message:list        │  │  panels       │
│          │  │  ┌───────────────────┐  │  │               │
│          │  │  │ message:actions    │  │  │               │
│          │  │  │ message:context    │  │  │               │
│          │  │  │ message:hover-     │  │  │               │
│          │  │  │ toolbar            │  │  │               │
│          │  │  └───────────────────┘  │  │               │
│          │  │                         │  │               │
│          │  │ composer:banner         │  │               │
│          │  │ ┌─────────────────────┐ │  │               │
│          │  │ │  composer           │ │  │               │
│          │  │ └─────────────────────┘ │  │               │
└──────────┴───────────────────────────────┴───────────────┘
```

```typescript
// All available extension slot enumeration
enum ExtensionSlot {
  // ----- App-level -----
  APP_HEADER_LEFT = 'app:header-left',
  APP_HEADER_RIGHT = 'app:header-right',
  MAIN_MENU = 'app:main-menu',
  SETTINGS_PANEL = 'app:settings',

  // ----- Sidebar -----
  SIDEBAR_HEADER = 'sidebar:header',
  SIDEBAR_CHANNEL_LIST_BOTTOM = 'sidebar:bottom',
  SIDEBAR_CHANNEL_ITEM_LABEL = 'sidebar:channel-label',

  // ----- Right-Hand Sidebar (RHS) -----
  RHS_PANEL = 'sidebar:right',

  // ----- Channel -----
  CHANNEL_HEADER_BUTTON = 'channel:header-button',
  CHANNEL_HEADER_ICON = 'channel:header-icon',
  CHANNEL_INTRO = 'channel:intro',
  CHANNEL_TOAST = 'channel:toast',

  // ----- Message -----
  MESSAGE_ACTION = 'message:action',              // Message action button bar
  MESSAGE_CONTEXT_MENU = 'message:context-menu',  // Right-click menu
  MESSAGE_HOVER_TOOLBAR = 'message:hover-toolbar',// Hover toolbar
  MESSAGE_EMBED = 'message:embed',                // In-message embedded content
  MESSAGE_HEADER = 'message:header',              // Message header

  // ----- Code Block -----
  CODE_BLOCK_ACTION = 'code-block:action',

  // ----- File -----
  FILE_ACTION = 'file:action',
  FILE_PREVIEW = 'file:preview',

  // ----- Composer -----
  COMPOSER_BANNER = 'composer:banner',
  COMPOSER_ACTION = 'composer:action',

  // ----- User -----
  USER_POPOVER = 'user:popover',
  USER_PROFILE = 'user:profile',

  // ----- Route -----
  CUSTOM_ROUTE = 'route:custom',
}
```

### 4.2 How Plugins Declare UI to Inject

Adopt a hybrid model of **Slack Block Kit-style structured UI descriptions** and **React component injection**:

```typescript
// 1. Declarative UI description (for simple scenarios — slash command responses, Bot message cards)
const slashResponse: BlockKitPayload = {
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Translation result:*' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '```Hello → 你好\nWorld → 世界```',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Copy translation', emoji: true },
          style: 'primary',
          action_id: 'copy_translation',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'More languages' },
          action_id: 'more_languages',
        },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: 'Provided by *Translation Plugin* · Source language: English (auto-detected)' },
      ],
    },
  ],
};

// 2. React component injection (for complex interactive scenarios — sidebar panels, custom message types)
pluginSDK.ui.registerSidebarPanel({
  id: 'translate-panel',
  title: 'Translation Assistant',
  icon: 'translate-icon',
  component: TranslatePanel,  // React component
  showPopout: true,           // Allow popping out as independent window
});

pluginSDK.ui.registerMessageAction({
  id: 'translate-action',
  label: 'Translate this message',
  icon: 'translate-icon',
  position: 'toolbar',       // 'toolbar' | 'context-menu' | 'both'
  handler: async (message) => {
    const translated = await translate(message.text);
    return {
      type: 'message:reply',
      blocks: buildTranslationBlocks(message.text, translated),
    };
  },
});
```

### 4.3 Performance Isolation

Plugin crashes must not affect the main application:

```typescript
// PluginErrorBoundary.tsx — Wrap each plugin instance with an Error Boundary
class PluginErrorBoundary extends React.Component<
  { pluginId: string; pluginName: string; onCrash: (pluginId: string) => void },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[Plugin ${this.props.pluginId}] crashed:`, error, errorInfo);
    this.props.onCrash(this.props.pluginId);

    // Report crash info (no sensitive data exposed)
    reportPluginCrash({
      pluginId: this.props.pluginId,
      error: error.message,
      stack: error.stack?.slice(0, 500),
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="plugin-error-fallback">
          <p>Plugin "{this.props.pluginName}" encountered an error</p>
          <button onClick={() => this.setState({ hasError: false, error: null })}>
            Retry
          </button>
          <button onClick={() => this.props.onCrash(this.props.pluginId)}>
            Disable Plugin
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

**Memory monitoring & circuit breaking**:

```typescript
// Monitor iframe memory using Performance API
function monitorPluginMemory(pluginId: string): void {
  const checkInterval = setInterval(() => {
    if ('memory' in performance) {
      const mem = (performance as any).memory;
      if (mem.usedJSHeapSize > 100 * 1024 * 1024) { // 100MB circuit breaker
        console.warn(`[Plugin ${pluginId}] Memory limit exceeded, suspending plugin`);
        deactivatePlugin(pluginId);
        clearInterval(checkInterval);
      }
    }
  }, 5000);
}
```

---

## 5. Security Isolation

### 5.1 Plugin Permission Granularity

```
Permission hierarchy tree:

workspace:*  ──────── Workspace level (highest level, admin authorization)
  ├── messages:*
  │   ├── messages:read
  │   ├── messages:write
  │   └── messages:delete
  ├── channels:*
  │   ├── channels:read         ← Channel level
  │   ├── channels:write
  │   └── channels:members:read
  └── users:*
      ├── users:read
      ├── users:profile:read
      └── users:presence:read

channel:* (specific channel) ── Channel level (creator/admin authorization)
  └── messages:read (only for that channel)

personal:* ─────────── Personal level (user self-authorization)
  ├── storage:plugin
  └── notifications
```

### 5.2 CSP Policy Paired with iframe Sandbox

```typescript
// Complete security configuration for plugin iframe
function createPluginIframeConfig(manifest: PluginManifest) {
  // Base sandbox attributes
  const sandbox = [
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    // NEVER include 'allow-same-origin' for third-party plugins
    // This prevents the plugin from accessing the main app's cookies/storage
    ...(manifest.trustLevel === 'system' ? ['allow-same-origin'] : []),
  ];

  // Further restrict via CSP
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",  // Required for React CSS-in-JS
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${manifest.permissions
      .filter(p => p.startsWith('network:'))
      .map(p => p.replace('network:', ''))
      .join(' ')}`,
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    // Forbid in-plugin navigation to parent window
    "sandbox allow-scripts allow-forms allow-popups",
  ].join('; ');

  return { sandbox: sandbox.join(' '), csp };
}
```

### 5.3 User Authorization Flow (OAuth-like)

Plugin installation uses a **consent-based authorization flow**, similar to OAuth 2.0's Authorization Code Grant but adapted for IM scenarios:

```
User clicks "Install Plugin"
        │
        ▼
┌──────────────────────────────┐
│  Permission confirmation     │
│  dialog                      │
│                              │
│  "Translation Plugin"        │
│  requests the following      │
│  permissions:                │
│                              │
│  ⚠ Read message content     │
│  ✓ Add button to message    │
│    action bar                │
│  ✓ Display UI in right      │
│    panel                     │
│  ✓ Store plugin data        │
│  ⚠ Access api.translate.com │
│                              │
│  ⚠ = Sensitive permission   │
│                              │
│  [Deny]          [Allow]     │
└──────────────────────────────┘
        │ (User clicks Allow)
        ▼
┌──────────────────────────────┐
│  Generate Plugin Token       │
│  - pluginId → HMAC signed   │
│  - Includes authorized       │
│    permission scope          │
│  - Validity: 30 days         │
│    (renewable)               │
│  - Stored in plugin sandbox  │
│    storage                   │
└──────────────────────────────┘
        │
        ▼
  Plugin starts loading; all
  API calls carry the token;
  host app validates permissions
```

```typescript
// Permission validation middleware
async function checkPermission(
  pluginId: string,
  requiredPermission: PluginPermission,
  context?: { channelId?: string }
): Promise<boolean> {
  const plugin = pluginManager.get(pluginId);
  if (!plugin) return false;

  // Check if the plugin declared this permission
  if (!plugin.manifest.permissions.includes(requiredPermission)) return false;

  // Check if the user authorized this permission
  const grantedPermissions = await storage.get(`auth:${pluginId}:permissions`);
  if (!grantedPermissions?.includes(requiredPermission)) return false;

  // Channel-level permissions require additional validation
  if (context?.channelId && requiredPermission.startsWith('channels:')) {
    const memberOf = await channelService.isMember(context.channelId);
    if (!memberOf) return false;
  }

  return true;
}
```

### 5.4 Plugin Signing & Supply Chain Security

```json
// Validate plugin package signature
{
  "signature": {
    "algorithm": "ed25519",
    "publicKey": "base64...",
    "signature": "base64..."
  },
  "integrity": {
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  }
}
```

- Plugins installed from the plugin marketplace must carry a signature
- Local plugins in developer mode may skip signature
- Subresource Integrity (SRI) hash is used for iframe resource loading validation

---

## 6. Future Extension Directions

### 6.1 How Bots Evolve into a Special Case of Plugins

In Nexus Chat's architecture, **a Bot is simply a plugin without UI**:

```
Plugin
├── UI Plugin (has interface)
│   ├── Loaded in iframe sandbox
│   ├── Can register UI extension points
│   └── Requires ui:* permissions
│
└── Bot (UI-less plugin special case)
    ├── Runs in Web Worker or lightweight context
    ├── Only processes messages/commands/events
    └── Only requires permissions like messages:read/write
```

```typescript
// Bot is a subset of Plugin
interface BotManifest extends PluginManifest {
  bot: {
    commands: SlashCommandConfig[];      // Supported slash commands
    events: BotEventSubscription[];      // Subscribed events
    webhook?: string;                    // Outgoing Webhook URL
  };
}

// Bot runs via hooks, no UI needed
class BotRuntime implements PluginLifecycle {
  async onActivate(ctx: ActivateContext) {
    // Register slash commands
    for (const cmd of this.manifest.bot.commands) {
      ctx.sdk.ui.registerSlashCommand(cmd);
    }

    // Subscribe to events
    ctx.sdk.hooks.onMessageReceived(async (msg) => {
      if (msg.text.startsWith(`@${this.manifest.bot.name}`)) {
        return this.handleMention(msg);
      }
      return msg;
    });
  }
}
```

### 6.2 Custom Command Framework

The slash command system is designed with **three-layer parsing + middleware + plugin dispatch**:

```
User input: /translate en zh Hello World
           │
           ▼
    ┌──────────────┐
    │  Command      │
    │  Parser       │
    └──────┬───────┘
           │
           ▼
    /command  subcommand  [...args]
    translate  en→zh      Hello World
           │
           ▼
    ┌──────────────┐
    │  Command      │──→ Look up registered plugin
    │  Router       │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  Permission   │──→ Verify plugin has ui:slash-command
    │  Check        │
    └──────┬───────┘
           │
           ▼
    ┌──────────────┐
    │  Execute      │──→ Call plugin.onCommand(ctx, args)
    │  command,     │
    │  return result│
    └──────────────┘
```

```typescript
// Command registration
interface SlashCommandConfig {
  /** Command name (without /) */
  name: string;

  /** Command description */
  description: string;

  /** Usage instructions */
  usage?: string;

  /** Subcommands */
  subcommands?: SlashCommandConfig[];

  /** Parameter definitions */
  options?: CommandOption[];

  /** Command handler function */
  handler: (ctx: CommandContext) => Promise<CommandResponse>;

  /** Autocomplete */
  autocomplete?: (ctx: AutocompleteContext) => Promise<AutocompleteSuggestion[]>;
}
```

### 6.3 Custom Message Type Registration

```typescript
// Plugins can register new message types
pluginSDK.ui.registerMessageType({
  type: 'com.example.poll',
  component: PollMessageRenderer,
  composeComponent: PollMessageComposer,
  icon: 'poll-icon',
  label: 'Poll',
});

// Custom message data structure
interface PollMessage extends Message {
  type: 'com.example.poll';
  payload: {
    question: string;
    options: { id: string; text: string; votes: number }[];
    isMultiSelect: boolean;
    endsAt: string;  // ISO 8601
  };
}
```

---

## 7. Summary & Recommended Solution Matrix

### 7.1 Technology Stack Overview (as of mid-2026)

| Domain | Recommended | Version | Alternative |
|------|----------|------|----------|
| Build tool | Vite | 6.x | Turbopack |
| UI framework | React | 19.x | — |
| CSS approach | Tailwind CSS | 4.x + CSS Modules | Vanilla Extract |
| Component docs | Storybook + Vite | 10.x | Histoire (Vue projects) |
| Unit testing | Vitest | 3.x | — |
| Component testing | @testing-library/react | 16.x | — |
| E2E testing | Playwright | 1.52+ | — |
| Syntax highlighting | Shiki | 1.x | Prism |
| Emoji picker | emoji-mart | 5.x | emoji-picker-react |
| Markdown rendering | markdown-it | 14.x | micromark |
| Right-click menu | @radix-ui/react-context-menu | 2.x | — |
| Headless UI | @radix-ui/* | 2.x | Headless UI |
| Monorepo | Turborepo + pnpm | 2.x | Nx |
| State management | Zustand | 5.x | Jotai |
| Internationalization | i18next + react-i18next | 24.x | — |
| Date handling | date-fns | 4.x | dayjs |

### 7.2 Core Plugin System Design Decisions

| Decision Point | Choice | Rationale |
|--------|------|------|
| Plugin sandbox method | **iframe** as primary, Worker as auxiliary | Full DOM/CSS/JS isolation; crashes don't affect main app |
| UI description method | **React component injection + Block Kit-style JSON** | Complex UI uses React, simple responses use declarative JSON |
| Permission model | **Declarative permissions + User authorization** | Hybrid model referencing Chrome MV3 + OAuth2 |
| Plugin communication | **EventBus relay (no direct connection)** | Prevents information leakage between plugins |
| Plugin loading | **Dynamic import + Lazy loading** | On-demand loading, reduces initial bundle size |
| Version compatibility | **SemVer + minAppVersion/maxAppVersion** | Clear compatibility ranges, avoids runtime errors |
| Storage isolation | **KV Store isolated by plugin ID** | Based on IndexedDB, with quota limits |

### 7.3 Architecture Decision Record (ADR) Summary

```
ADR-001: Choose iframe sandbox as the plugin isolation solution
  Rationale: Compared to same-thread loading (Mattermost model), iframe provides full
  DOM/CSS/JS isolation; a single plugin crash won't white-screen the entire app.
  Cost: Communication via postMessage serialization has performance overhead (acceptable).
  Alternatives: Web Worker cannot render UI; Shadow DOM cannot isolate JS.

ADR-002: Adopt Mattermost Registry pattern for UI extension point design
  Rationale: Battle-tested at scale, 50+ registration methods cover nearly all IM UI scenarios.
  Enhancement: Combine with Block Kit declarative UI for simple Bot responses.

ADR-003: Shiki preferred over Prism/highlight.js
  Rationale: Zero client-side JS, VS Code-level accuracy, built-in dual light/dark theme support.

ADR-004: Plugin manifest referencing Chrome Extension MV3
  Rationale: MV3 is a security-audited, mature permission declaration model widely familiar to web developers.
```

---

> **Report complete.** This report is written based on the latest library versions and industry practices as of June 2026. Each section's recommended solutions are accompanied by code examples and trade-off analysis. The plugin protocol design references practical experience from four mature IM systems — Slack, Discord, Mattermost, and Matrix — and incorporates frontend performance and security best practices to arrive at the final recommended architecture.
