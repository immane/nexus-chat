---
lang: en
phase: 1
status: draft
---

# 12 — Phase 1 — Minimal First-Party Base Bots

## Goal

Ship a small set of first-party bots that prove the Bot SDK and Bot Engine are usable without overloading Phase 1.

## Feasibility Guardrail

The full base bot catalog is a stretch goal. Phase 1 must ship at least one reference bot. The recommended minimum set is Welcome Bot, Help Bot, and Notification Bot. Reminder, Poll, Webhook, and Kudos may slip if core IM or E2E work needs stabilization.

## Scope

- `@WelcomeBot`
- `@HelpBot`
- `@NotificationBot`
- Basic bot package layout under `packages/bots/`.
- Shared bot testing harness.

## Stretch Scope

- `@ReminderBot`
- `@PollBot`
- `@WebhookBot`
- `@KudosBot`

## Non-Goals

- No FileBot in Phase 1 unless Attachment Service testing requires it.
- No AIBot in Phase 1.
- No third-party marketplace.

## Bot Boundaries

- Bots store workflow state in bot-owned storage.
- Bots call core APIs for messages/channels/files.
- Bots do not own core lifecycle-critical data.
- Bots cannot access E2E channels.

## Acceptance Criteria

- Welcome Bot sends onboarding DM or channel message when invited/triggered.
- Help Bot responds to `/help`.
- Notification Bot can post an admin-authorized announcement.
- All bots use `@nexus-chat/bot-sdk`.
- No bot-specific tables are added to core schema.

## Test Plan

- Local workspace install test for each bot.
- Command invocation test.
- Permission rejection test.
- E2E channel exclusion test.

## Dependencies

- [10 — Bot Engine Core](10-phase-1-bot-engine-core.md)
- [11 — Node.js Bot SDK](11-phase-1-bot-sdk-node-reference.md)
