---
lang: en
---

# Nexus Chat Security Defense & E2EE End-to-End Encryption Roadmap

> Version: v1.0 | Last Updated: 2026-06-24 | Status: Research & Planning Phase

---

## Table of Contents

1. [Low-Cost Security Defense Solutions (Phase 1 Deliverable)](#1-low-cost-security-defense-solutions)
2. [Signal Protocol Integration Deep Dive](#2-signal-protocol-integration-deep-dive)
3. [E2EE Future Roadmap](#3-e2ee-future-roadmap)
4. [Threat Model](#4-threat-model)
5. [Compliance & Privacy](#5-compliance--privacy)

---

## 1. Low-Cost Security Defense Solutions

> **Phase Goal**: Establish a defense-in-depth baseline early in application development. All solutions have extremely low cost (mostly open-source free libraries) but can effectively defend against 90%+ of common attacks.

### 1.1 Infrastructure Layer

#### 1.1.1 Helmet.js — HTTP Security Headers

**Recommended Version**: `helmet@^8.1.0` (latest stable as of mid-2026)

Helmet 8.x has deprecated the default CSP (since CSP needs app-specific customization), switching to an explicit configuration model. Recommended configuration:

```typescript
// server/middleware/helmet.ts
import helmet from 'helmet';

export const securityHeaders = helmet({
  // CSP configured separately (see next section)
  contentSecurityPolicy: false,

  // X-DNS-Prefetch-Control: off
  // Prevents browser DNS prefetch (leaks user browsing behavior)
  dnsPrefetchControl: { allow: false },

  // X-Frame-Options: DENY
  // Prevents page from being embedded in iframe, defends against Clickjacking
  frameguard: { action: 'deny' },

  // X-Powered-By: removed
  // Don't leak server tech stack
  hidePoweredBy: true,

  // Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  // Enforce HTTPS, 2-year validity
  hsts: {
    maxAge: 63072000,        // 2 years (seconds)
    includeSubDomains: true,  // Include subdomains
    preload: true,            // Submit to browser HSTS preload list
  },

  // X-Content-Type-Options: nosniff
  // Prevent MIME type sniffing
  noSniff: true,

  // Referrer-Policy: strict-origin-when-cross-origin
  // Cross-origin: only send origin (no path); same-origin: full URL
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

  // X-XSS-Protection: 0
  // Disable browser built-in XSS filter (obsolete, modern browsers rely on CSP)
  xssFilter: true,

  // Cross-Origin-Embedder-Policy: require-corp
  // Enable cross-origin isolation (required when using SharedArrayBuffer)
  crossOriginEmbedderPolicy: true,

  // Cross-Origin-Opener-Policy: same-origin
  // Prevent cross-origin window access (Spectre mitigation)
  crossOriginOpenerPolicy: { policy: 'same-origin' },

  // Cross-Origin-Resource-Policy: same-origin
  // Restrict resource loading sources
  crossOriginResourcePolicy: { policy: 'same-origin' },

  // Origin-Agent-Cluster: ?1
  // Request browser-level process isolation per origin
  originAgentCluster: true,

  // Permissions-Policy
  // Restrict browser API usage permissions
  permissionsPolicy: {
    features: {
      camera:            ["'self'"],
      microphone:        ["'self'"],
      geolocation:       ["'none'"],
      payment:           ["'none'"],
      'display-capture': ["'self'"],
      'screen-wake-lock':["'self'"],
    },
  },
});
```

**Recommendation**: Use the above Helmet 8.x configuration as your baseline. CSP is handled separately (see below). All headers default to the strictest policy; relax on demand.

---

#### 1.1.2 Strict CORS Policy

**Recommended Library**: `cors@^2.8.6`

```typescript
// server/middleware/cors.ts
import cors from 'cors';

const ALLOWED_ORIGINS = [
  'http://localhost:5173',          // Vite dev server
  'http://localhost:3000',          // Backup dev
  'app://nexus-chat',               // Electron custom protocol
  'https://nexus-chat.example.com', // Production domain
];

export const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. Postman, curl, Electron file:// protocol)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS blocked: origin not allowed'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  credentials: true,              // Allow cookies
  maxAge: 86400,                  // Preflight request cache 24h
  optionsSuccessStatus: 204,
});
```

**Recommendation**: Use a whitelist approach — only allow known origins. In production, strictly prohibit `Access-Control-Allow-Origin: *`.

---

#### 1.1.3 CSP (Content-Security-Policy)

**Special Considerations for Electron Environment**:

An Electron app essentially loads HTML locally — there is no classic XSS scenario of "externally injected scripts". However, CSP remains an important defense-in-depth layer. Key differences:

| Traditional Web App | Electron App |
|---|---|
| Resources come from multiple CDN domains | Resources are typically bundled locally |
| CSP requires `https://` source whitelisting | Can use `'self'` or `app://` protocol |
| `unsafe-eval` not allowed (strict mode) | May be needed in some cases (e.g. Webpack devtool) |
| `connect-src` points to API domains | Points to local WebSocket / API server |

**Recommended Configuration (Electron Production)**:

```typescript
// server/middleware/csp.ts
const cspConfig = {
  directives: {
    // default-src: fallback policy
    'default-src': ["'none'"],

    // script-src: script sources
    'script-src': [
      "'self'",
      // Dev environment needs Webpack HMR inline script
      // Production removes 'unsafe-inline', using nonce or hash instead
      ...(isDev ? ["'unsafe-inline'", "'unsafe-eval'"] : []),
    ],

    // style-src: style sources
    'style-src': [
      "'self'",
      "'unsafe-inline'",  // CSS-in-JS / styled-components requires this
    ],

    // img-src: image sources
    'img-src': [
      "'self'",
      'data:',            // Inline base64 images
      'blob:',            // Local file previews
      'https:',           // External images (user avatars, etc.)
    ],

    // font-src: font sources
    'font-src': ["'self'", 'data:'],

    // connect-src: network request targets
    'connect-src': [
      "'self'",
      'ws://localhost:*',        // WebSocket (dev)
      'wss://nexus-chat.example.com', // WebSocket (production)
      'https://api.nexus-chat.example.com',
    ],

    // media-src: audio/video sources
    'media-src': ["'self'", 'blob:'],

    // frame-src: iframe sources (e.g. OAuth login page)
    'frame-src': ["'self'"],

    // object-src: disallow Flash/Plugin
    'object-src': ["'none'"],

    // base-uri: restrict <base> tag
    'base-uri': ["'self'"],

    // form-action: restrict form submission targets
    'form-action': ["'self'"],

    // upgrade-insecure-requests: auto-upgrade HTTP to HTTPS
    'upgrade-insecure-requests': !isDev,

    // Production: force enable
    'report-uri': ['/api/csp-report'],
  },
};

// In Electron main process:
// If loading bundled HTML via loadURL, CSP is set in HTML <meta>
// If loading remote URL via BrowserWindow, CSP is set in HTTP response headers
```

**Electron Main Process Security Configuration**:

```typescript
// electron/main.ts
import { app, BrowserWindow, session } from 'electron';

app.whenReady().then(() => {
  // Register custom protocol (instead of file://)
  // protocol.registerSchemesAsPrivileged must be called before app.ready

  const mainWindow = new BrowserWindow({
    webPreferences: {
      // Disable Node.js integration (required!)
      nodeIntegration: false,
      // Enable context isolation (required!)
      contextIsolation: true,
      // Enable sandbox (required!)
      sandbox: true,
      // Disable remote module
      enableRemoteModule: false,
      // Preload script
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Intercept all network requests, set CSP header
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob: https:; connect-src 'self' ws: wss: https:; " +
          "font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'self'",
        ],
      },
    });
  });
});
```

**Recommendation**: In Electron, CSP must be configured in two places: HTTP response headers (backend API) and the Electron main process (rendering pages). In production, strictly ban `'unsafe-eval'` and replace `'unsafe-inline'` with nonce or hash.

---

#### 1.1.4 HTTPS Enforcement + HSTS

- **Electron Client — Backend API**: Production must use HTTPS (TLS terminated via reverse proxy like Nginx/Caddy).
- **Local Communication**: Communication between Electron main process and renderer process uses IPC (not over the network), so HTTPS is not needed.
- **HSTS**: Already enabled in Helmet configuration (`maxAge: 2 years, preload: true`).

**Dev Environment**: Use `mkcert` to generate locally-trusted certificates, paired with Vite dev server's HTTPS mode.

```bash
# Install mkcert and generate local certificates
brew install mkcert
mkcert -install
mkcert localhost 127.0.0.1 ::1
```

**Recommendation**: 100% HTTPS in production, HSTS preload enabled. Use mkcert in development.

---

#### 1.1.5 Dependency Vulnerability Scanning

**Recommended Toolchain**:

| Tool | Purpose | Frequency | Command |
|---|---|---|---|
| `npm audit` | Basic vulnerability scan | Every `npm install` | `npm audit` / `npm audit fix` |
| `pnpm audit` | pnpm ecosystem scan | In CI | `pnpm audit --audit-level=high` |
| Snyk | Deep scan + fix suggestions | CI + periodic | `snyk test` / `snyk monitor` |
| Socket.dev | Supply chain security (malicious package detection) | In CI | `socket scan` |
| Dependabot / Renovate | Automated dependency update PRs | Automatic (GitHub) | Configure `.github/dependabot.yml` |
| OSSF Scorecard | Open-source project health assessment | In CI | GitHub Action |

**CI Integration Example (GitHub Actions)**:

```yaml
# .github/workflows/security-scan.yml
name: Security Scan
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'  # Every Monday UTC 6:00

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm audit --audit-level=high

  snyk:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Snyk Scan
        uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
        with:
          args: --severity-threshold=high
```

**Recommendation**: Enforce `npm/pnpm audit --audit-level=high` in CI to block merging of high-severity vulnerabilities. Periodically run Snyk + Socket.dev for deep scanning. Enable Dependabot for automated upgrades.

---

### 1.2 Authentication & Authorization

#### 1.2.1 JWT Best Practices

**Recommended Library**: `jose@^6.0.0` (preferred over `jsonwebtoken` — supports more algorithms, native ESM)

**Dual Token Strategy**:

| Token Type | Validity | Storage Location | Purpose |
|---|---|---|---|
| Access Token (JWT) | 15 minutes | Electron memory (variable) | API authentication |
| Refresh Token (JWT) | 7 days | Secure storage (electron-store + safeStorage encryption) | Exchange for new Access Token |
| Refresh Token Rotation | — | Old Refresh Token is revoked and a new one is issued | Prevent long-term theft |

**Access Token Payload Design**:

```typescript
interface AccessTokenPayload {
  sub: string;           // Unique user ID
  username: string;      // Username
  jti: string;           // JWT ID (for anti-replay/revocation)
  iat: number;           // Issued at
  exp: number;           // Expiration (15min)
  type: 'access';
  // Does not include permissions/roles — queried in real-time on API request
}
```

**JWT Signing Configuration**:

```typescript
// server/auth/jwt.ts
import * as jose from 'jose';

// Use RS256 (asymmetric) instead of HS256 (symmetric) —
// Advantage: multiple microservices can independently verify, no shared key needed
const alg = 'RS256';

// Load keys from env vars / secret manager
const privateKey = await jose.importPKCS8(process.env.JWT_PRIVATE_KEY!, alg);
const publicKey = await jose.importSPKI(process.env.JWT_PUBLIC_KEY!, alg);

// Issue Access Token
export async function signAccessToken(payload: Omit<AccessTokenPayload, 'iat' | 'exp' | 'jti' | 'type'>) {
  return jose.signJWT(
    { ...payload, type: 'access' },
    { alg: 'RS256' },
    {
      issuer: 'nexus-chat',
      audience: 'nexus-chat-api',
      expiresIn: '15m',
      jwtId: crypto.randomUUID(),
    },
    privateKey,
  );
}

// Issue Refresh Token (longer validity, used for rotation)
export async function signRefreshToken(sub: string, familyId: string) {
  return jose.signJWT(
    { sub, type: 'refresh', familyId },
    { alg: 'RS256' },
    {
      issuer: 'nexus-chat',
      audience: 'nexus-chat-api',
      expiresIn: '7d',
      jwtId: crypto.randomUUID(),
    },
    privateKey,
  );
}

// Verify
export async function verifyToken(token: string) {
  const { payload } = await jose.jwtVerify(token, publicKey, {
    issuer: 'nexus-chat',
    audience: 'nexus-chat-api',
  });
  return payload;
}
```

**Refresh Token Rotation (Core Anti-Theft Mechanism)**:

```typescript
// server/auth/refresh.ts

// On each use of Refresh Token:
// 1. Verify old Refresh Token
// 2. Check whether this token has been used (replay detection)
// 3. If already used → revoke all tokens in that family (indicates token theft)
// 4. If not used → mark old token as used → issue new token pair

export async function rotateRefreshToken(oldRefreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const payload = await verifyRefreshToken(oldRefreshToken);
  const isUsed = await redis.exists(`used_token:${payload.jti}`);

  if (isUsed) {
    // Token replayed → revoke entire family
    await redis.set(`revoked_family:${payload.familyId}`, '1', { EX: 7 * 86400 });
    throw new Error('Token reuse detected — refresh token family revoked');
  }

  // Mark as used (set TTL matching remaining validity)
  const ttl = payload.exp! - Math.floor(Date.now() / 1000);
  await redis.set(`used_token:${payload.jti}`, '1', { EX: ttl });

  // Issue new token pair
  const accessToken = await signAccessToken({ sub: payload.sub!, username: payload.username! });
  const refreshToken = await signRefreshToken(payload.sub!, payload.familyId!);

  return { accessToken, refreshToken };
}
```

**Recommendation**:
- Access Token: 15 minutes, stateless JWT (RS256), stored in memory
- Refresh Token: 7 days, rotation mechanism, stored in Electron encrypted storage
- Token revocation: Redis denylist (`used_token:{jti}` + `revoked_family:{familyId}`)
- Never use localStorage/sessionStorage to store tokens (XSS can read them)

---

#### 1.2.2 Password Storage

**OWASP 2026 Recommended Priority**: Argon2id > scrypt > bcrypt > PBKDF2

**Choice: Argon2id**

| Property | Argon2id | bcrypt |
|---|---|---|
| GPU-cracking resistance | Strong (memory-hard function) | Weak (CPU-hard only) |
| Side-channel attack resistance | Medium (id variant balances) | Medium |
| Configurable parameters | Memory + iterations + parallelism | Iteration rounds only |
| Max password length | Unlimited (theoretical) | 72 bytes |
| Node.js support | `argon2@^0.41.1` (native bindings) | `bcrypt@^6.0.0` |
| OWASP recommendation | First choice | Legacy systems only |

**Recommended Library**: `argon2@^0.41.1` (latest stable as of mid-2026, Rust-based implementation)

**Recommended Parameters** (OWASP 2026 configuration):

```typescript
// server/auth/password.ts
import * as argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type: argon2.argon2id,            // Argon2id variant
  memoryCost: 19456,                // 19 MiB memory (OWASP recommended minimum)
  timeCost: 2,                      // 2 iterations
  parallelism: 1,                   // Single thread
  hashLength: 32,                   // 256-bit hash output
  saltLength: 16,                   // 128-bit salt
  raw: false,                       // Output PHC format string (includes params, supports future upgrades)
};

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

// Check if params need upgrading (e.g. memory or iteration count increased)
export function needsRehash(hash: string): boolean {
  // Parse params in PHC format
  const match = hash.match(/m=(\d+),t=(\d+),p=(\d+)/);
  if (!match) return true;
  const [_, mem, time, parallel] = match;
  return (
    parseInt(mem) < ARGON2_OPTIONS.memoryCost ||
    parseInt(time) < ARGON2_OPTIONS.timeCost ||
    parseInt(parallel) < ARGON2_OPTIONS.parallelism
  );
}
```

**Optional Enhancement: Server-Side Pepper (Additional Defense Layer)**:

```typescript
// Pre-hash password with HMAC-SHA256; Pepper stored in env var / key management service
import { createHmac } from 'node:crypto';

function applyPepper(password: string): string {
  const pepper = process.env.PASSWORD_PEPPER!;  // At least 128-bit random value
  return createHmac('sha256', pepper).update(password).digest('hex');
}

// Full flow: argon2(HMAC-SHA256(password, pepper))
const hashed = await argon2.hash(applyPepper(password), ARGON2_OPTIONS);
```

**Recommendation**: New projects should use Argon2id directly (m=19456, t=2, p=1). Optionally add Pepper for extra protection after database leakage (Pepper is not in the database).

---

#### 1.2.3 Multi-Factor Authentication (TOTP) — Reserved Interface

**Phase 1 does not need implementation, but table structure should be reserved**:

```sql
-- Database table design (reserved)
CREATE TABLE user_mfa (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK(type IN ('totp', 'webauthn', 'recovery_code')),
  secret      TEXT NOT NULL,       -- TOTP secret (encrypted storage)
  verified_at TEXT,                -- Whether activated
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, type)
);

-- TOTP Recovery Codes (hash of encrypted storage)
CREATE TABLE mfa_recovery_codes (
  id        TEXT PRIMARY KEY,
  mfa_id    TEXT NOT NULL REFERENCES user_mfa(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,         -- SHA-256 hash of recovery code
  used_at   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Reserved API Interfaces**:

| Endpoint | Method | Phase 1 Behavior |
|---|---|---|
| `/auth/mfa/setup` | POST | Returns `501 Not Implemented` |
| `/auth/mfa/verify` | POST | Returns `501` |
| `/auth/mfa/disable` | DELETE | Returns `501` |
| `/auth/mfa/recovery` | POST | Returns `501` |

**Recommendation**: Phase 1 only reserves the data model and API paths — no implementation. TOTP uses `otplib@^12.0.0`.

---

#### 1.2.4 OAuth2 / OIDC — SSO Reserved

**Recommended Library (for future implementation)**: `openid-client@^6.0.0` (Certified OpenID Connect RP)

**Phase 1 Reserved Design**:

```sql
-- OAuth2 Connection Table
CREATE TABLE oauth_connections (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,       -- 'google', 'github', 'oidc'
  provider_id TEXT NOT NULL,       -- External user ID
  email       TEXT,
  access_token TEXT,               -- Encrypted storage
  refresh_token TEXT,              -- Encrypted storage
  token_expires_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_id)
);
```

**Recommendation**: Phase 1 only reserves the table structure and `POST /auth/oauth/{provider}` endpoint (returns 501). Future implementation uses `openid-client` + PKCE flow.

---

#### 1.2.5 API Key vs Token Use Cases

| Scenario | Recommended Solution | Reason |
|---|---|---|
| User login session | JWT Access Token + Refresh Token | Has expiration, revocable, stateless verification |
| Bot / third-party integration | API Key (SHA-256 hash stored) | Long-lived, scope-limited, individually revocable |
| WebSocket authentication | Pass JWT on connection, verify then establish session | Initial handshake auth, subsequent state-based |
| Inter-service calls | mTLS + short-lived JWT | Mutual authentication |

**API Key Design**:

```typescript
// API Key format: nxc_<base64url(32-byte random)>
// e.g.: nxc_k3F7xQ... → SHA-256 hash stored in database
//
// Displayed only once to the user at generation time (like GitHub PAT)
// Database: api_key_hash = SHA-256(api_key_raw)
// Verification: SHA-256(user-provided key) === hash in database

import { createHash, randomBytes } from 'node:crypto';

export function generateApiKey(): { raw: string; hash: string } {
  const raw = 'nxc_' + randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

export function verifyApiKey(raw: string, hash: string): boolean {
  return createHash('sha256').update(raw).digest('hex') === hash;
}
```

**Recommendation**: Use JWT for user sessions, API Key for bots/integrations (displayed only once at generation, stored as SHA-256 hash).

---

### 1.3 API Security

#### 1.3.1 Rate Limiting

**Recommended Library**: `express-rate-limit@^7.6.0`

```typescript
// server/middleware/rate-limit.ts
import rateLimit from 'express-rate-limit';

// Global limit: 100 req / 15min (per IP)
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,   // RateLimit-* headers
  legacyHeaders: false,    // Disable X-RateLimit-* headers
  message: { error: 'Too many requests, please try again later.' },
});

// Auth endpoints: 5 req / 15min (anti-brute-force)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts.' },
  // Production: use Redis store for multi-instance support
  // store: new RedisStore({ client: redisClient }),
});

// API endpoints: 30 req / 1min (per user ID, after auth)
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.id || req.ip,  // Prefer user ID
  standardHeaders: true,
  legacyHeaders: false,
});

