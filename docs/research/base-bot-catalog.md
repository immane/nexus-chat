# Base Bot Catalog for Nexus Chat

## Executive Summary

This document surveys built-in bots and bundled applications across six major instant-messaging platforms and distills the findings into a concrete, prioritized bot catalog for the **nexus-chat** platform. The goal is to identify the minimum set of first-party bots that delivers immediate user value, drives retention, and serves as a demonstration target for the public Bot SDK.

---

## 1. Survey of Built-in Bots/Apps in Major IM Platforms

### 1.1 Slack

| Bot / Feature | Type | Description |
|---|---|---|
| **Slackbot** | AI Assistant + System Bot | Personal agent that answers questions, summarises threads, drafts responses, searches across workspace data, creates canvases, and runs recurring tasks. Also handles `/remind` and custom auto-responses. |
| **Workflow Builder** | No-Code Automation | Visual builder for automated workflows triggered by events (new channel member, emoji reaction, scheduled time). Can post messages, create forms, and call third-party APIs. |
| **Reminders** (`/remind`) | Built-in Command | Set personal, channel, or user-targeted reminders with natural-language time parsing. Tied to Slackbot DM. |
| **Later** | Built-in Feature | Save messages for later review; replaces the old Slackbot-based reminder DM thread. |
| **Canvas** | Collaborative Docs | Rich documents embedded in channels with AI-assisted creation via Slackbot. |
| **Lists** | Task Management | Built-in to-do lists with subtasks, assignees, and workflow automation triggers. |
| **Slack AI** | AI Add-on | Thread/channel summaries, AI search, daily recaps. Available on Business+ and Enterprise plans. |

### 1.2 Discord

| Bot / Feature | Type | Description |
|---|---|---|
| **Clyde** (deprecated, re-introduced as system messages) | AI Chatbot | Originally an AI chatbot (powered by OpenAI); shut down Dec 2023. Now serves as a system-level notification actor for DM welcome messages and server tips. |
| **AutoMod** | Content Moderation | Built-in keyword filter, spam detection, and mention-spam protection. AI-powered variant uses OpenAI to detect rule violations contextually. |
| **Welcome Screen** | Onboarding | Configurable welcome screen shown to new server members with channel suggestions and starter actions. |
| **System DM** | Notification System | Delivers server welcome messages, boost notifications, and safety alerts via a system-level DM channel. |
| **Server Insights** | Analytics | Provides server owners with engagement metrics, member retention data, and growth analytics. |
| **Discovery** | Server Discovery | Curated server directory for public community discovery. |

### 1.3 Microsoft Teams

| Bot / Feature | Type | Description |
|---|---|---|
| **Who Bot** | People Directory | Search for colleagues by name, role, or skillset. Answers "Who knows about X?" queries. |
| **T-Bot** | Help / Onboarding | Interactive tutorial bot that teaches users how to use Microsoft Teams features. |
| **Flow Bot** | Workflow Automation | Triggers Power Automate workflows from within Teams; sends notifications when flows execute. |
| **Praise** | Recognition | Send badges and appreciation messages to colleagues within channels. |
| **Lists** | Task Management | Microsoft Lists integration for structured data tracking within Teams tabs. |
| **Command Bot (template)** | Bot SDK Template | Reference implementation for simple slash-command bots with Adaptive Cards. |
| **Notification Bot (template)** | Bot SDK Template | Reference implementation for proactive notification bots. |
| **Workflow Bot (template)** | Bot SDK Template | Reference implementation for multi-step workflow bots. |

### 1.4 Telegram

| Bot / Feature | Type | Description |
|---|---|---|
| **BotFather** | Bot Management | The canonical bot-creation wizard. Issues tokens, manages bot profiles (name, description, avatar, commands list), and configures webhook URLs. |
| **Service Notifications** | System Notifications | Login alerts, new device notifications, security code delivery. Sent via the official Telegram account. |
| **Verified Bots** | Bot Platform | First-party verified bots: `@Stickers`, `@GmailBot`, `@GameBot`, `@QuizBot`. Telegram uses these as reference implementations. |
| **Bot-to-Bot Communication** | Platform Feature | Bots can be @mentioned in any chat without being members; bots can communicate with each other. |

### 1.5 Mattermost

| Bot / Feature | Type | Description |
|---|---|---|
| **WelcomeBot** | Onboarding Plugin | Posts welcome messages to new users, invites them to channels based on responses. First-party plugin maintained by Mattermost. |
| **Matterpoll** | Polls Plugin | Create polls via `/poll` slash command with real-time voting. |
| **GitHub Plugin** | Dev Integration | Subscribe to repos, receive PR/review/issue notifications in channels. |
| **GitLab Plugin** | Dev Integration | Two-way GitLab integration with slash commands and subscription management. |
| **Jira Plugin** | Dev Integration | Create/view Jira tickets, subscribe to issue updates. |
| **Remind Plugin** | Productivity Plugin | Schedule reminders for users and channels. |
| **Standup Raven** | Standup Plugin | Collect and summarise daily standup reports across teams. |
| **ToDo Plugin** | Task Tracking | Track posts as to-do items with daily reminders. |
| **Bot Accounts** | Platform Feature | First-class user-like accounts with `BOT` tags, personal access tokens, and granular permissions. |

### 1.6 Rocket.Chat

| Bot / Feature | Type | Description |
|---|---|---|
| **rocket.cat** | Default Bot Account | Built-in bot user for testing webhooks and slash commands. Can post to channels. |
| **Rocket.Chat Apps Engine** | Extensibility Platform | SDK for building bots and apps with slash commands, UI elements, and API access. Third-party apps distributed via marketplace. |
| **Outgoing Webhooks** | Integration | Built-in support for outgoing webhooks triggered by message patterns. |

