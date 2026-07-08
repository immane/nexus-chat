# Security Policy

Thank you for helping keep **Nexus Chat** secure.

If you discover a security vulnerability, **please do not open a public GitHub issue**. Instead, use **GitHub Private Vulnerability Reporting** to report the issue privately to the maintainers.

## Reporting a Vulnerability

Please include as much information as possible:

- A clear description of the vulnerability
- Steps to reproduce or a proof-of-concept (PoC)
- Affected versions or commit ranges
- Potential impact
- Any suggested mitigations (if available)

We aim to acknowledge reports within **48 hours** and will work with the reporter to investigate, resolve, and coordinate responsible disclosure where appropriate.

---

## Supported Versions

| Version | Status |
|---------|--------|
| v0.1.x | Supported |
| `main` | Development |

Only supported versions receive security fixes.

---

## Security Model

Nexus Chat uses a hybrid encryption architecture.

### Normal Channels

- Messages are stored server-side in plaintext.
- All communication is protected using TLS.

### End-to-End Encrypted Conversations

- Uses the Signal Protocol (X3DH + Double Ratchet).
- Message contents are encrypted on the client.
- The server acts only as an opaque relay and cannot decrypt message contents.

If your report involves cryptographic weaknesses, please specify whether the issue affects:

- TLS
- JWT authentication
- Signal Protocol implementation
- Cryptographic dependencies
- Other security components

---

## Dependency Security

Dependencies are continuously monitored using GitHub Dependabot and the GitHub Advisory Database.

Critical upstream security advisories will be addressed as soon as practical, with a target response time of **7 days** whenever possible.

---

## In Scope

The following components are considered **in scope**:

- `apps/server/`
- `apps/web/`
- `apps/desktop/`
- `apps/tui/`
- `packages/bot-sdk/`
- `packages/signal/`
- `packages/shared/`
- Docker images and Docker Compose configuration

---

## Out of Scope

The following are generally **out of scope**:

- Demo mode or sample data
- Documentation issues or typos
- Third-party services outside the project's control (for example STUN/TURN servers)
- Social engineering or phishing attacks
- Physical access attacks

---

## Responsible Disclosure

Please allow reasonable time for a fix before publicly disclosing a vulnerability.

We appreciate responsible disclosure and, where appropriate, will acknowledge security researchers for their contributions unless anonymity is requested.