// Message sending: 10 req / 1min (anti-spam)
export const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user?.id || req.ip,
});
```

**Recommendation**: Multi-tier rate limiting — global 100/15min + auth 5/15min + API 30/1min. Production uses Redis store for multi-instance deployments.

---

#### 1.3.2 Request Body Size Limit

```typescript
// server/index.ts
import express from 'express';

const app = express();

// JSON request body limit
app.use(express.json({ limit: '1mb' }));

// URL-encoded request body limit
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// File uploads need higher limits — use dedicated routes
// app.use('/upload', express.json({ limit: '50mb' }));
```

**Recommendation**: Global 1MB limit. File upload routes exception: 50MB + file type allowlist validation.

---

#### 1.3.3 SQL Injection Prevention

**Drizzle ORM natively uses parameterized queries** — no string concatenation SQL scenarios exist.

```typescript
// Drizzle example — safe (parameterized query)
const user = await db
  .select()
  .from(users)
  .where(eq(users.username, inputUsername))  // ✅ Auto-parameterized
  .limit(1);

// If raw queries are necessary (e.g. complex reports):
const result = await db.execute(
  sql`SELECT * FROM messages WHERE channel_id = ${channelId}`  // ✅ tagged template auto-parameterized
);

// ❌ Never do this:
// const result = await db.execute(
//   `SELECT * FROM users WHERE username = '${inputUsername}'`
// );
```

**Recommendation**: Drizzle ORM already provides parameterized query protection. In CI, add SQL injection scanning rules (e.g. Semgrep) as an extra check layer.

---

#### 1.3.4 XSS Prevention

**Multi-layered Defense**:

| Defense Layer | Mechanism | Scope |
|---|---|---|
| React default escaping | JSX `{userInput}` auto-escapes HTML | Render layer |
| DOMPurify | Allowlist filtering on `dangerouslySetInnerHTML` content | Rich text rendering |
| CSP (Content-Security-Policy) | Blocks inline scripts + unknown external scripts | Browser policy layer |
| Input validation | Server-side validation of all inputs (zod schema) | API layer |

```typescript
// XSS prevention for rich text messages
import DOMPurify from 'dompurify';

// In render component:
function MessageBody({ html }: { html: string }) {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'code', 'pre', 'br', 'p', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
  });
  return <div dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

// Server-side Zod validation (input sanitization)
import { z } from 'zod';

const MessageSchema = z.object({
  content: z.string().min(1).max(40000),
  channelId: z.string().uuid(),
});
```

**Recommendation**: React default escaping + DOMPurify allowlist (rich text scenarios) + CSP + Zod input validation = defense in depth.

---

#### 1.3.5 CSRF Prevention

**Electron Environment Characteristics**: CSRF attacks typically require the browser to automatically send cookies in the background, but Electron uses a custom protocol (`app://`) to load pages and does not use traditional browser cookies. However, protection is still needed:

```typescript
// Strategy 1: SameSite Cookie (primary defense)
// Set auth cookie to SameSite=Strict or Lax
res.cookie('session', token, {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',   // Strict same-site policy
  maxAge: 15 * 60 * 1000,
});

// Strategy 2: CSRF Token (API endpoints)
// If API uses cookie auth (not JWT Header)
import { doubleCsrf } from 'csrf-csrf';

const { generateToken, doubleCsrfProtection } = doubleCsrf({
  getSecret: () => process.env.CSRF_SECRET!,
  cookieName: 'csrf-token',
  cookieOptions: {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
  },
});

// GET /api/csrf-token -> returns token (frontend reads on request)
app.get('/api/csrf-token', (req, res) => {
  const token = generateToken(req, res);
  res.json({ token });
});

// POST /api/* -> auto-verify CSRF token
app.use('/api', doubleCsrfProtection);
```

**Recommendation**: If using cookie authentication, enable SameSite=Strict + CSRF Token. If using pure JWT Header authentication (`Authorization: Bearer xxx`), CSRF attacks are ineffective (browser won't auto-add this header), so no additional CSRF protection is needed.

> **nexus-chat recommendation**: Use JWT Header authentication — no CSRF Token needed. This is a simpler and more secure approach.

---

### 1.4 Data Security

#### 1.4.1 Encrypted Storage of Sensitive Fields

**Encryption Tiering Strategy**:

| Data Type | Storage Method | Encryption Scheme |
|---|---|---|
| User password | One-way hash | Argon2id (irreversible) |
| Bot Token / API Key | One-way hash (for verification) | SHA-256 |
| TOTP Secret | Reversible encryption | AES-256-GCM (decrypt when needed) |
| OAuth Refresh Token | Reversible encryption | AES-256-GCM |
| User messages (non-E2E) | Plaintext (Phase 1) | Client-side encrypted after future E2EE |

**Reversible Encryption Implementation (AES-256-GCM)**:

```typescript
// server/crypto/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.DATA_ENCRYPTION_KEY!, 'hex'); // 256-bit (64 hex chars)

export function encrypt(plaintext: string): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(12);  // GCM recommends 12-byte IV
  const cipher = createCipheriv(ALGORITHM, KEY, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  return { encrypted, iv: iv.toString('hex'), tag };
}

export function decrypt(data: { encrypted: string; iv: string; tag: string }): string {
  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(data.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));

  let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
```

**Recommendation**: Use one-way functions for passwords and token hashes; use AES-256-GCM reversible encryption for data that needs recovery (like TOTP Secret). Encryption keys injected via environment variables — never hardcoded.

---

#### 1.4.2 Database Connection Encryption (TLS)

**Drizzle + SQLite (local)**: SQLite database files are in the Electron user data directory — no network transport, no TLS needed.

**Drizzle + PostgreSQL (server-side)**: Connection must enable TLS:

```typescript
// server/db/connection.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const client = postgres({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: true,  // Verify certificate in production
  } : false,
  max: 20,  // Connection pool size
});

export const db = drizzle(client);
```

**Recommendation**: Server-side database connections 100% TLS, `rejectUnauthorized: true`.

---

#### 1.4.3 Log Sanitization

```typescript
// server/logging/sanitizer.ts
const SENSITIVE_FIELDS = [
  'password', 'token', 'secret', 'authorization',
  'apiKey', 'api_key', 'accessToken', 'refreshToken',
  'cookie', 'set-cookie',
];

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key'];

export function sanitizeForLogging(obj: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_FIELDS.some(f => lowerKey.includes(f))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLogging(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

// Use pino logger's redact feature
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'password', 'token', 'secret', 'authorization',
      'req.headers.authorization', 'req.headers.cookie',
      'req.body.password', 'req.body.token',
    ],
    censor: '[REDACTED]',
  },
});
```

**Recommendation**: Use `pino@^9.6.0` + `pino-pretty` for structured logging; the redact feature auto-sanitizes. Strictly prohibit logging passwords, tokens, or keys in plaintext.

---

#### 1.4.4 Audit Logs

**Core Principle**: Record "who did what to what resource, when, and with what result".

```sql
-- Audit log table (append-only, no modification, no deletion)
CREATE TABLE audit_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT,                 -- Actor (NULL for system operations)
  action      TEXT NOT NULL,        -- 'user.login', 'user.create', 'message.send', 'channel.create', etc.
  resource_type TEXT NOT NULL,      -- 'user', 'message', 'channel', 'workspace', etc.
  resource_id TEXT,                 -- Affected resource ID
  metadata    TEXT,                 -- JSON-formatted additional info (sanitized)
  ip_address  TEXT,
  user_agent  TEXT,
  result      TEXT NOT NULL CHECK(result IN ('success', 'failure', 'denied')),
  error       TEXT,                 -- Failure reason
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_audit_user ON audit_logs(user_id);
CREATE INDEX idx_audit_action ON audit_logs(action);
CREATE INDEX idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
```

```typescript
// server/audit/logger.ts
import { db } from '../db/connection.js';
import { auditLogs } from '../db/schema.js';

export async function auditLog(params: {
  userId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  result: 'success' | 'failure' | 'denied';
  error?: string;
}) {
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    ...params,
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    createdAt: new Date().toISOString(),
  });
}

// Usage example
await auditLog({
  userId: req.user.id,
  action: 'user.login',
  resourceType: 'user',
  resourceId: req.user.id,
  ipAddress: req.ip,
  userAgent: req.headers['user-agent'],
  result: 'success',
});
```

**Recommendation**: Audit log tables are append-only (INSERT), with no support for UPDATE/DELETE. Recommended retention: 90 days (compliance) + archive to cold storage.

---

### 1.5 Key Management

#### 1.5.1 Environment Variable Management

```bash
# .env.example (committed to Git, no real values)
DATABASE_URL=postgres://user:password@localhost:5432/nexus_chat
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
PASSWORD_PEPPER=somelongrandomhexstring
DATA_ENCRYPTION_KEY=64charhexstring
CSRF_SECRET=32charrandomstring
REDIS_URL=redis://localhost:6379
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

```typescript
// server/config.ts —— centralized validation of all env vars
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  PASSWORD_PEPPER: z.string().length(64),  // or min(32)
  DATA_ENCRYPTION_KEY: z.string().length(64),
  REDIS_URL: z.string().url(),
});

export const config = envSchema.parse(process.env);
// Validate immediately on startup — crash early if config is wrong
```

**Recommendation**: Use `.env` + `dotenv-cli` for loading, Zod for validating all required variables. Add `.env` file to `.gitignore`.

---

#### 1.5.2 Separating Secrets from Code

**Strictly Prohibited**:
- Hardcoding keys, passwords, or tokens in code
- Committing `.env` files to Git
- Including secrets in comments or commit messages

**Recommended Practices**:
- Local development: `.env` file (not committed)
- CI/CD: GitHub Secrets or HashiCorp Vault
- Production: Environment variable injection (Kubernetes Secrets / Docker secrets)
- In emergencies: use `git-secrets` to scan repo history

```bash
# Install git-secrets hook (prevent accidental secret commits)
brew install git-secrets
git secrets --install
git secrets --register-aws

# Add custom rules
git secrets --add 'private_key|private key|-----BEGIN.*KEY-----'
```

**Recommendation**: Code = logic, env vars = configuration, Vault/K8s Secrets = sensitive values. Strictly separate all three.

---

#### 1.5.3 Key Rotation Strategy

| Key Type | Rotation Frequency | Rotation Method | Impact Scope |
|---|---|---|---|
| JWT Signing Key (RS256) | 90 days | Generate new key pair, old public key retained for verification window | All users must re-login |
| Data Encryption Key | 180 days | Maintain old key for decryption, new key for encryption | Encrypted data needs gradual migration |
| Bot Token | On demand (or 90-day mandatory) | Generate new token, old token retains 24h grace period | Single Bot |
| Password Pepper | On demand (infrequent) | All users must reset passwords | All users |
| Session Secret | Rotate with deployment | Retain old key during rolling deployment | Session interruption |

**JWT Signing Key Rotation Flow**:

```
1. Generate new key pair (KID=v2)
2. Newly issued tokens use KID=v2 for signing
3. Verification accepts both KID=v1 and KID=v2 (dual-key window)
4. After 7 days, all KID=v1 tokens have expired
5. Remove KID=v1
```

```typescript
// server/auth/jwt-rotation.ts
const KEYS = new Map<string, { privateKey: KeyLike; publicKey: KeyLike }>();

// Load all active keys on startup
async function loadKeys() {
  // v1: current key
  KEYS.set('v1', {
    privateKey: await jose.importPKCS8(process.env.JWT_PRIVATE_KEY_V1!, 'RS256'),
    publicKey: await jose.importSPKI(process.env.JWT_PUBLIC_KEY_V1!, 'RS256'),
  });
  // v2: new key during rotation (optional, transition period)
  if (process.env.JWT_PRIVATE_KEY_V2) {
    KEYS.set('v2', {
      privateKey: await jose.importPKCS8(process.env.JWT_PRIVATE_KEY_V2!, 'RS256'),
      publicKey: await jose.importSPKI(process.env.JWT_PUBLIC_KEY_V2!, 'RS256'),
    });
  }
}

// Sign: always use the latest key
export async function signToken(payload: object) {
  const [kid, keys] = Array.from(KEYS).pop()!;  // Latest key
  return jose.signJWT(payload, { alg: 'RS256', kid }, keys.privateKey);
}

// Verify: iterate over all active keys
export async function verifyToken(token: string) {
  const { header } = await jose.decodeJwt(token); // Read header without verifying signature
  const keys = KEYS.get(header.kid!);
  if (!keys) throw new Error('Unknown key ID');
  return jose.jwtVerify(token, keys.publicKey);
}
```

**Recommendation**: Use Key ID (KID) mechanism to support multiple coexisting keys. During rotation, retain the old key's verification window (7 days) for seamless transition.

---

## 2. Signal Protocol Integration Deep Dive

### 2.1 Protocol Principles

The Signal Protocol is currently the most widely deployed end-to-end encryption protocol in the industry (Signal, WhatsApp, Facebook Messenger, Google Messages, Skype, etc. have all adopted it). Its core consists of two sub-protocols: X3DH (session initialization) and Double Ratchet (message encryption).

---

#### 2.1.1 X3DH (Extended Triple Diffie-Hellman)

**Purpose**: When two parties communicate for the first time, securely negotiate a shared secret (initialize the session).

**Prerequisite**: Each user uploads a PreKey Bundle to the server when coming online, containing:

```
PreKey Bundle:
  - Identity Public Key (IK)        ← Long-term identity key (permanent, unchanging)
  - Signed PreKey Public Key (SPK)  ← Medium-term key (30-day rotation)
  - Signed PreKey Signature         ← IK's signature over SPK
  - One-Time PreKeys (OPK₁...OPKₙ)  ← One-time keys (single-use, then discarded)
```

**Handshake Flow (Alice → Bob)**:

```
1. Alice fetches Bob's PreKey Bundle from the server
2. Alice generates ephemeral key pair (EK_A)
3. Alice performs 3 (or 4, if OPK available) DH computations:

   DH1 = DH(IK_A, SPK_B)       ← ECDH
   DH2 = DH(EK_A, IK_B)        ← ECDH
   DH3 = DH(EK_A, SPK_B)      ← ECDH
   DH4 = DH(EK_A, OPK_B)      ← ECDH (optional, if OPK available)

4. SK = KDF(DH1 || DH2 || DH3 || DH4)   ← Shared secret
5. Alice deletes EK_A private key (forward secrecy)
6. Alice sends Initial Message to Bob (containing IK_A, EK_A public key, etc.)
7. Bob uses his own private keys + Alice's public keys to compute the same SK
8. Session established → subsequent messages use Double Ratchet
```

**Key Security Property**: As long as the long-term identity key (IK) is not compromised, even if an attacker later obtains either party's device private keys, they cannot decrypt historical messages (forward secrecy).

---

#### 2.1.2 Double Ratchet

**Purpose**: After session establishment, each message is encrypted with a new key, achieving continuous security refresh.

**Core Idea**: Three "ratchet" chains

```
DH Ratchet (outer layer):
  Each received message → updates Root Key with new DH key pair
  Root Key → Chain Key → Message Key
  