### 1.7 Platform Comparison Summary

| Feature | Slack | Discord | MS Teams | Telegram | Mattermost | Rocket.Chat |
|---|---|---|---|---|---|---|
| AI Assistant Bot | Slackbot | Clyde (shuttered) | Copilot | Guest AI Bots | Mattermost Agents | — |
| Reminders | `/remind` | — | Remind bot | — | Remind Plugin | — |
| Welcome/Onboarding | Workflow Builder | Welcome Screen | T-Bot | — | WelcomeBot | — |
| Polls | Third-party | Third-party | Third-party | QuizBot | Matterpoll | — |
| Workflow Automation | Workflow Builder | AutoMod | Power Automate | Bot API | Playbooks | — |
| Bot SDK | Yes | Yes | Yes | Yes | Yes | Yes |
| Bot Marketplace | App Directory | App Directory | App Store | Bot Store | Marketplace | Marketplace |

---

## 2. Essential Built-in Bot Categories for Nexus Chat

### 2.1 System & Onboarding

#### 2.1.1 Welcome Bot (`@WelcomeBot`)

**Purpose:** Auto-onboard new workspace members, reduce administrator manual effort, and accelerate time-to-value.

**Core Features:**
- DM new members immediately upon joining the workspace with a formatted welcome message.
- Provide an interactive onboarding flow: "What team are you on? / What brings you here?" with button-based responses.
- Auto-suggest relevant channels based on the member's role or team selection.
- Post an announcement in a configurable `#welcome` channel tagging the new member.
- Include quick-start tutorial tips (e.g., "Try `/help` for commands", "Set your profile photo").
- Admin dashboard to configure welcome messages, channel suggestions, and role-based routing.

**Slash Commands:**
| Command | Description |
|---|---|
| `/welcome preview` | Preview the welcome DM template. |
| `/welcome set-channel #channel` | Set the public welcome announcement channel. |
| `/welcome test @user` | Send a test welcome message to a specific user. |

**Events Listened To:**
- `user.joined_workspace`
- `user.profile_updated` (to detect incomplete profiles)

---

#### 2.1.2 Notification Bot (`@NotificationBot`)

**Purpose:** Centralised system notification delivery for workspace-wide announcements, security alerts, and admin broadcasts.

**Core Features:**
- `/announce` command for admins to broadcast a formatted message to all channels or selected channels.
- Multi-channel delivery with delivery confirmation receipts.
- Scheduled announcements (queue a message for a future date/time).
- Rich formatting support: headings, bullet lists, embedded links, mentions.
- Read-receipt tracking dashboard for admins.
- Integration point: all other bots can delegate notification delivery to NotificationBot.

**Slash Commands:**
| Command | Description |
|---|---|
| `/announce #channel "message"` | Broadcast to a specific channel. |
| `/announce all "message"` | Broadcast to all public channels. |
| `/announce schedule "message" at 2026-07-01 09:00` | Schedule a future announcement. |
| `/announce status` | View delivery status of recent announcements. |

**Events Listened To:**
- None (purely command-driven and API-driven).

---

#### 2.1.3 Help Bot (`@HelpBot`)

**Purpose:** In-app help desk — answer "How do I...?" questions, surface documentation, and reduce support burden.

**Core Features:**
- `/help` command lists all available commands across all installed bots.
- `/help <topic>` returns contextual documentation for a specific feature (e.g., `/help reminders`, `/help polls`).
- FAQ search: natural-language query against a curated FAQ knowledge base.
- Quick-link to relevant documentation pages and video tutorials.
- Integration with the public Bot SDK docs — "How do I build a bot?"

**Slash Commands:**
| Command | Description |
|---|---|
| `/help` | List all available slash commands grouped by bot. |
| `/help <topic>` | Search help documentation for a topic. |
| `/help bot <name>` | Show detailed help for a specific bot's commands. |
| `/help faq` | Browse frequently asked questions. |

**Events Listened To:**
- `message.created` (messages in the HelpBot DM channel).

---

### 2.2 Productivity & Workflow

#### 2.2.1 Reminder Bot (`@ReminderBot`)

**Purpose:** Personal and team reminder management with natural-language time parsing.

**Core Features:**
- `/remind me in 30m "standup time"` — personal reminders via DM.
- `/remind @channel "deadline Friday 3pm"` — channel broadcast reminders.
- `/remind @user "review PR" tomorrow 9am` — targeted reminders to specific users.
- Recurring reminders: daily, weekly, weekdays, every N hours.
- Snooze: "Remind me again in 15 minutes."
- `/reminders list` to view all active reminders.
- `/reminders cancel <id>` to cancel.
- Timezone-aware delivery based on user profile settings.

**Slash Commands:**
| Command | Description |
|---|---|
| `/remind me <when> "<text>"` | Set a personal reminder. |
| `/remind @user <when> "<text>"` | Remind a specific user. |
| `/remind #channel <when> "<text>"` | Post a reminder in a channel. |
| `/reminders list` | List all active reminders. |
| `/reminders cancel <id>` | Cancel a specific reminder. |
| `/remind snooze 15m` | Snooze the current reminder for 15 minutes. |

**Events Listened To:**
- `message.created` (slash command parsing).

---

#### 2.2.2 Poll Bot (`@PollBot`)

**Purpose:** Quick, inline polls with real-time results and voting.

