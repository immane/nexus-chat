# AI Code Documentation Refactoring

Your task is NOT to add more comments.

Your task is to transform the codebase into an AI-friendly, long-term maintainable project.

Follow these principles strictly.

---

## Philosophy

Comments should explain:

- Why something exists
- Architectural boundaries
- Responsibilities
- Invariants
- Design decisions
- Non-goals

Comments should NEVER explain obvious code.

Bad:

```rust
// Increment counter
counter += 1;
```

Bad:

```ts
// Create websocket server
const server = new Server();
```

Bad:

```go
// User struct
type User struct {}
```

Delete these kinds of comments.

---

## Module Documentation

Every important module/file should start with a module-level documentation block.

Example:

```rust
//! Workspace Service
//!
//! Responsibilities
//! ----------------
//! - Create workspaces
//! - Delete workspaces
//! - Invite members
//!
//! Does NOT
//! ----------------
//! - Handle WebSocket
//! - Access HTTP layer
//! - Persist directly
//!
//! Dependencies
//! ----------------
//! - WorkspaceRepository
//! - EventBus
//!
//! Invariants
//! ----------------
//! - Workspace IDs never change
//! - Owner cannot be removed
```

Equivalent syntax should be used for the current language.

---

## Public APIs

Every public API should describe:

- Purpose
- Inputs
- Outputs
- Side effects
- Possible errors

Not implementation.

Example:

```ts
/**
 * Creates a new workspace.
 *
 * Side Effects:
 * - Emits WorkspaceCreated event
 * - Persists through repository
 *
 * Does NOT:
 * - Send websocket notifications
 */
```

---

## Complex Logic

Whenever a section requires non-trivial reasoning,
write WHY instead of WHAT.

Example:

```rust
// We intentionally perform permission checks before
// database access to avoid unnecessary repository calls.
```

NOT

```rust
// Check permissions
```

---

## Architecture Boundaries

Whenever a module belongs to a specific layer,
document the allowed dependencies.

Example:

```text
Architecture Boundary

Allowed:
- Domain
- Shared

Forbidden:
- HTTP
- Database
- UI
```

This prevents future architectural drift.

---

## Invariants

Whenever a type or module relies on assumptions,
document them.

Example:

```text
Invariant

Every MessageId is globally unique.

Deleted messages are never reused.

Ordering is determined by logical clock,
not database insertion order.
```

---

## Ownership

Large modules should describe what they own.

Example:

```text
Ownership

Owns:
- Session lifecycle
- Authentication state

Does NOT own:
- Authorization
- User persistence
```

---

## Design Decisions

Whenever the code intentionally avoids another approach,
document it.

Example:

```text
We intentionally avoid Mutex.

The event loop guarantees deterministic execution.

Using locks would only increase complexity.
```

---

## Keep Comments Small

Prefer

- 5~20 meaningful lines

instead of

100 trivial comments.

---

## Remove

Delete comments that merely restate code.

Examples:

- initialize variable
- create object
- loop through items
- increment counter
- check if null
- call function

These comments reduce signal-to-noise ratio.

---

## Preserve

DO NOT change behavior.

DO NOT rename APIs unless documentation requires it.

DO NOT refactor business logic.

Only improve documentation quality.

---

## Goal

After finishing, the project should feel like it was written for both:

- Human maintainers
- AI coding agents

Every important design decision should be discoverable without reading the entire implementation.


## AI Context Header

Every important module should begin with this structure:

Responsibilities:
- ...

Inputs:
- ...

Outputs:
- ...

Dependencies:
- ...

Forbidden Dependencies:
- ...

Invariants:
- ...

Related Modules:
- ...

Extension Points:
- ...

Future Evolution:
- ...