Symmetric Ratchet (inner layer):
  Each message → Chain Key steps forward once → derives Message Key
  Message Key is used once and discarded (irreversible)
```

```
                    ┌──────────┐
                    │ Root Key │
                    └────┬─────┘
                         │ KDF(DH_Output, Root_Key)
                         ▼
           ┌────────────────────────┐
           │   Sending Chain Key    │────────┐
           └───────────┬────────────┘        │
                       │ KDF                  │
              ┌────────▼────────┐   ┌────────▼────────┐
              │  Message Key 1  │   │  Message Key 2  │  → encrypt(msg₁), encrypt(msg₂)
              └─────────────────┘   └─────────────────┘
                       (use once, discard)       (use once, discard)
```

**Key Security Properties**:

- **Forward Secrecy**: If the current Message Key is leaked, the attacker **cannot** decrypt historical messages (because Message Key is derived one-way from Chain Key and cannot be reversed)
- **Post-Compromise Security (Self-Healing)**: If the current state is leaked, after the next DH ratchet step, the attacker **cannot** decrypt future messages (because a new DH private key has been introduced)

---

#### 2.1.3 Forward Secrecy and Post-Compromise Security

| Attack Scenario | Impact Scope | Reason |
|---|---|---|
| Attacker obtains Alice's device current Root + Chain Key | **Cannot** decrypt historical messages | Message Key derived one-way, irreversible |
| Attacker obtains Alice's device current Root + Chain Key | **Can** decrypt current messages (but not earlier ones) | Current Chain Key can derive current-round Message Key |
| After compromise, Bob sends a new message triggering DH ratchet | **Cannot** decrypt future new messages | New DH introduces new entropy; attacker lacks new DH private key |

> **Analogy**: Think of a string of beads (messages), and the ratchet as a gear that only rotates in one direction. Each rotation produces a new bead (encryption key); beads already rotated past cannot be rotated back. The DH ratchet is like installing a new gear, while all previous gears are discarded.

---

#### 2.1.4 Group Message Sender Key Distribution vs Pairwise Encryption

There are two mainstream approaches to group E2EE. The Signal Protocol uses the **Sender Key** scheme (also known as the Signal group messaging protocol).

**Option A: Pairwise Encryption**

```
Group: Alice, Bob, Carol, Dave

Alice sends a message → Encrypt with Alice↔Bob Session Key → send individually to Bob
                    → Encrypt with Alice↔Carol Session Key → send individually to Carol
                    → Encrypt with Alice↔Dave Session Key → send individually to Dave

Server: Receives 3 encrypted messages, forwards them individually (or broadcasts; clients decrypt their own)
```

| Pros | Cons |
|---|---|
| Highest security (each path independent) | Message count O(n), unscalable for large groups |
| Member departure doesn't require rotation | N=100 means each message is encrypted 100 times |

**Option B: Sender Key (Signal Group Scheme)**

```
When Alice joins a group:
  1. Generate Sender Key (SK_A)
  2. Encrypt SK_A with Alice↔Bob Session Key → send to Bob
  3. Encrypt SK_A with Alice↔Carol Session Key → send to Carol
  4. Encrypt SK_A with Alice↔Dave Session Key → send to Dave

When Alice sends a message:
  1. Derive Message Key from SK_A's current Chain Key
  2. Encrypt message → send to server → server broadcasts to everyone (only 1 copy)
  3. Bob/Carol/Dave each step their copy of SK_A's Chain Key to decrypt
```

| Pros | Cons |
|---|---|
| Message count O(1), scalable for large groups | Distributing Sender Key requires O(n) encryptions |
| Low client computation | When member leaves, all Sender Keys must be rotated |

**Sender Key Distribution Flow Details**:

```
1. Alice creates group G
2. Alice generates Sender Key pair for herself: (sk_A, pk_A)
3. For each member Mᵢ of the group (including Alice herself):
   Alice encrypts (sk_A, pk_A) using the pairwise Session with Mᵢ and sends it
4. Each member stores it in local Sender Key Store: { sender: Alice, group: G, key: sk_A }
5. Subsequently in group G:
   - Decryption: look up (sender=A, group=G) for sk_A → Chain Key → decrypt
   - Rotation: Alice generates new Sender Key → redistributes
```

**Sender Key Distribution vs Pairwise Encryption Comparison** (applicable to nexus-chat):

| Dimension | Sender Key | Pairwise Encryption |
|---|---|---|
| Suitable group size | 3 ~ 10,000+ | 2 ~ 50 |
| Encryptions per message | 1 time | N-1 times (N = group member count) |
| Rotation after member joins | All members redistribute Sender Keys | Not needed (new member can't decrypt old messages) |
| Rotation after member leaves | All **surviving members** rotate their respective Sender Keys | Not needed (departed member no longer has a pairwise Session) |
| Multi-device complexity | Each device gets an independent Sender Key | Each device gets an independent pairwise Session |
| User experience | Fast (single encryption) | Slow (O(N) encryptions), unusable for large groups |
| nexus-chat recommendation | ✅ Default choice | ❌ Only for 1:1 DMs |

**Recommendation**: Use traditional pairwise Double Ratchet for DMs, Sender Key distribution for groups. Both rely on Signal Protocol's X3DH + Double Ratchet at the lower level.

---

### 2.2 libsignal Library Integration

#### 2.2.1 `@signalapp/libsignal-client` — Official Rust Implementation

**Core Information** (as of June 2026):

| Item | Info |
|---|---|
| Package Name | `@signalapp/libsignal-client` |
| Latest Version | **0.96.2** (released 2026-06-18) |
| License | AGPL-3.0 ⚠️ |
| Implementation Language | Rust (core) + TypeScript (bindings) |
| Precompiled Binaries | Windows (x86_64), macOS (x86_64 + arm64), Linux (x86_64 + arm64) |
| Node.js Support | Includes native Node.js addon (NAPI) |
| TypeScript Types | Built-in `.d.ts` declarations |
| API Stability | Evolves with Signal official client needs; **API may change** |

**⚠️ AGPL-3.0 License Impact Analysis**:

- AGPL-3.0 requirement: If you modify libsignal source code and provide it as a network service, you must open-source your modifications.
- For nexus-chat: If you **directly link** `@signalapp/libsignal-client`, does your application need to be open-sourced? Depends on how you use it:
  - Used as an npm dependency (unmodified source) → generally no need to open-source application code
  - Modified libsignal source → must open-source modifications
  - If nexus-chat is open-source (e.g. MIT), no impact at all
  - If it is a closed-source commercial product, consult legal counsel

**Alternative Options (avoiding AGPL limitations)**:

| Option | License | Maturity |
|---|---|---|
| `2key-ratchet` (TypeScript native implementation) | MIT | Newer, community-maintained |
| Self-implemented X3DH + Double Ratchet (via WebCrypto) | Custom | High effort, not recommended |
| Matrix Olm (libolm) | Apache 2.0 | Mature (used by Element) |
| `libsignal-protocol-javascript` (legacy) | GPL-3.0 | Deprecated, no longer maintained |

**Recommendation**: If nexus-chat is an open-source project (MIT/Apache 2.0), use `@signalapp/libsignal-client@^0.96.2` directly. If closed-source, use a TypeScript native implementation (like `2key-ratchet`) or reference Matrix Olm.

---

#### 2.2.2 Encryption/Decryption in Electron Renderer Process

**Architecture Design**:

```
┌──────────────────────────────────────────────────┐
│  Electron Main Process                            │
│  ┌──────────────────────────────────────────────┐│
│  │  SignalProtocolManager (Node.js addon)       ││
│  │  - Key generation                            ││
│  │  - X3DH handshake                            ││
│  │  - Encrypt/decrypt                           ││
│  │  - Key storage (electron-store + safeStorage)││
│  └──────────────┬───────────────────────────────┘│
│                 │ IPC (contextBridge)              │
│  ┌──────────────▼───────────────────────────────┐│
│  │  Preload Script                               ││
│  │  contextBridge.exposeInMainWorld('signal', {  ││
│  │    encryptMessage, decryptMessage, ...        ││
│  │  })                                           ││
│  └──────────────┬───────────────────────────────┘│
└─────────────────┼────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────┐
│  Renderer Process (React App)                     │
│  window.signal.encryptMessage(text, sessionId)   │
│  window.signal.decryptMessage(ciphertext,         │
│                               senderId)           │
└──────────────────────────────────────────────────┘
```

**Why encrypt in Main Process instead of Renderer Process?**

| Consideration | Main Process | Renderer Process |
|---|---|---|
| libsignal availability | ✅ Native Node.js addon available | ❌ Sandbox mode — Node.js not available |
| Security | ✅ Isolated from UI; XSS can't access encrypt/decrypt | ❌ XSS can access encryption functions |
| Key storage | ✅ Can use OS keychain (safeStorage) | ❌ Can't access native storage |
| Performance | ✅ Doesn't block UI | ❌ Blocks UI (WebWorker also struggles with native addon) |

**Preload Script Example**:

```typescript
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';

// Expose secure encryption API to renderer process
contextBridge.exposeInMainWorld('signalCrypto', {
  // Initiate X3DH handshake (active party)
  initiateSession: (recipientId: string) =>
    ipcRenderer.invoke('signal:initiateSession', recipientId),

  // Process X3DH handshake (passive party)
  processPreKeyBundle: (senderId: string, message: unknown) =>
    ipcRenderer.invoke('signal:processPreKeyBundle', senderId, message),

  // Encrypt message (after session exists)
  encryptMessage: (recipientId: string, plaintext: string) =>
    ipcRenderer.invoke('signal:encrypt', recipientId, plaintext),

  // Decrypt message
  decryptMessage: (senderId: string, ciphertext: unknown) =>
    ipcRenderer.invoke('signal:decrypt', senderId, ciphertext),

  // Get PreKey Bundle (for uploading to server)
  getPreKeyBundle: () =>
    ipcRenderer.invoke('signal:getPreKeyBundle'),

  // Generate Safety Number (verifiable key)
  getSafetyNumber: (userId: string) =>
    ipcRenderer.invoke('signal:getSafetyNumber', userId),
});
```

---

#### 2.2.3 PreKey Bundle Generation, Upload, Fetch, and Recycling

**Complete Lifecycle**:

```typescript
// electron/main/signal-manager.ts
import {
  ProtocolAddress,
  SessionBuilder,
  SessionCipher,
  PreKeyBundle,
  IdentityKeyPair,
  KeyHelper,
} from '@signalapp/libsignal-client';

class SignalProtocolManager {
  private store: SignalStore;          // Local key storage
  private serverApi: SignalServerApi;  // Communication with server

  // 1. Initialize: generate identity key + PreKeys
  async initialize(userId: string) {
    // Generate identity key pair (at account creation, once only)
    const identityKeyPair = IdentityKeyPair.generate();

    // Generate Signed PreKey (30-day validity)
    const signedPreKey = await this.generateSignedPreKey(identityKeyPair);

    // Generate One-Time PreKeys (batch of 100)
    const oneTimePreKeys = await this.generateOneTimePreKeys(100);

    // Save to local secure storage
    await this.store.saveIdentityKey(userId, identityKeyPair);
    await this.store.saveSignedPreKey(signedPreKey);
    await this.store.saveOneTimePreKeys(oneTimePreKeys);

    // Upload public keys to server
    await this.serverApi.uploadPreKeyBundle({
      identityKey: identityKeyPair.publicKey.serialize(),
      signedPreKey: {
        keyId: signedPreKey.id,
        publicKey: signedPreKey.keyPair.publicKey.serialize(),
        signature: signedPreKey.signature,
      },
      oneTimePreKeys: oneTimePreKeys.map(opk => ({
        keyId: opk.id,
        publicKey: opk.keyPair.publicKey.serialize(),
      })),
    });
  }