**Core Features:**
- `/poll "Question?" "Option A" "Option B" "Option C"` — simple text poll.
- Anonymous or public voting (configurable per poll).
- Single-choice and multi-choice poll variants.
- Real-time results display: inline message updates with bar charts.
- Poll duration: auto-close after N minutes/hours/days.
- Scheduled polls for future deployment.
- Rich-result export (CSV) for poll creators.
- Emoji-style quick polls: `/quickpoll "Lunch?" :pizza: :sushi: :salad:`

**Slash Commands:**
| Command | Description |
|---|---|
| `/poll "Q" "A" "B" ["C"...]` | Create a standard poll. |
| `/poll --anonymous "Q" "A" "B"` | Create an anonymous poll. |
| `/poll --multi "Q" "A" "B" "C"` | Allow multiple selections. |
| `/poll --close-in 30m "Q" "A" "B"` | Auto-close poll after 30 minutes. |
| `/quickpoll "Q" :emoji1: :emoji2:` | Create an emoji-reaction poll. |
| `/poll results` | Show results for the most recent poll in the channel. |
| `/poll close` | Manually close the current poll. |

**Events Listened To:**
- `message.reaction_added`
- `message.reaction_removed`

---

#### 2.2.3 Todo Bot (`@TodoBot`)

**Purpose:** Lightweight task tracking directly within channels and DMs.

**Core Features:**
- `/todo add "Review Q3 roadmap"` — create a personal task.
- `/todo add "Update dependencies" #dev-team` — create a channel-scoped task.
- `/todo list` — list personal tasks.
- `/todo list #channel` — list channel tasks.
- `/todo done <id>` — mark as complete.
- `/todo assign <id> @user` — assign a task to someone.
- `/todo due <id> Friday 5pm` — set a due date.
- Daily digest: DM summary of overdue and upcoming tasks.
- Tasks can be created from any message via context menu ("Add to Todo").

**Slash Commands:**
| Command | Description |
|---|---|
| `/todo add "<task>"` | Add a personal task. |
| `/todo add "<task>" #channel` | Add a channel-scoped task. |
| `/todo list` | List your tasks. |
| `/todo list #channel` | List channel tasks. |
| `/todo done <id>` | Mark a task complete. |
| `/todo assign <id> @user` | Assign a task. |
| `/todo due <id> <when>` | Set a due date. |
| `/todo delete <id>` | Delete a task. |

**Events Listened To:**
- None (command-driven).

---

#### 2.2.4 Standup Bot (`@StandupBot`)

**Purpose:** Automate daily standup collection, reduce synchronous meeting overhead, and surface blockers.

**Core Features:**
- Configurable standup templates: "What did you do yesterday? What will you do today? Any blockers?"
- Scheduled triggers per channel or team.
- Collects responses via DM and posts a summary to the team channel.
- Thread-based follow-up: team members can discuss specific standup items inline.
- Blocker escalation: auto-tags team lead when "blocker" is mentioned.
- History view: `/standup history` shows past standup summaries.
- Reminder nudges for non-respondents.
- Configurable schedule: daily at 9am, weekdays only, etc.

**Slash Commands:**
| Command | Description |
|---|---|
| `/standup start` | Manually trigger a standup round. |
| `/standup configure` | Open standup question template editor. |
| `/standup schedule 9am weekdays` | Set standup schedule. |
| `/standup history` | View past standup summaries. |
| `/standup skip` | Skip today's standup. |
| `/standup stats` | View participation statistics. |

**Events Listened To:**
- `scheduler.tick` (cron-like internal trigger).
- `message.created` (DM responses during active standup rounds).

---

#### 2.2.5 Scheduler Bot (`@SchedulerBot`)

**Purpose:** Meeting scheduling, availability polling, and calendar coordination.

**Core Features:**
- `/schedule "Design Review" --duration 30m --participants @alice @bob @charlie` — propose a meeting.
- Availability polling: bot DMs each participant and collects preferred time slots.
- Integrates with Google Calendar and Outlook Calendar for availability lookups.
- Proposes optimal time slot based on collected availability.
- Auto-creates calendar event and posts a channel invitation.
- `/schedule upcoming` — list upcoming scheduled meetings.
- Timezone-aware scheduling across distributed teams.

**Slash Commands:**
| Command | Description |
|---|---|
| `/schedule "<title>" --duration Nm --participants @u1 @u2` | Propose a meeting. |
| `/schedule poll "<title>" --slots "Mon 2pm" "Tue 10am" "Wed 3pm"` | Manual time-slot poll. |
| `/schedule upcoming` | List upcoming meetings. |
| `/schedule cancel <id>` | Cancel a scheduled meeting. |
| `/schedule availability` | Share your available time slots for the week. |

**Events Listened To:**
- `message.created` (DM responses from availability polling).
- Calendar webhook events (if integrated).

---

### 2.3 Developer & DevOps

#### 2.3.1 GitHub/GitLab Bot (`@GitBot`)

**Purpose:** Bring software development lifecycle events directly into relevant channels.

**Core Features:**
- **Repository subscriptions:** `/git subscribe owner/repo` to receive events.
- **Event types:** push, pull_request (opened/merged/closed), issue (opened/closed/comment), release, workflow_run (CI).
- **Rich previews:** PR/issue cards with title, author, status, labels, assignees.
- **Slash commands:** `/git issue create`, `/git pr list`, `/git search`.
- **Review requests:** notifies reviewers when a PR is assigned.
- **Configurable filters:** only notify on specific branches, labels, or event types.
- `/git summary` — daily/weekly digest of team activity.

**Slash Commands:**
| Command | Description |
|---|---|
| `/git subscribe owner/repo` | Subscribe channel to repo events. |
| `/git unsubscribe owner/repo` | Unsubscribe from repo. |
| `/git subscriptions` | List all repo subscriptions for the channel. |
| `/git issue create "title" --body "..." --repo owner/repo` | Create a GitHub issue. |
| `/git pr list owner/repo` | List open pull requests. |
| `/git search owner/repo "query"` | Search issues and PRs. |
| `/git summary` | Show recent activity digest. |

**Events Listened To:**
- GitHub/GitLab webhook events (push, pull_request, issues, release, workflow_run).

---

#### 2.3.2 CI/CD Bot (`@CIBot`)

**Purpose:** Build status, deployment notifications, and pipeline interaction.

**Core Features:**
- Build status notifications: "Build #42 passed/failed" with link to logs.
- Deployment tracking: "Deploy to production started/completed/rolled back."
- `/deploy <service> <environment>` — trigger deployments from chat.
- `/build status <service>` — check current build status.
- `/ci rollback <service> <environment>` — trigger rollback with confirmation.
- Pipeline approval workflows: "Approve deployment to production?" with Approve/Reject buttons.
- Integration adapters for GitHub Actions, GitLab CI, Jenkins, CircleCI.

**Slash Commands:**
| Command | Description |
|---|---|
| `/deploy <service> to <env>` | Trigger a deployment. |
| `/deploy status <service>` | Check current deployment status. |
| `/build status <service>` | Check build pipeline status. |
| `/ci rollback <service> <env>` | Rollback a deployment. |
| `/ci approve <deploy-id>` | Approve a pending deployment. |

**Events Listened To:**
- CI/CD webhook events (build.started, build.completed, deploy.started, deploy.completed, deploy.failed).

---

#### 2.3.3 Status Page Bot (`@StatusBot`)

**Purpose:** Service health monitoring and incident alerting.

**Core Features:**
- Subscribe to service status: `/status subscribe <service-name>`.
- Incident notifications: "Service X is experiencing elevated error rates."
- Incident updates: "Investigating → Identified → Monitoring → Resolved."
- `/status` — list all monitored services and their current status.
- `/status history <service>` — view incident history.
- Scheduled maintenance announcements.
- Integration with status page providers (e.g., Atlassian Statuspage, self-hosted).

**Slash Commands:**
| Command | Description |
|---|---|
| `/status` | Show all monitored service statuses. |
| `/status subscribe <service>` | Subscribe channel to a service's status updates. |
| `/status history <service>` | View incident history for a service. |
| `/status maintenance schedule "message" at <time>` | Announce upcoming maintenance. |

**Events Listened To:**
- Status page webhook events (incident.created, incident.updated, incident.resolved).
- Status check polling results (fallback when webhooks unavailable).

---

#### 2.3.4 Webhook Bot (`@WebhookBot`)

**Purpose:** Simple incoming webhook → channel message bridge. The "universal adapter."

**Core Features:**
- Generate unique webhook URLs per channel.
- Accept JSON payloads with configurable message templates.
- Template variables for dynamic message formatting.
- Webhook management dashboard: create, test, revoke, view delivery logs.
- Rate limiting and payload size limits (configurable per webhook).
- Authentication options: HMAC signature verification, optional bearer tokens.
- Retry logic with exponential backoff for failed deliveries.

**Slash Commands:**
| Command | Description |
|---|---|
| `/webhook create` | Create a new incoming webhook for the current channel. |
| `/webhook list` | List webhooks for the current channel. |
| `/webhook test <id>` | Send a test payload to the webhook. |
| `/webhook delete <id>` | Delete a webhook. |

**Events Listened To:**
- HTTP POST requests to generated webhook URLs.

---

### 2.4 Communication & Culture

#### 2.4.1 Anonymous Feedback Bot (`@FeedbackBot`)

**Purpose:** Anonymous surveys, suggestions, and sentiment collection.

**Core Features:**
- `/feedback create "How can we improve our sprint process?"` — open-ended question.
- `/feedback survey "Q1" "Q2" "Q3"` — multi-question anonymous survey.
- `/feedback suggest "We should adopt React 19"` — anonymous suggestion box.
- Configurable anonymity: fully anonymous vs. anonymous-to-peers but visible to admins.
- Sentiment analysis on collected feedback.
- Scheduled pulse surveys (e.g., weekly team morale check).

**Slash Commands:**
| Command | Description |
|---|---|
| `/feedback ask "question"` | Pose an anonymous feedback question. |
| `/feedback survey "Q1" "Q2"` | Create an anonymous survey. |
| `/feedback suggest "text"` | Submit an anonymous suggestion. |
| `/feedback results <id>` | View aggregated feedback results (creator only). |
| `/feedback pulse` | Trigger a team morale pulse survey. |

**Events Listened To:**
- `message.created` (DM responses to feedback prompts).

---

#### 2.4.2 Kudos/Recognition Bot (`@KudosBot`)

**Purpose:** Peer recognition, appreciation, and positive culture reinforcement.

**Core Features:**
- `/kudos @user "Thank you for the amazing code review!"` — public recognition.
- `/kudos @user --private "Great work"` — private appreciation.
- Kudos leaderboard: weekly/monthly top-recognised members.
- Kudos categories: Teamwork, Innovation, Leadership, Customer Focus, etc.
- `/kudos stats` — personal kudos received/given summary.
- Admin configurable rewards: kudos milestones trigger badges or notifications.
- Weekly kudos digest posted to a configurable channel.