  // 2. PreKey consumption and replenishment
  async onPreKeyConsumed(keyId: number) {
    // Server notifies that a one-time prekey has been used
    // One-time key: remove from local storage
    await this.store.removeOneTimePreKey(keyId);

    // If remaining < 20, auto-replenish
    const remaining = await this.store.countOneTimePreKeys();
    if (remaining < 20) {
      const newKeys = await this.generateOneTimePreKeys(100 - remaining);
      await this.store.saveOneTimePreKeys(newKeys);
      await this.serverApi.uploadOneTimePreKeys(newKeys);
    }
  }

  // 3. Signed PreKey refresh (every 30 days)
  async rotateSignedPreKey() {
    const identityKeyPair = await this.store.getIdentityKey();
    const newSPK = await this.generateSignedPreKey(identityKeyPair);

    // Old SPK retained for 7 days (allows in-progress handshakes to complete)
    // After 7 days, delete old SPK
    await this.store.saveSignedPreKey(newSPK);
    await this.serverApi.rotateSignedPreKey(newSPK);
  }

  // 4. Fetch counterparty's PreKey Bundle
  async fetchPreKeyBundle(userId: string): Promise<PreKeyBundle> {
    const data = await this.serverApi.getPreKeyBundle(userId);
    // Data contains only public keys, no private keys
    return PreKeyBundle.new(
      data.identityKey,
      data.signedPreKey.keyId,
      data.signedPreKey.publicKey,
      data.signedPreKey.signature,
      data.oneTimePreKeys[0]?.keyId ?? null, // Consume first one-time prekey
      data.oneTimePreKeys[0]?.publicKey ?? null,
    );
  }
}
```

---

#### 2.2.4 Session Management Lifecycle

```typescript
// Session state machine
enum SessionStatus {
  NOT_STARTED,    // Session not established (no key material)
  PENDING,        // Waiting for counterparty's acceptance (InitialMessage sent)
  ACTIVE,         // Session active (can encrypt/decrypt)
  ARCHIVED,       // Session archived (unused for a long time; key material retained)
  TERMINATED,     // Session terminated (key material destroyed)
}

// Session storage (one Session per (userId, deviceId) pair)
interface SessionRecord {
  userId: string;        // Chat counterparty
  deviceId: number;      // Counterparty device ID
  sessionData: Uint8Array; // Serialized SessionRecord
  status: SessionStatus;
  createdAt: Date;
  lastUsedAt: Date;
  isActive: boolean;
}
```

**Session Establishment Flow**:

```
Alice (Initiator)                         Server                           Bob (Receiver)
    │                                        │                                  │
    │  1. Fetch Bob's PreKey Bundle          │                                  │
    │───────────────────────────────────────►│                                  │
    │◄───────────────────────────────────────│                                  │
    │                                        │                                  │
    │  2. Build PreKeySignalMessage          │                                  │
    │     (IK_A + EK_A + encrypted init msg) │                                  │
    │                                        │                                  │
    │  3. Send InitialMessage                │                                  │
    │───────────────────────────────────────►│  4. Forward to Bob               │
    │                                        │─────────────────────────────────►│
    │                                        │                                  │
    │                                        │  5. Bob uses his private keys +  │
    │                                        │     Alice's public keys to build │
    │                                        │     Session                      │
    │                                        │                                  │
    │  6. Session ACTIVE                     │  7. Session ACTIVE               │
    │◄══════════════════════════════════════►│◄════════════════════════════════►│
    │                                        │                                  │
    │  8. Subsequent messages use            │                                  │
    │     SignalMessage (Double Ratchet)     │                                  │
    │───────────────────────────────────────►│─────────────────────────────────►│
```

**Recommendation**: Maintain one Session per (user, device) pair. Session state is persisted to local encrypted storage. Archive (but don't delete) long-unused Sessions — historical messages may still need decryption.

---

### 2.3 Key Server Design

#### 2.3.1 Server Stores Only Public Keys (Zero-Knowledge Principle)

**Core Principle**: The server's design philosophy is "only store public keys, only forward ciphertext". The server does not possess, nor does it need to know, any private keys.

```sql
-- Server-side database table design

-- User Identity Keys (public)
CREATE TABLE identity_keys (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  public_key TEXT NOT NULL,  -- base64-encoded Curve25519 public key
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Signed PreKey (public key + signature)
CREATE TABLE signed_prekeys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT, -- Server-assigned keyId
  user_id    TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,   -- base64-encoded
  signature  TEXT NOT NULL,   -- Identity key's signature over this PreKey (proves ownership)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,   -- 30-day validity
  is_active  BOOLEAN NOT NULL DEFAULT true
);
CREATE INDEX idx_spk_user ON signed_prekeys(user_id);

-- One-Time PreKeys (public key only, server-assigned ID)
CREATE TABLE one_time_prekeys (
  id         TEXT PRIMARY KEY, -- uuid
  user_id    TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,    -- base64-encoded
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_used    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_otpk_user ON one_time_prekeys(user_id, is_used);
```

**Server-Side API**:

```typescript
// server/api/prekeys.ts
// Upload PreKey Bundle
// POST /api/prekeys/bundle
// Body: { identityKey, signedPreKey, oneTimePreKeys }
// Server stores only public keys, never generates any private keys

// Fetch PreKey Bundle
// GET /api/prekeys/:userId
// Returns: { identityKey, signedPreKey, oneTimePreKey }
// Server consumes one one-time prekey (marks is_used = true)
```

---

#### 2.3.2 Ensuring One-Time Use of PreKeys

```typescript
// server/api/prekeys.ts
export async function getPreKeyBundle(userId: string) {
  // Use transaction to guarantee concurrency safety
  return db.transaction(async (tx) => {
    // Get identity key
    const identityKey = await tx
      .select()
      .from(identityKeys)
      .where(eq(identityKeys.userId, userId))
      .limit(1);

    // Get the latest active Signed PreKey
    const signedPreKey = await tx
      .select()
      .from(signedPrekeys)
      .where(
        and(
          eq(signedPrekeys.userId, userId),
          eq(signedPrekeys.isActive, true),
          gt(sql`expires_at`, new Date().toISOString())
        )
      )
      .orderBy(desc(signedPrekeys.createdAt))
      .limit(1);

    // Get one unused One-Time PreKey (and immediately mark as used)
    // Atomic SELECT ... LIMIT 1 + UPDATE
    const oneTimePreKey = await tx
      .select()
      .from(oneTimePrekeys)
      .where(
        and(
          eq(oneTimePrekeys.userId, userId),
          eq(oneTimePrekeys.isUsed, false)
        )
      )
      .limit(1);

    if (oneTimePreKey.length > 0) {
      await tx
        .update(oneTimePrekeys)
        .set({ isUsed: true })
        .where(eq(oneTimePrekeys.id, oneTimePreKey[0].id));
    }

    return {
      identityKey: identityKey[0]?.publicKey,
      signedPreKey: signedPreKey[0],
      oneTimePreKey: oneTimePreKey[0] ?? null,
    };
  });
}
```

**Important Notes**:

- **Must use transactions** to ensure "read PreKey + mark used" is atomic, preventing two Alice's from simultaneously fetching and using the same PreKey
- If OPKs are exhausted, null can still be returned (X3DH without OPK performs 3 DH computations instead of 4 — a slight security downgrade)
- Client should proactively replenish when OPKs are running low

---

#### 2.3.3 Key Expiration and Refresh Policy

| Key Type | Validity | Refresh Strategy | Server Handling |
|---|---|---|---|
| Identity Key | Permanent | Never refreshed (if leaked, re-registration required) | Overwriting not allowed |
| Signed PreKey | 30 days | Auto-refresh 7 days before expiry | Old SPK retained 7 days then discarded |
| One-Time PreKey | Single use | Replenish to 100 when remaining < 20 | Mark `is_used = true` after use |

**Scheduled Task**:

```typescript
// server/jobs/key-rotation.ts
import { cron } from 'node-cron';

// Run daily: clean up expired Signed PreKeys and One-Time PreKeys used more than 7 days ago
cron.schedule('0 3 * * *', async () => {
  // Deactivate Signed PreKeys expired 7+ days ago
  await db
    .update(signedPrekeys)
    .set({ isActive: false })
    .where(lt(sql`expires_at`, new Date(Date.now() - 7 * 86400 * 1000).toISOString()));

  // Delete One-Time PreKeys used more than 7 days ago
  await db
    .delete(oneTimePrekeys)
    .where(
      and(
        eq(oneTimePrekeys.isUsed, true),
        lt(sql`created_at`, new Date(Date.now() - 7 * 86400 * 1000).toISOString())
      )
    );
});
```

---

#### 2.3.4 Multi-Device Synchronization Challenges

**Signal's Approach** (nexus-chat reference):

Each device is an independent "endpoint" with its own:
- Independent Identity Key Pair
- Independent Signed PreKey
- Independent One-Time PreKeys
- Independent Session (one Session for each other user's device)

```
Bob has 3 devices: Phone (B1), Desktop (B2), Tablet (B3)

Alice (A1) → Bob (B1, B2, B3):
  - A1 ↔ B1: Session 1
  - A1 ↔ B2: Session 2
  - A1 ↔ B3: Session 3

When Alice sends a DM to Bob:
  Client encrypts 3 times → sends 3 ciphertexts → server forwards to B1, B2, B3 separately
```

**nexus-chat Simplified Strategy (Phase 1-2)**:

| Phase | Strategy | Rationale |
|---|---|---|
| Phase 1 (MVP) | Single device | Reduce complexity |
| Phase 2 | Same as above; N devices = N encryptions | Proven working approach |
| Phase 3 | Optional inter-device key migration (Signal's device transfer) | QR-code-based key material transfer |

**Group Multi-Device**:

```
Alice (A1, A2) in group G:
  A1's Sender Key: SK_A1 → distributed to all members' all devices
  A2's Sender Key: SK_A2 → distributed to all members' all devices

If group has 10 members, each with 2 devices:
  Total of 20 Sender Keys active in the group
  Per message: 1 encryption + N devices = 10 ciphertexts
```

**Multi-Device Synchronization Technical Difficulty Summary**:

| Difficulty | Solution |
|---|---|
| Key synchronization | Each device holds keys independently; no cross-device sync of private keys |
| Message history | Phase 3 can use Signal's device transfer feature for migration |
| Device discovery | Server maintains device list; client selects encryption targets |
| Offline devices | Messages temporarily stored on server (ciphertext) and delivered on reconnection |

**Recommendation**: Phase 1-2 use the "device-independent encryption" approach (same as Signal). Phase 3 explores inter-device key migration.

---

### 2.4 Group E2E Encryption

#### 2.4.1 Sender Key Distribution (Suitable for Large Groups)

Detailed flow (already described in 2.1.4); here we supplement implementation details:

**Server-Side Group Tables (E2EE Extension)**:

```sql
-- Group Sender Key Distribution Records
CREATE TABLE group_sender_keys (
  group_id    TEXT NOT NULL,
  sender_id   TEXT NOT NULL,     -- Sender (person holding the private key)
  device_id   INTEGER NOT NULL,  -- Sender's specific device
  recipient_id TEXT NOT NULL,    -- Recipient
  encrypted_key TEXT NOT NULL,   -- Sender Key encrypted with pairwise Session
  distribution_id TEXT NOT NULL, -- Distribution batch ID (for rotation tracking)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, sender_id, device_id, recipient_id, distribution_id)
);