**Slash Commands:**
| Command | Description |
|---|---|
| `/kudos @user "<message>"` | Send public kudos. |
| `/kudos @user --private "<message>"` | Send private kudos. |
| `/kudos leaderboard` | View kudos leaderboard. |
| `/kudos stats` | View personal kudos statistics. |
| `/kudos categories` | List available kudos categories. |

**Events Listened To:**
- None (command-driven).

---

#### 2.4.3 Celebration Bot (`@CelebrationBot`)

**Purpose:** Automated team celebration for birthdays, work anniversaries, and milestones.

**Core Features:**
- Birthday announcements: posts in a configurable channel on team members' birthdays.
- Work anniversary celebrations: "Happy 2-year work anniversary, @user!"
- Custom milestone tracking: "Congrats on the 100th PR merged!"
- `/celebrate birthday set MM-DD` — set your birthday.
- `/celebrate upcoming` — view upcoming celebrations.
- Configurable celebration messages with emoji and GIF support.

**Slash Commands:**
| Command | Description |
|---|---|
| `/celebrate birthday set MM-DD` | Set your birth date. |
| `/celebrate anniversary set YYYY-MM-DD` | Set your work anniversary. |
| `/celebrate upcoming` | View upcoming celebrations. |

**Events Listened To:**
- `scheduler.tick` (daily check for matching dates).
- `user.profile_updated` (birthday updates).

---

### 2.5 AI-Assisted

#### 2.5.1 AI Assistant Bot (`@AIBot`)

**Purpose:** AI-powered conversational assistant integrated into the chat experience.

**Core Features:**
- **Thread Summarisation:** `/ai summarize thread` generates a concise summary of the current thread's conversation.
- **Channel Recap:** `/ai recap #channel since yesterday` — what did I miss?
- **Question Answering:** Ask questions about past conversations within the user's access scope.
- **Message Translation:** `/ai translate <message-link> to Japanese` — inline translation.
- **Draft Assistance:** `/ai draft "email to the team about the Q3 roadmap"`.
- **Search:** Natural-language search across messages, files, and linked resources.
- **Context-Aware:** Respects the same permission boundaries as the requesting user (cannot surface content from channels the user cannot access).
- Configurable AI provider backend (OpenAI, Anthropic, local LLM via Ollama).

**Slash Commands:**
| Command | Description |
|---|---|
| `/ai summarize` | Summarize the current channel or thread. |
| `/ai summarize thread` | Summarize the current thread. |
| `/ai recap #channel since <when>` | Recap activity in a channel. |
| `/ai ask "<question>"` | Ask a question about workspace knowledge. |
| `/ai translate "<text>" to <lang>` | Translate text. |
| `/ai draft "<instructions>"` | Draft content based on instructions. |
| `/ai search "<query>"` | AI-powered semantic search. |

**Events Listened To:**
- None (command-driven and DM-based conversations).

**Important Notes:**
- AI features should be opt-in at the workspace level.
- Data privacy: ensure AI processing respects E2EE boundaries. Messages from encrypted channels must never be sent to external AI providers unless explicitly configured.
- On-premise / air-gapped deployment must support local model backends.

---

#### 2.5.2 Meeting Notes Bot (`@MeetingBot`)

**Purpose:** Auto-transcribe and summarise meeting content from voice/video channels.

**Core Features:**
- Join voice/video channels and produce real-time transcription.
- Generate structured meeting notes: attendees, key decisions, action items.
- Post summary to a linked text channel after the meeting ends.
- `/meeting start` — manually start transcription and notes.
- `/meeting action-item "Deploy hotfix by EOD"` — flag an action item during meeting.
- Searchable meeting archive: browse past meeting notes.
- Integration with calendar events for automatic meeting detection.

**Slash Commands:**
| Command | Description |
|---|---|
| `/meeting start` | Start meeting transcription in the current voice channel. |
| `/meeting stop` | Stop transcription and post summary. |
| `/meeting action-item "<text>"` | Record an action item. |
| `/meeting notes <meeting-id>` | View notes from a past meeting. |
| `/meeting search "<keyword>"` | Search past meeting notes. |

**Events Listened To:**
- `voice_channel.user_joined`
- `voice_channel.user_left`
- Calendar event start/end webhooks.

---

### 2.6 Moderation & Safety (Future Phase)

| Bot | Description | Phase |
|---|---|---|
| **AutoMod Bot** | Content filtering, spam detection, raid protection, rate limiting per user/channel. | Phase 3 |
| **Report Bot** | `/report @user "reason"` — structured reporting with moderation queue dashboard. | Phase 3 |
| **Audit Log Bot** | Message edit/delete logging, member join/leave tracking, permission change logging. | Phase 3 |

---

## 3. Bot Priority Matrix

| # | Bot Name | Category | Value Score (1–10) | Implementation Complexity | MVP | Phase |
|---|---|---|---|---|---|---|
| 1 | **Welcome Bot** | System & Onboarding | 9 | Low | Yes | Phase 1 |
| 2 | **Help Bot** | System & Onboarding | 8 | Low | Yes | Phase 1 |
| 3 | **Notification Bot** | System & Onboarding | 7 | Low | Yes | Phase 1 |
| 4 | **Reminder Bot** | Productivity | 9 | Low | Yes | Phase 1 |
| 5 | **Poll Bot** | Productivity | 8 | Low | Yes | Phase 1 |
| 6 | **Webhook Bot** | Developer & DevOps | 8 | Low | Yes | Phase 1 |
| 7 | **Kudos Bot** | Communication & Culture | 7 | Low | Yes | Phase 1 |
| 8 | **Todo Bot** | Productivity | 7 | Medium | No | Phase 2 |
| 9 | **GitHub/GitLab Bot** | Developer & DevOps | 8 | Medium | No | Phase 2 |
| 10 | **CI/CD Bot** | Developer & DevOps | 7 | Medium | No | Phase 2 |
| 11 | **Standup Bot** | Productivity | 7 | Medium | No | Phase 2 |
| 12 | **AI Assistant Bot** | AI-Assisted | 10 | High | No | Phase 2 |
| 13 | **Celebration Bot** | Communication & Culture | 6 | Low | No | Phase 2 |
| 14 | **Feedback Bot** | Communication & Culture | 6 | Medium | No | Phase 2 |
| 15 | **Status Bot** | Developer & DevOps | 6 | Medium | No | Phase 3 |
| 16 | **Scheduler Bot** | Productivity | 7 | High | No | Phase 3 |
| 17 | **Meeting Notes Bot** | AI-Assisted | 8 | Very High | No | Phase 3 |

**Scoring Methodology:**
- **Value Score:** Derived from user retention/stickiness impact, how frequently the feature is used in competing platforms, and how much it differentiates nexus-chat.
- **Implementation Complexity:** Low = essentially a single slash-command handler with minimal state. Medium = requires scheduled jobs, webhook ingress, or multi-step workflows. High = requires external service integrations, complex state management, or AI/ML infrastructure.

---

## 4. Bot Interaction Models

### 4.1 Slash Commands Matrix

| Bot | Key Commands | Command Count (Phase 1) |
|---|---|---|
| Welcome Bot | `/welcome preview`, `/welcome set-channel`, `/welcome test` | 3 |
| Help Bot | `/help`, `/help <topic>`, `/help bot <name>`, `/help faq` | 4 |
| Notification Bot | `/announce`, `/announce all`, `/announce schedule`, `/announce status` | 4 |
| Reminder Bot | `/remind`, `/reminders list`, `/reminders cancel`, `/remind snooze` | 4 |
| Poll Bot | `/poll`, `/quickpoll`, `/poll results`, `/poll close` | 4 |
| Webhook Bot | `/webhook create`, `/webhook list`, `/webhook test`, `/webhook delete` | 4 |
| Kudos Bot | `/kudos`, `/kudos leaderboard`, `/kudos stats`, `/kudos categories` | 4 |
| Todo Bot | `/todo add`, `/todo list`, `/todo done`, `/todo assign`, `/todo due`, `/todo delete` | 6 |
| GitHub/GitLab Bot | `/git subscribe`, `/git unsubscribe`, `/git subscriptions`, `/git issue create`, `/git pr list`, `/git search`, `/git summary` | 7 |
| CI/CD Bot | `/deploy`, `/deploy status`, `/build status`, `/ci rollback`, `/ci approve` | 5 |
| Standup Bot | `/standup start`, `/standup configure`, `/standup schedule`, `/standup history`, `/standup skip`, `/standup stats` | 6 |
| AI Assistant Bot | `/ai summarize`, `/ai recap`, `/ai ask`, `/ai translate`, `/ai draft`, `/ai search` | 6 |
| Celebration Bot | `/celebrate birthday set`, `/celebrate anniversary set`, `/celebrate upcoming` | 3 |
| Feedback Bot | `/feedback ask`, `/feedback survey`, `/feedback suggest`, `/feedback results`, `/feedback pulse` | 5 |
| Status Bot | `/status`, `/status subscribe`, `/status history`, `/status maintenance schedule` | 4 |
| Scheduler Bot | `/schedule`, `/schedule poll`, `/schedule upcoming`, `/schedule cancel`, `/schedule availability` | 5 |
| Meeting Notes Bot | `/meeting start`, `/meeting stop`, `/meeting action-item`, `/meeting notes`, `/meeting search` | 5 |

### 4.2 Event Listeners Matrix

| Bot | Events Subscribed | Description |
|---|---|---|
| Welcome Bot | `user.joined_workspace`, `user.profile_updated` | Detect new members and incomplete profiles. |
| Help Bot | `message.created` (DM only) | Respond to help queries in DM. |
| Reminder Bot | `message.created` | Parse slash commands. |
| Poll Bot | `message.reaction_added`, `message.reaction_removed` | Track emoji-reaction poll votes. |
| Standup Bot | `scheduler.tick`, `message.created` (DM) | Trigger standup rounds, collect responses. |
| Celebration Bot | `scheduler.tick`, `user.profile_updated` | Daily date check for celebrations. |
| GitHub/GitLab Bot | Webhook: `push`, `pull_request.*`, `issues.*`, `release.*`, `workflow_run.*` | External git events. |
| CI/CD Bot | Webhook: `build.*`, `deploy.*` | External CI pipeline events. |
| Status Bot | Webhook: `incident.*`, `scheduler.tick` | External status page events + polling fallback. |
| Feedback Bot | `message.created` (DM) | Collect anonymous survey responses via DM. |
| Scheduler Bot | `message.created` (DM), Calendar webhooks | Availability polling responses. |
| Meeting Bot | `voice_channel.user_joined`, `voice_channel.user_left`, Calendar webhooks | Meeting lifecycle detection. |

### 4.3 Storage Requirements