-- Group Key Distribution Batches (for rotation tracking)
CREATE TABLE group_key_distributions (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,  -- Incrementing version number
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  is_active   BOOLEAN NOT NULL DEFAULT true
);
```

---

#### 2.4.2 Key Rotation on Member Changes

**Scenario 1: Member Joins**

```
When Dave joins group G:
  1. All existing members (Alice, Bob, Carol) rotate their own Sender Keys
     → New Sender Keys encrypted and sent to all members (including Dave)
  2. Dave's Sender Key is sent by Dave using a pairwise session with some member
     → Automatically distributed to all existing members
  3. Dave cannot decrypt messages before joining (old Sender Keys not sent to him)
     → This is called "Pending Join" mode
```

**Scenario 2: Member Leaves / Is Removed**

```
When Carol leaves group G:
  1. All surviving members (Alice, Bob, Dave) immediately rotate their respective Sender Keys
  2. New Sender Keys distributed to surviving members (excluding Carol)
  3. Carol's old Sender Key removed from all members' local storage
  4. Subsequent messages encrypted with new Sender Keys → Carol cannot decrypt
  5. Historical messages unaffected (Carol can still decrypt messages from before she left)
```

**Client-Side Implementation of Key Rotation on Member Changes**:

```typescript
// electron/main/signal-group.ts
class GroupEncryptionManager {
  // Member added event handler
  async onMemberAdded(groupId: string, newMemberId: string) {
    // 1. Get all current members of the group
    const members = await this.getGroupMembers(groupId);

    // 2. Rotate own Sender Key
    const newSenderKey = await this.generateSenderKey(groupId);

    // 3. Encrypt Sender Key and send to all members (including new member)
    // For new member: must encrypt via pairwise Session (no shared Sender Key yet)
    for (const memberId of members) {
      const encryptedKey = await this.encryptSenderKey(memberId, newSenderKey);
      await this.serverApi.sendSenderKeyDistribution(
        groupId, memberId, encryptedKey
      );
    }

    // 4. Wait for new member to also rotate their Sender Key (or auto-distribute on first send)
  }

  // Member removed event handler
  async onMemberRemoved(groupId: string, removedMemberId: string) {
    // 1. Get list of surviving members (exclude removed member)
    const remainingMembers = (await this.getGroupMembers(groupId))
      .filter(m => m.id !== removedMemberId);

    // 2. Rotate own Sender Key
    const newSenderKey = await this.generateSenderKey(groupId);

    // 3. Encrypt Sender Key and send to surviving members (not to removed member)
    for (const memberId of remainingMembers.map(m => m.id)) {
      const encryptedKey = await this.encryptSenderKey(memberId, newSenderKey);
      await this.serverApi.sendSenderKeyDistribution(
        groupId, memberId, encryptedKey
      );
    }

    // 4. Clear the removed member's Sender Key (no longer decrypt their messages)
    await this.store.removeSenderKey(groupId, removedMemberId);
  }
}
```

---

#### 2.4.3 Pending Join Mode

**Definition**: After a new member joins a group, they can only see messages **after** joining — they cannot decrypt historical messages from before joining.

**Implementation**:

```
Sender Key chain at group creation:
  SK_v1 → Message 1, Message 2, Message 3  ← Messages before Dave joined
  SK_v2 → Message 4, Message 5, Message 6  ← All members rotated Sender Keys after Dave joined

Dave's held Sender Keys:
  SK_v2 (Alice), SK_v2 (Bob), SK_v2 (Carol)  ← Can decrypt Messages 4, 5, 6
  ❌ SK_v1 → Cannot decrypt Messages 1, 2, 3
```

**UI Indicator**:

```
--- Dave joined the channel ---  ← This message sent by server (plaintext/system message)
    [Previous messages not visible]
Message 4: Hello Dave!            ← Dave can decrypt
Message 5: Welcome aboard!
```

**Recommendation**: Phase 2 implements Pending Join — when a new member joins, all existing members rotate Sender Keys, creating a natural message visibility boundary.

---

#### 2.4.4 Behavioral Differences vs Normal Channels Comparison Table

| Feature | Normal Channel (Phase 0-1) | E2EE Channel (Phase 2+) |
|---|---|---|
| Message encryption | Transport-layer encryption (TLS) | End-to-end encryption (Signal Protocol) |
| Server can read messages | ✅ Plaintext visible | ❌ Ciphertext only |
| Message search | ✅ Server-side full-text search | ❌ Client-side local search |
| New member sees history | ✅ All visible | ❌ Only after Pending Join (Phase 2) |
| Security after member leaves | ✅ Can still view history | ❌ Cannot decrypt new messages after removal |
| Message editing | ✅ Direct modification | ❌ Must re-encrypt (or not supported) |
| File previews/thumbnails | ✅ Server-generated | ❌ Client decrypts then generates |
| Admin message auditing | ✅ Server-readable | ❌ Not auditable (feature, not bug) |
| Network latency | Low | Slightly higher (encryption/decryption + key distribution) |
| Multi-device | Naturally supported | Per-device independent keys (Phase 2) |

**Recommendation**: Normal and E2EE channels should be as consistent as possible in UX, but users must clearly be aware of the current channel's encryption state (via UI lock icon + channel settings).

---

## 3. E2EE Future Roadmap

### 3.1 Phase 1 (MVP): DM E2E

**Estimated Time**: 1.5 ~ 2 months

#### Feature Scope

- [x] 1:1 DM end-to-end encryption
- [x] Identity key generation and management
- [x] PreKey Bundle upload/download
- [x] X3DH session initialization
- [x] Double Ratchet message encryption/decryption
- [x] Key material local encrypted storage
- [x] Session state management
- [x] Server stores only public keys + ciphertext
- [x] Fallback mechanism (auto-degrade to normal when counterparty doesn't support E2E)
- [x] UI key exchange status indicator

#### User Interaction Flow

```
Normal DM scenario (both parties support E2E):

  User A                           User B
  ──────                           ──────
  Opens DM window
    │
    ├─ Fetches B's PreKey Bundle
    │  (server query)
    │
    ├─ Executes X3DH handshake
    │  (client-side local computation)
    │
    ├─ Sends InitialMessage (incl. IK_A, EK_A, ciphertext)
    │──────────────────────────────►│
    │                               ├─ Receives InitialMessage
    │                               ├─ Completes X3DH with own private keys
    │                               ├─ Decrypts first message
    │                               │
    │◄──────────────────────────────│
    │                               │
    ├─ Session ACTIVE              ├─ Session ACTIVE
    │                               │
    │  "🔒 Message is E2E encrypted" │  "🔒 Message is E2E encrypted"
    │                               │
```

**UI Component (React)**:

```tsx
// components/chat/EncryptionIndicator.tsx
function EncryptionIndicator({ sessionStatus, onVerify }: {
  sessionStatus: 'pending' | 'active' | 'inactive' | 'none';
  onVerify: () => void;
}) {
  return (
    <div className="encryption-indicator">
      {sessionStatus === 'none' && (
        <span className="text-gray-400">🔓 Not Encrypted</span>
      )}
      {sessionStatus === 'pending' && (
        <span className="text-yellow-400">
          <Spinner /> Establishing secure connection...
        </span>
      )}
      {sessionStatus === 'active' && (
        <span className="text-green-400">
          🔒 End-to-End Encrypted
          <button onClick={onVerify}>Verify Key</button>
        </span>
      )}
      {sessionStatus === 'inactive' && (
        <span className="text-red-400">⚠️ Encryption Session Expired</span>
      )}
    </div>
  );
}
```

#### Fallback Mechanism

```typescript
// electron/main/message-router.ts
async function sendMessage(recipientId: string, plaintext: string) {
  const e2eeCapable = await checkE2EECapability(recipientId);

  if (e2eeCapable) {
    // E2E path
    const session = await signalManager.getOrCreateSession(recipientId);
    if (!session) {
      // Need to establish session first (send X3DH InitialMessage)
      const preKeyBundle = await serverApi.getPreKeyBundle(recipientId);
      const initialMessage = await signalManager.processPreKeyBundle(
        recipientId,
        plaintext,
        preKeyBundle
      );
      return serverApi.sendInitialMessage(recipientId, initialMessage);
    }
    const ciphertext = await signalManager.encrypt(recipientId, plaintext);
    return serverApi.sendEncryptedMessage(recipientId, ciphertext);
  } else {
    // Downgrade path
    return serverApi.sendPlainMessage(recipientId, plaintext);
  }
}
```

#### Data Model Changes (Phase 1)

```sql
-- DM messages table (reuse existing message table, add columns)
ALTER TABLE messages ADD COLUMN encryption_type TEXT CHECK(
  encryption_type IN ('none', 'e2ee_signal')
) DEFAULT 'none';

ALTER TABLE messages ADD COLUMN ciphertext TEXT;    -- Encrypted message
ALTER TABLE messages ADD COLUMN sender_device_id INTEGER;  -- Sending device

-- Add E2EE flag to conversations table
ALTER TABLE conversations ADD COLUMN is_e2ee BOOLEAN DEFAULT false;

-- User E2EE capability flag
ALTER TABLE users ADD COLUMN e2ee_capable BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN e2ee_version TEXT;
```

**Recommendation**: Phase 1 focuses on 1:1 DM E2EE, with a fallback mechanism ensuring backward compatibility. UI explicitly indicates encryption status to build user trust.

---

### 3.2 Phase 2: Group E2E

**Estimated Time**: 2 ~ 3 months

#### Feature Scope

- [x] E2E support for private channels
- [x] Sender Key distribution mechanism
- [x] Key rotation on member join (Pending Join)
- [x] Key rotation on member leave/removal
- [x] Basic multi-device support (per-device independent Sessions)
- [x] Server-side group key storage (only ciphertext of Sender Keys)
- [x] Group E2EE status indicator

#### Architecture Change Comparison

```
Phase 1 (DM only):                     Phase 2 (DM + Group):

  A ───(Session)─── B                  Group G:
  (1-to-1 relationship)                   A ───(SK_A)───► All Members
                                          B ───(SK_B)───► All Members
                                          C ───(SK_C)───► All Members
                                       (One Sender Key per member)
```

**Recommendation**: Phase 2 builds group E2EE on top of Phase 1. The core complexity lies in key rotation logic on member changes. Multi-device support is an optional sub-feature (Phase 2.5).

---

### 3.3 Phase 3: Advanced Features

**Estimated Time**: 3 ~ 6 months

#### 3.3.1 Verifiable Keys (Safety Numbers / QR Code)

**Purpose**: Allow users to verify the identity of their chat partner, preventing man-in-the-middle attacks.

**Implementation**:

```typescript
// Safety Number = Hash of first 30 bits (numeric representation) of SHA-256
// Equivalent to 60 decimal digits (Signal's actual approach uses iterative hashing of identity key)

export function computeSafetyNumber(
  localIdentityKey: Uint8Array,
  remoteIdentityKey: Uint8Array
): string {
  // Use hash of identity public key bytes as safety number
  const combined = new Uint8Array([...localIdentityKey, ...remoteIdentityKey]);
  const hash = createHash('sha512').update(combined).digest();
  // Take first 30 bytes, represent each byte as a digit (60 digits total)
  return Array.from(hash.slice(0, 30))
    .map(b => (b % 10).toString())
    .join('')
    .replace(/(\d{5})/g, '$1 ')
    .trim();
}
```

**User Interaction**:

```tsx
///components/chat/SafetyNumberVerification.tsx
function SafetyNumberVerification({
  localNumber, remoteNumber, onVerified
}: {
  localNumber: string;
  remoteNumber: string;
  onVerified: () => void;
}) {
  return (
    <div className="safety-number-dialog">
      <p>Verify {otherUserName}'s safety number to confirm identity:</p>
      <div className="safety-number-display">
        <code>{remoteNumber}</code>
      </div>
      <p>The other party's number should display as:</p>
      <div className="safety-number-display">
        <code>{localNumber}</code>
      </div>
      <div className="verification-actions">
        <button onClick={onVerified}>
          ✅ Numbers Match — Mark as Verified
        </button>
      </div>
      {/* QR Code scan verification (Phase 3+) */}
      <QRCodeVerification />
    </div>
  );
}
```

---

#### 3.3.2 Disappearing Messages

**Design Principle**: Timed message deletion is a **client-enforced** agreement — the server should not be relied upon.

```typescript
// Message structure (client-side)
interface DisappearingMessage {
  plaintext: string;
  expirationTimer: number;        // Seconds (e.g. 300 = 5 minutes)
  envelopeTimestamp: number;      // Send time
}