| Bot | Persistent Storage Needed | Notes |
|---|---|---|
| Welcome Bot | Yes | Welcome message templates, channel mappings, role-based routing rules. |
| Help Bot | Yes | FAQ entries, documentation index, custom help content per workspace. |
| Notification Bot | Yes | Announcement history, delivery status, scheduled announcements queue. |
| Reminder Bot | Yes | Active reminders (user, time, message, channel, recurrence rule). |
| Poll Bot | Yes | Active polls (question, options, votes, anonymous flag, close time). |
| Webhook Bot | Yes | Webhook URLs, channel mappings, message templates, delivery logs. |
| Kudos Bot | Yes | Kudos records, leaderboard aggregations, reward configurations. |
| Todo Bot | Yes | Task list (user, channel, description, status, due date, assignee). |
| GitHub/GitLab Bot | Yes | Repository subscriptions per channel, event filters. |
| CI/CD Bot | Yes | Deployment history, pipeline configurations, approval state. |
| Standup Bot | Yes | Standup templates, schedules, response history, participation stats. |
| AI Assistant Bot | No* | Stateless per request (but may cache embeddings or summaries for performance). |
| Celebration Bot | Yes | Birthdays, anniversaries, milestone definitions. |
| Feedback Bot | Yes | Survey templates, collected responses (anonymised), aggregated results. |
| Status Bot | Yes | Service subscriptions, incident history. |
| Scheduler Bot | Yes | Meeting proposals, availability responses, calendar links. |
| Meeting Notes Bot | Yes | Transcripts, meeting summaries, action items, search index. |