// Encryption flow
async function sendDisappearingMessage(
  plaintext: string,
  timerSeconds: number,
  session: SessionCipher
) {
  const message = {
    type: 'disappearing',
    plaintext,
    expirationTimer: timerSeconds,
    envelopeTimestamp: Date.now(),
  };

  const ciphertext = await session.encrypt(JSON.stringify(message));

  // After sending, start local timer
  setTimeout(() => {
    // Delete message from local storage
    messageStore.deleteMessage(messageId);
  }, timerSeconds * 1000);

  return ciphertext;
}
```

**UI Indicator**:

```
Message 1: "See you at 3pm"            [⏱️ 5min]
Message 2: "Ok got it"                 [⏱️ 5min]
Message 3: "This message will self-destruct" [5min ── disappearing...]
```

---

#### 3.3.3 Sealed Sender

**Purpose**: Hide the identity of the message sender (the server only sees ciphertext and recipient, not the sender).

**Signal's Implementation**: Wraps the entire message (including sender info) in an encrypted envelope that only the recipient can decrypt.

```typescript
// Simplified Sealed Sender implementation idea
async function sendSealedMessage(recipientId: string, plaintext: string) {
  const session = await getOrCreateSession(recipientId);

  // 1. Encrypt message body (normal flow)
  const messageCiphertext = await session.encrypt(plaintext);

  // 2. Build Sealed Sender envelope
  //    Encrypt sender identity + message with recipient's identity public key
  //    So only the recipient can decrypt who sent the message
  const senderIdentity = await store.getIdentityKey();
  const recipientIdentity = await serverApi.getIdentityKey(recipientId);

  const sealedEnvelope = await sealSenderEnvelope(
    senderIdentity.publicKey,   // Sender identity
    messageCiphertext,          // Encrypted message
    recipientIdentity           // Recipient identity public key
  );

  // 3. Server cannot see sender ID
  //    Server can only route based on recipient in sealedEnvelope
  return serverApi.sendSealedMessage(recipientId, sealedEnvelope);
}
```

**Security Trade-offs**:

| Advantages | Disadvantages |
|---|---|
| Prevents server-side social graph analysis | Message routing depends on recipient public key (can't use arbitrary shared inboxes) |
| Sender identity hidden from server | Requires additional envelope encryption step |
| Even if server is compromised, communication records can't be linked | Increases message size (about 300 bytes) |

---

#### 3.3.4 External Audit (Verifiable Encryption Transparency Log)

**Goal**: Allow third-party security researchers to independently audit whether "the server secretly stores plaintext or can decrypt messages".

**Implementation Approach (Key Transparency / CONIKS-style)**:

```
1. Server maintains a Merkle Tree, leaf nodes are user identity public keys
2. Tree root hash periodically published to blockchain or public log
3. Users can see their own public key's position in the tree
4. If server tampers with public keys (for MITM attacks), monitoring services can detect it

Simplified version (Phase 3 optional):
  - Server periodically publishes "key directory hash" (e.g. hourly)
  - Client verifies whether their own public key is in the directory
  - Auto-alert on mismatch
```

**Recommendation**: Phase 3 advanced features prioritized as: Safety Numbers > Disappearing Messages > Sealed Sender > Transparency Log. The first two provide the largest boost to user trust and experience.

---

## 4. Threat Model

### 4.1 Server Compromise

**Assumption**: Attacker gains full access to the server-side database (including all tables, logs, backups).

#### 4.1.1 Normal Channel (Unencrypted)

| Attacker Can Obtain | Attacker Cannot Obtain |
|---|---|
| ✅ All message plaintext | ❌ Client-side keys (keys are client-side) |
| ✅ User list and metadata | ❌ Already-deleted client local data |
| ✅ Channel member relationships | — |
| ✅ Message timestamps | — |
| ✅ Uploaded files | — |
| ✅ Audit logs | — |
| ❌ User passwords (Argon2id hashed, irreversible) | — |
| ❌ Bot Token / API Key (SHA-256 hashed) | — |

**Impact Level**: 🔴 Critical — All plaintext messages and files exposed.

#### 4.1.2 E2EE Channel (Phase 1+)

| Attacker Can Obtain | Attacker Cannot Obtain |
|---|---|
| ✅ Encrypted message ciphertext (cannot decrypt) | ✅ Message plaintext |
| ✅ Identity public keys (cannot derive private keys) | ✅ Any private keys |
| ✅ Sender Key ciphertext (encrypted with Session Key) | ✅ Session Key |
| ✅ Metadata (who sent to whom at what time [ciphertext]) | ✅ Message content |
| ✅ Group member relationships | ✅ File contents (client-encrypted) |
| ❌ Chat contents | ✅ Voice/video call contents |

**Impact of Metadata Exposure**:

Even if message content is unreadable, metadata remains sensitive:
- Who communicated with whom and when
- Communication frequency and patterns
- Group membership relationship network

**Sealed Sender Mitigation** (Phase 3): Hides sender identity; server only knows "someone sent a message to Bob", not who sent it.

**Impact Level**: 🟡 Medium — Message content is secure, but metadata is exposed. Sealed Sender needed for further protection.

---

### 4.2 Man-in-the-Middle (MITM)

**Attack Scenario**: Attacker controls the network path (e.g. malicious Wi-Fi, ISP hijacking, DNS poisoning).

#### 4.2.1 TLS Layer

| Defense Mechanism | Effectiveness |
|---|---|
| HSTS (HTTP Strict Transport Security) | Prevents downgrade to HTTP |
| Certificate Transparency | Detects malicious certificates |
| HPKP (deprecated) | — |

**nexus-chat Protection**: Enforce HTTPS + HSTS preload (Helmet already configured). TLS 1.2+ minimum required; disable weak cipher suites like RC4.

#### 4.2.2 Signal Protocol Layer

**MITM Attacker Attempts to Replace Identity Public Keys (Server Compromised + MITM)**:

```
If attacker controls the server:
  1. Replace Bob's PreKey Bundle with attacker-generated keys
  2. Alice fetches Bob's "PreKey Bundle" → actually attacker's public keys
  3. Alice establishes E2EE Session with the attacker
  4. Alice sends message → attacker decrypts → attacker re-encrypts with real Bob key → forwards

Defense: Safety Number comparison (Phase 3)
  - Alice and Bob compare Safety Numbers via secure channel (e.g. in-person QR scan)
  - If Safety Numbers don't match → PreKey Bundle was tampered with
  - Client displays "Key Changed" warning
```

**MITM Feasibility Analysis Without Safety Number Verification**:

| Attack Requirement | Difficulty |
|---|---|
| Hijack PreKey Bundle during first communication | Requires simultaneous MITM + server-side key replacement |
| Hijack after Session established | Nearly impossible (Double Ratchet's forward secrecy) |
| Server holds root CA private key | Can decrypt TLS, but cannot decrypt Signal Protocol |

**Recommendation**: MITM is infeasible under normal operations (TLS + Signal Protocol dual protection). The largest risk is server compromise + key replacement during first communication. Phase 3 Safety Number verification can completely eliminate this risk.

---

### 4.3 Client Compromise

**Assumption**: Attacker gains physical access to the user's device or remote code execution capability.

| Attacker Can Obtain | Attacker Cannot Obtain |
|---|---|
| ✅ All locally stored key material | ❌ Deleted messages (if persistent encryption) |
| ✅ Current and historical Session records | ❌ Server-stored ciphertext (needs keys to decrypt) |
| ✅ All messages the user can decrypt | ❌ Content readable without decryption (it's plaintext anyway) |
| ✅ Send new messages (impersonate user) | — |

**Impact Scope After Client Compromise**:

```
Scenario: Alice's device is compromised
  Affects what Alice's held keys can decrypt:
    ✅ All historical DMs between Alice and Bob (Alice's Session can decrypt)
    ✅ All historical messages in E2EE groups Alice belongs to (Alice's Sender Keys can decrypt)
    ✅ Future messages (attacker continues using Alice's Sessions)
    ❌ DMs between Bob and Carol (Alice doesn't have their Session Keys)
    ❌ Group messages from before Alice joined (Pending Join mode)
```

**Endpoint Security Mitigation**:

1. **Electron Security Configuration**: `contextIsolation: true, sandbox: true, nodeIntegration: false`
2. **Encrypted Key Storage**: Use OS keychain (macOS Keychain / Windows DPAPI) to encrypt local key files
3. **Auto-Lock**: Lock the app after going to background or 5 minutes of idle (requires re-entering master password or biometric auth)
4. **Session Management**: Server supports remote device logout (invalidate stolen device's tokens)
5. **Device Registration Limits**: Allow users to view registered devices and remotely revoke them

**Recommendation**: Client compromise cannot be fully defended against (endpoint security is an OS-level concern), but blast radius can be limited and remote revocation capabilities can reduce damage.

---

### 4.4 Basic DDoS Defense Strategies

| Layer | Strategy | Implementation |
|---|---|---|
| Network | CDN (Cloudflare / Fastly) | Deploy CDN in front of application to absorb high-traffic attacks |
| Transport | SYN flood protection | CDN built-in / OS tuning |
| Application | Rate limiting (already implemented) | express-rate-limit + Redis |
| Application | Request size limits | 1MB body limit |
| WebSocket | Connection count limit | Max 5 WebSocket connections per IP |
| WebSocket | Heartbeat timeout | Disconnect after 30s of no heartbeat |
| Infrastructure | Auto-scaling | Kubernetes HPA or cloud Load Balancer |

**WebSocket Connection Limits**:

```typescript
// server/websocket/connection-manager.ts
const wsConnectionCount = new Map<string, number>(); // IP → count
const MAX_CONNECTIONS_PER_IP = 5;

wsServer.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress || 'unknown';
  const current = wsConnectionCount.get(ip) || 0;

  if (current >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, 'Too many connections');
    return;
  }

  wsConnectionCount.set(ip, current + 1);

  // Heartbeat detection
  let heartbeatTimeout: NodeJS.Timeout;
  const resetHeartbeat = () => {
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(() => {
      ws.close(1001, 'Heartbeat timeout');
    }, 30_000);
  };

  ws.on('message', (msg) => {
    if (msg.toString() === 'ping') {
      ws.send('pong');
      resetHeartbeat();
    }
  });

  ws.on('close', () => {
    clearTimeout(heartbeatTimeout);
    wsConnectionCount.set(ip, Math.max(0, current - 1));
  });

  resetHeartbeat();
});
```

**Recommendation**: Basic DDoS protection is achieved through CDN + rate limiting + connection limits, sufficient for the MVP phase. WebSocket adds heartbeat and connection count limits.

---

## 5. Compliance & Privacy

### 5.1 Data Collection Privacy Statement

#### Metadata Visible to the Server in E2EE Mode

| Metadata Item | Normal Mode | E2EE Mode | E2EE + Sealed Sender |
|---|---|---|---|
| Sender ID | ✅ Visible | ✅ Visible | ❌ Not visible |
| Recipient ID | ✅ Visible | ✅ Visible | ✅ Visible (routing required) |
| Message timestamp | ✅ Visible | ✅ Visible | ✅ Visible |
| Message size (bytes) | ✅ Visible | ✅ Visible | ✅ Visible |
| Message content | ✅ Readable | ❌ Ciphertext | ❌ Ciphertext |
| File content | ✅ Readable | ❌ Ciphertext | ❌ Ciphertext |
| Message edit history | ✅ Readable | ❌ Ciphertext | ❌ Ciphertext |
| User IP address | ✅ Visible | ✅ Visible | ✅ Can be hidden with Tor/Proxy |
| User agent string | ✅ Visible | ✅ Visible | ✅ Visible |
| Connection duration | ✅ Visible | ✅ Visible | ✅ Visible |

#### What the Privacy Statement Should Clearly Inform Users

```
nexus-chat Privacy Summary (user-visible version):

1. Data We Store (Server-Side)
   - Account information: username, email (hashed), registration time
   - Communication metadata: send/receive time, message size, participant IDs
   - End-to-end encrypted channels: ciphertext only; cannot decrypt message content
   - Normal channels: plaintext messages stored (to enable search and other features)

2. Data We Do NOT Store
   - Plaintext content of end-to-end encrypted messages
   - Message search indexes for E2EE channels (done client-side locally)
   - User's encryption private keys (stored only client-side locally)

3. Third-Party Sharing
   - No user data shared with any third party
   - When using third-party infrastructure (e.g. AWS), data is encrypted in transit and at rest

4. Data Retention
   - Messages: user-configurable retention policy (default: permanent; optional: auto-delete after 30/90/365 days)
   - After account deletion: all associated data permanently deleted within 30 days
```

**Recommendation**: Privacy statement should be written in plain language, presented in layers (summary + details), and embedded into the in-app privacy settings page.

---

### 5.2 GDPR Compliance Checklist

| Requirement | Implementation | Status |
|---|---|---|
| **Legal Basis** | Explicit consent at registration + withdrawable at any time | Needs implementation |
| **Data Minimization** | Only collect necessary data (username, email, optional avatar) | ✅ By design |
| **Right of Access** | `GET /api/user/data` exports all personal data (JSON) | Needs implementation |
| **Right to Rectification** | `PUT /api/user/profile` modify personal info | Needs implementation |
| **Right to Erasure (Right to be Forgotten)** | `DELETE /api/user/account` soft delete → permanent deletion after 30 days | Needs implementation |
| **Data Portability** | Structured export (JSON), supports standard formats | Needs implementation |
| **Right to Restrict Processing** | Suspend account (retain data but stop processing) | Needs implementation |
| **Right to Object** | Users can object to certain data processing (e.g. analytics) | Needs implementation |
| **Automated Decision-Making** | No automated decision-making or profiling used | ✅ By design |
| **Data Protection Officer (DPO)** | If applicable, appoint a DPO | Needs assessment |
| **Data Breach Notification** | Notify regulator + users within 72 hours | Needs process implementation |
| **Records of Processing Activities** | Maintain Records of Processing Activities (ROPA) | Needs implementation |
| **Cross-Border Data Transfers** | If servers outside EU, need SCC or equivalent mechanism | Needs assessment |
| **Children's Data Protection** | Age verification + parental consent required (if applicable) | Needs assessment |
| **Cookie Consent** | Typically no cookies used in Electron apps (JWT Header auth); if used, consent banner needed | ✅ Cookie-free by default |

**Recommendation**: Implement a "Privacy Center" page in user settings to centrally manage all GDPR rights requests. Data export and account deletion features should be implemented in Phase 1 (soft deletion supported at architecture design level).

---

### 5.3 Data Export & Deletion (Right to be Forgotten)

```typescript
// server/api/user/data-export.ts
// GET /api/user/data/export
export async function exportUserData(userId: string): Promise<UserDataExport> {
  return {
    // User metadata
    profile: await getUserProfile(userId),
    preferences: await getUserPreferences(userId),

    // User-generated data (plaintext messages from normal channels)
    // E2EE messages: can only export ciphertext (server cannot decrypt)
    messages: await getMessagesByUser(userId),

    // Files uploaded by user
    fileUrls: await getUserFiles(userId),

    // Audit log entries related to this user
    auditLogs: await getAuditLogsByUser(userId),

    // Export timestamp
    exportedAt: new Date().toISOString(),
  };
}

// DELETE /api/user/account
// Soft delete flow (30-day cooldown period)
export async function deleteUserAccount(userId: string) {
  // 1. Mark account as PENDING_DELETION
  await db
    .update(users)
    .set({ deletionStatus: 'PENDING', deletionScheduledAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString() })
    .where(eq(users.id, userId));

  // 2. Send confirmation and cancellation link to user email
  await sendDeletionConfirmation(userId);

  // 3. Immediately invalidate all sessions
  await invalidateAllSessions(userId);

  // 4. After 30 days, cron job executes hard deletion
  //    DELETE FROM messages WHERE user_id = :userId
  //    DELETE FROM ... (all associated data)
  //    Retain sanitized audit log entries (e.g. "User account #uuid deleted on 2026-07-24")
}
```

**Recommendation**: Data export returns machine-readable JSON. Account deletion uses a 30-day soft delete + cancellation mechanism, balancing user protection with security recovery.

---

### 5.4 Legal Implications of End-to-End Encryption

#### Key Legal Principles

1. **Keys Never Leave the Client**: The server never holds nor requests the user's private keys. This means the server is **technically incapable** of decrypting E2EE messages.

2. **Unfulfillable Government Requests**: If law enforcement requests plaintext of E2EE messages, the server is legally **incapable** of providing it (not unwilling, but unable).

3. **Not a "Refusal to Cooperate"**: Technical incapability is a defense (akin to physical impossibility), fundamentally different from refusal to provide.

4. **Metadata Remains Obtainable**: Even with E2EE, who communicated with whom and when (metadata) is still visible and may be required to be disclosed.

#### E2EE in Different Global Legal Environments

| Region | Regulatory Stance | Impact |
|---|---|---|
| EU (GDPR) | Positive (E2EE seen as data protection tool) | Supports E2EE as privacy protection best practice |
| USA | Complex (law enforcement calls to weaken E2EE) | Proposals like EARN IT Act may impact E2EE |
| UK (OSB) | Challenging (Online Safety Bill threatens E2EE) | Ofcom may require message scanning (technically conflicting) |
| China | Commercial E2EE prohibited (encryption products require approval) | E2EE may not be possible for operations in China |
| India | Middle ground (traceability requirements) | Requires messages traceable to original sender |

#### Suggested Responses for nexus-chat

1. **Provide region-specific compliance versions**: Enable or disable E2EE by default based on user's region
2. **Transparency**: Clearly inform users "this channel uses/does not use E2EE"
3. **Legal Page**: Provide a "Law Enforcement Request Guide" in the app, explaining what can and cannot be provided
4. **Regular Legal Review**: Adjust strategy as the legal landscape evolves

**Recommendation**: E2EE is a technical privacy protection, but the legal layer requires accompanying transparency and compliance frameworks. It is recommended to establish a legal review process in Phase 0 and publish the Law Enforcement Request Guide simultaneously with the Phase 1 DM E2E launch.

---

## Appendix

### A. Recommended Library Versions Summary (Mid-2026)

| Category | Library | Version | Purpose |
|---|---|---|---|
| HTTP Security Headers | helmet | ^8.1.0 | Security header middleware |
| CORS | cors | ^2.8.6 | Cross-origin control |
| Rate Limiting | express-rate-limit | ^7.6.0 | API rate limiting |
| JWT | jose | ^6.0.0 | JWT issuance & verification |
| Password Hashing | argon2 | ^0.41.1 | Argon2id password storage |
| XSS Filtering | dompurify | ^3.2.0 | Rich text XSS prevention |
| Input Validation | zod | ^3.23.0 | Schema validation |
| Logging | pino | ^9.6.0 | Structured logging |
| CSRF (if needed) | csrf-csrf | ^3.1.0 | CSRF Token management |
| TOTP (reserved) | otplib | ^12.0.0 | MFA authentication |
| OAuth (reserved) | openid-client | ^6.0.0 | OIDC SSO |
| E2EE Core | @signalapp/libsignal-client | ^0.96.2 | Signal Protocol |
| E2EE Alternative | 2key-ratchet | ^1.8.0 | TS-native Double Ratchet |
| Electron Storage | electron-store | ^10.0.0 | Local secure storage |
| Task Scheduling | node-cron | ^3.0.0 | Scheduled tasks |
| Encrypted Storage | safeStorage (Electron built-in) | — | OS keychain encryption |

### B. Key Decision Log

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Password hashing algorithm | Argon2id vs bcrypt vs scrypt | **Argon2id** | OWASP top choice; strongest GPU attack resistance |
| JWT signing algorithm | HS256 vs RS256 vs Ed25519 | **RS256** | Asymmetric; supports multi-service verification and key rotation |
| Message encryption protocol | Signal Protocol vs MLS vs Matrix Olm | **Signal Protocol** | Industry standard, most mature, high-performance Rust implementation |
| Group encryption scheme | Sender Key vs Pairwise Encryption | **Sender Key** | Scalable for large groups (O(1) encryption), Signal's official approach |
| Token storage | localStorage vs Cookie vs Memory | **Memory** (Electron) | XSS-resistant |
| Key storage | Plaintext file vs electron-store + safeStorage | **Encrypted file** | OS keychain encryption; physical theft protection |
| License | AGPL-3.0 (libsignal) vs MIT (self-implemented) | **Depends on project license** | Open-source projects use libsignal; closed-source products use 2key-ratchet |

### C. Quick Security Self-Check Checklist (Pre-Launch)

- [ ] Helmet.js all security headers configured
- [ ] CORS whitelist mode (no `*`)
- [ ] CSP policy tested (Electron dual-location configuration)
- [ ] HSTS preload submitted
- [ ] `npm audit --audit-level=high` passed
- [ ] All passwords use Argon2id hashing
- [ ] JWT uses short-lived Access Token + Rotation Refresh Token
- [ ] API rate limiting enabled
- [ ] Request body size limited to 1MB
- [ ] No sensitive info in logs (PII sanitized)
- [ ] Audit log table is append-only
- [ ] `.env` not in Git repository
- [ ] Database connections use TLS
- [ ] Electron `contextIsolation: true, sandbox: true, nodeIntegration: false`
- [ ] Preload scripts use `contextBridge` to expose APIs
- [ ] Privacy statement page accessible
- [ ] Data export API available
- [ ] Account deletion (soft delete) flow available

### D. References

1. [Signal Protocol Technical Documentation](https://signal.org/docs/) — Official protocol specification
2. [libsignal GitHub Repository](https://github.com/signalapp/libsignal) — Official Rust implementation
3. [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) — Password storage best practices
4. [Express.js Production Best Practices: Security](https://expressjs.com/en/advanced/best-practice-security.html) — Express security best practices
5. [Electron Security Documentation](https://www.electronjs.org/docs/latest/tutorial/security) — Electron security guide
6. [The Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/) — Double Ratchet protocol specification
7. [The X3DH Key Agreement Protocol](https://signal.org/docs/specifications/x3dh/) — X3DH protocol specification
8. [Sender Keys (Wikipedia)](https://en.wikipedia.org/wiki/Sender_Keys) — Sender Key concept
9. [Signal Private Group System](https://signal.org/blog/signal-private-group-system/) — Signal private group system paper
10. [Sealed Sender — Signal Blog](https://signal.org/blog/sealed-sender/) — Sealed Sender technical blog
11. [2key-ratchet (TypeScript Implementation)](https://github.com/PeculiarVentures/2key-ratchet) — TypeScript-native Double Ratchet
12. [GDPR Official Text](https://gdpr.eu/) — GDPR regulation text
13. [Helmet.js Documentation](https://helmetjs.github.io/) — Helmet security headers documentation
14. [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) — CSRF prevention guide