> **Note:** All bots that require persistent storage should use the nexus-chat **Bot KV Store** (a scoped key-value storage API provided by the Bot SDK) for simple state. Bots with complex relational data (e.g., PollBot's votes-per-user-per-option) should use dedicated PostgreSQL tables via Drizzle ORM.

### 4.4 Multi-Language Support Needs

| Priority | Bots | Rationale |
|---|---|---|
| **High** — Must support i18n from Day 1 | Welcome Bot, Help Bot, Notification Bot, Reminder Bot | These are user-facing surface bots that every member interacts with. Poor localisation directly harms retention. |
| **Medium** — i18n needed for broader adoption | Poll Bot, Todo Bot, Standup Bot, Kudos Bot, Celebration Bot, Feedback Bot | Productivity and culture bots used regularly by teams. Localisation improves engagement. |
| **Low** — English-first acceptable | GitHub/GitLab Bot, CI/CD Bot, Webhook Bot, Status Bot, Scheduler Bot | Developer-facing bots where English is the de facto standard. i18n is nice-to-have. |
| **N/A** — Language-agnostic | AI Assistant Bot, Meeting Notes Bot | These handle multilingual input/output natively via the underlying LLM. |

**Implementation Strategy:**
- All Phase 1 bots should ship with an `en.json` locale file and a `_locale` key in their manifest.
- Bot SDK should provide a `t(key, params)` helper that resolves locale strings from the bot's manifest.
- Workspace-level locale setting determines which locale file the bot SDK loads.
- User-level locale override (in profile settings) takes precedence over workspace locale.

---

## 5. Implementation Strategy

### 5.1 First-Party vs. Third-Party Classification

#### First-Party Bots (Built by Nexus Chat Team)

These bots are developed, maintained, and shipped by the nexus-chat core team. They are bundled with the platform and available out of the box. They serve as both essential features AND reference implementations for the Bot SDK.

| Bot | Rationale for First-Party |
|---|---|
| **Welcome Bot** | Core onboarding — every workspace needs this. Too critical to leave to third parties. |
| **Help Bot** | Platform documentation integration requires deep knowledge of nexus-chat internals. |
| **Notification Bot** | Tight integration with workspace admin features and permission system. |
| **Reminder Bot** | Table-stakes productivity feature that every competitor has. Drives daily active usage. |
| **Poll Bot** | High-engagement feature that showcases real-time message update capabilities of the SDK. |
| **Webhook Bot** | Gateway integration — demonstrates the inbound integration pattern for the SDK. |
| **AI Assistant Bot** | Major differentiator. Requires deep platform integration (permission-aware search, E2EE boundaries). Core team must own the security model. |
| **Todo Bot** | High-frequency utility. Bundled presence signals product completeness. |
| **Kudos Bot** | Culture feature that differentiates enterprise IM from consumer chat. |
| **GitHub/GitLab Bot** | Most-requested integration in developer surveys. Serves as the reference webhook-integration bot. |
| **CI/CD Bot** | Complements GitBot. Together they form the ChatOps foundation. |

#### Official Third-Party Example Bots (Seeded by Nexus Chat Team)

These bots are built by the nexus-chat team using the public Bot SDK but distributed as separate installable packages. Their primary purpose is to demonstrate the SDK's capabilities and serve as templates for community developers.

| Bot | Rationale for Third-Party Seeding |
|---|---|
| **Standup Bot** | Highly customisable per team — good example of a bot that benefits from community forks and specialisation. |
| **Celebration Bot** | Low complexity, good "my first bot" example for SDK tutorials. |
| **Feedback Bot** | Demonstrates DM-based interaction patterns and anonymous data collection in the SDK. |
| **Status Bot** | Demonstrates external service webhook integration pattern. |
| **Scheduler Bot** | Demonstrates multi-step conversational workflows and calendar integration. |
| **Meeting Notes Bot** | Demonstrates voice/video channel integration and AI pipeline usage in the SDK. |

### 5.2 Phase Rollout Plan

#### Phase 1 — MVP (Launch)
**Goal:** Workspace is usable and immediately valuable on day one.

| # | Bot | Key Deliverable |
|---|---|---|
| 1 | Welcome Bot | Basic welcome DM + `#welcome` channel announcement. |
| 2 | Help Bot | `/help` command listing + static FAQ responses. |
| 3 | Notification Bot | `/announce` to channel and workspace. |
| 4 | Reminder Bot | `/remind me` and `/remind #channel` with natural-language time parsing. |
| 5 | Poll Bot | `/poll` with real-time reaction-based voting. |
| 6 | Webhook Bot | Channel webhook URL generation + JSON → message template. |
| 7 | Kudos Bot | `/kudos @user` with leaderboard. |

#### Phase 2 — Engagement & Developer Tooling (3 months post-launch)
**Goal:** Deepen daily engagement and attract developer teams.

| # | Bot | Key Deliverable |
|---|---|---|
| 1 | Todo Bot | Full task CRUD + channel-scoped lists + due dates. |
| 2 | GitHub/GitLab Bot | Repo subscriptions + rich event previews + slash commands. |
| 3 | CI/CD Bot | Build/deploy notifications + `/deploy` command. |
| 4 | Standup Bot | Scheduled standups + summary posting + blocker escalation. |
| 5 | AI Assistant Bot | Thread summarisation + `/ai ask` + `/ai translate` + `/ai draft`. |
| 6 | Celebration Bot | Birthday and anniversary auto-posting. |
| 7 | Feedback Bot | Anonymous surveys and suggestion box. |

#### Phase 3 — Maturity & Ecosystem (6+ months post-launch)
**Goal:** Enterprise feature parity, bot marketplace launch, community contributions.

| # | Bot | Key Deliverable |
|---|---|---|
| 1 | Status Bot | Service health monitoring with incident lifecycle. |
| 2 | Scheduler Bot | Meeting scheduling with availability polling + calendar sync. |
| 3 | Meeting Notes Bot | Voice channel transcription + structured meeting summaries. |
| 4 | AutoMod Bot | Content filtering, spam detection, rate limiting. |
| 5 | Bot Marketplace | Discovery, installation, reviews, and billing for third-party bots. |

### 5.3 Bot SDK Design Implications

The first-party bots listed above collectively exercise every capability the Bot SDK must expose. The SDK must support:

1. **Slash Command Registration:** Declarative command definitions with argument parsing and validation.
2. **Event Subscriptions:** Subscribe to platform events (`user.joined_workspace`, `message.created`, `message.reaction_added`, `scheduler.tick`, `voice_channel.*`).
3. **Message API:** Post messages, update messages (for live poll results), send DMs, post rich cards.
4. **Scheduled Jobs:** Register cron-like triggers for recurring tasks (standups, celebrations, reminders).
5. **Incoming Webhooks:** Generate, manage, and receive at webhook endpoints scoped to a bot instance.
6. **Outgoing HTTP:** Make authenticated HTTP requests to external services (GitHub API, CI/CD servers, status pages, AI providers).
7. **KV Store:** Scoped key-value storage per bot per workspace (`bot.kv.get(key)`, `bot.kv.set(key, value)`, `bot.kv.delete(key)`).
8. **Database Access:** For bots requiring relational queries, access to workspace PostgreSQL via Drizzle ORM with table isolation.
9. **Localisation:** `bot.t(key, params)` helper that resolves locale strings.
10. **UI Components:** Buttons, select menus, modals, and rich card templates for interactive bot messages.

### 5.4 Bot Marketplace Concept (Phase 3)

The Bot Marketplace is the long-term distribution and discovery channel for third-party bots.

**Core Marketplace Features:**
- Bot listing page with name, description, screenshots, rating, install count.
- One-click install into a workspace (admin approval required for bots requesting sensitive scopes).
- OAuth2-based authorisation flow for bots requiring external service access.
- Versioning: bot developers publish versioned releases; workspace admins can pin to a specific version.
- Review and rating system.
- Free and paid bots with billing integration.
- Sandbox testing environment: install a bot in a test workspace before production.

**First-Party vs. Community Distinction:**
| Attribute | First-Party | Community |
|---|---|---|
| Badge | "By Nexus Chat" verified badge | Community author attribution |
| Support SLA | Covered by platform SLA | Best-effort by author |
| Review | Internal QA | Community moderation |
| Monetisation | Free (bundled) | Free or paid (developer sets price) |
| Source | Closed (in monorepo) | Open (linked repository) |

---

## 6. References

- Slack Help Center — "How to use Slackbot." https://slack.com/help/articles/202026038-How-to-use-Slackbot
- Slack — "Workflow Builder." https://slack.com/features/workflow-automation
- Discord Support — "AutoMod FAQ." https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ
- Microsoft Learn — "Teams bots overview." https://learn.microsoft.com/en-us/microsoftteams/platform/bots/overview
- Geekbot Blog — "21 Bots For Microsoft Teams." https://geekbot.com/blog/21-bots-for-microsoft-teams-to-reinvent-your-organizations-productivity/
- Telegram — "Bot Features." https://core.telegram.org/bots/features
- Mattermost Developers — "Bot accounts." https://developers.mattermost.com/integrate/reference/bot-accounts/
- Mattermost Marketplace — https://mattermost.com/marketplace/
- Mattermost — "Bots documentation." https://mattermost-docssandrospadaro.readthedocs.io/en/latest/deployment/bots.html
- Rocket.Chat Developer — "Bots Architecture." https://developer.rocket.chat/docs/bots-architecture
- VibeBot Blog — "Must-Have Discord Bots 2026." https://www.vibebot.gg/blog/best-discord-bots-2026
- Slack — "How to use reminders in Slack." https://slack.com/resources/using-slack/how-to-use-reminders-in-slack
