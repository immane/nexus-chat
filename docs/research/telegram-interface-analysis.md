# Telegram Interface & Feature Analysis

> Research date: 2026-07-07
> Purpose: Competitive analysis for Nexus Chat UX design

## 1. Chat & Messaging

### Message Types
| Type | Details |
|------|---------|
| Text | Markdown: bold, italic, monospace, strikethrough, underline, quote block, spoiler, inline links |
| Voice | Tap-and-hold mic, swipe up to lock recording, animated waveform, waveform visualization on playback |
| Video message | Round "bubble" format, tap-to-play, up to 60s |
| Stickers | Static, animated (TGS ~30KB), video stickers |
| GIFs | Giphy integration, searchable, premium: 400 favorites |
| Polls | Anonymous, Visible Votes, Quiz mode with correct answer |
| Quizzes | Multi-question via @QuizBot, global leaderboards |
| Location | Live location sharing with duration timer |
| Media albums | Group up to 10 photos/videos, swipeable |
| Dice / animated emoji | Interactive, full-screen synchronized effects |

### Message Actions
- **Reply** — swipe left on message; preview header links to original
- **Forward** — option to hide sender name/captions; preserve reply context
- **Edit** — shows "edited" label
- **Delete** — self or everyone (48h window)
- **Pin** — premium: 10 in main list, unlimited per folder
- **Copy** — select portion or full copy
- **Translate** — per-message translate button
- **Schedule** — long-press Send > Schedule; reminders via Saved Messages
- **Silent messages** — long-press Send > Send Without Sound
- **Message effects** — 6 free, hundreds premium; animated send effects
- **Hashtags** — global + per-chat search

### Message Reactions
- Double-tap for default 👍 (configurable)
- Extended reaction menu: 😁🎉😱🔥👎
- Premium exclusive emoji set
- Compact + press-and-hold larger animations
- Synchronized real-time reactions
- ♡ button when unseen reactions exist
- Admin control per group/channel

### Auto-Delete
- Flexible timers in any chat: 24h, 7d, custom durations
- Quick toggle from chat info

---

## 2. Channels & Groups

### Channel Types
- **Public** — @username, discoverable, t.me links
- **Private** — invite-only, no search visibility
- Stats for channels >50 subscribers
- Free: 500 channels max; premium: 1,000

### Group Types & Limits
- Basic groups: up to 200 members
- Supergroups: up to 200,000 members
- Public groups: join requests + admin approval
- Private groups: invite links only

### Admin Tools
- Custom admin titles displayed on messages
- Granular per-member-type permissions
- Slow mode with visible cooldown
- Reaction emoji management
- Multiple invite links with expiry/usage limits, QR codes
- Join requests — approve before member can write
- Recent actions / admin log (full audit)
- Group ownership transfer
- Anti-spam: bot-based + AI guardians

### Topics / Forums
- Split large groups into subject-based subtopics
- Each topic acts as individual chat with own media and notification settings
- Admin control over topic creation

---

## 3. 1:1 DMs & Secret Chats

### Normal DMs
- Cloud-based, synced across devices
- Server-client encrypted (MTProto)
- All standard messaging features available

### Secret Chats (E2E)
- E2EE via MTProto
- Device-specific — not synced to cloud
- Self-destruct timer: 1s to 1 week
- Screenshot alerts
- No forwarding allowed
- Key verification via emoji comparison
- No cloud backup — exists only on 2 devices

---

## 4. Voice & Video Calls

### 1:1 Calls
- E2E encrypted
- 4-emoji key verification
- P2P with relay fallback
- AI adaptive audio quality
- Privacy: control who can call (Everyone / Contacts / Nobody)

### Group Voice Chats
- Thousands of participants
- Join/leave freely, talk or listen
- Admin-recordable
- Shareable invite links

### Video Calls
- E2E encrypted 1:1 video
- Screen sharing, video streaming
- PiP on all platforms (pinch to resize)
- Dynamic backgrounds and animations

---

## 5. Stickers, GIFs, Emoji

### Stickers
- Static (webp/PNG), animated (TGS <30KB), video stickers
- Custom sticker packs — anyone can create
- Premium: full-screen animations, monthly artist updates
- Emoji-based sticker suggestions

### GIFs
- Giphy integration, searchable
- Premium: 400 favorites

### Emoji
- Animated emoji for single sends (❤️👍😁🔥)
- Interactive synchronized full-screen effects
- Custom emoji platform — open, premium: 500+ emoji
- `:keyword` search for emoji suggestions

---

## 6. Bots & Mini Apps

### Bot Capabilities
- Inline bots: `@botname` in any chat without adding
- `/command` with autocomplete
- Reply keyboards (replace standard keyboard)
- Inline keyboards (buttons under messages)
- Bot menu button in profile
- Attachment menu integration
- Bot payments: 15 providers + Google/Apple Pay
- Seamless Telegram login authorization
- Admin bots with instant rights configuration

### Mini Apps / Web Apps
- Full JS/HTML5 interfaces inside Telegram
- Match user theme (day/night, custom colors)
- Access native features via Telegram API
- Seamless auth + payments

---

## 7. Folders & Organization

### Chat Folders
- Tab-based, custom categories
- Filter by: chat type, unread, individual selection
- Swipe between folder tabs
- Unlimited pins per folder
- Cross-device sync
- Premium: 20 folders with 200 chats each, default folder
- Shareable folder links

### Archived Chats
- Swipe left to archive
- Notification pops archived chat back (muted stays archived)
- Premium: auto-archive new non-contact chats

### Saved Messages
- Personal cloud storage for notes/reminders/forwarded content
- Scheduled messages become reminders
- Premium: sub-folders within Saved Messages

### Pinned Chats
- Pin to top; premium: up to 10

---

## 8. Search

- **Global**: all public channels, groups, bots, by @username
- **In-chat**: per-chat message search, date picker
- **Filters**: media, links, files, music, voice messages
- **Hashtags**: # search within and across chats

---

## 9. Notifications

- Custom notification sounds per chat (any audio <5s, <300KB)
- Cross-platform sound sync
- Mute: 1h, 8h, 2d, custom, until turned on
- Per-chat notification exceptions
- Preview control: sender name, message text, or none

---

## 10. Privacy & Security

| Feature | Detail |
|---------|--------|
| 2FA | Password + SMS code on new device |
| Passkeys | Biometric passwordless login |
| Active sessions | View and terminate all sessions |
| Passcode lock | App-level passcode or biometric |
| Last seen | Everyone / Contacts / Nobody + exceptions |
| Profile photo | Per-privacy-level control |
| Phone number | Visibility + find-by-number settings |
| Forwarded messages | Link-back to account control |
| Calls | Restrict who can call |
| Blocking | Block + report spam |

---

## 11. Profile & Settings

- @username for t.me links; collectible (TON blockchain)
- Bio with link (premium: longer)
- Profile photo (premium: animated video)
- Themed QR codes for any entity
- Phone number change while keeping data
- Multiple accounts: 3 free, 4 premium
- Custom cloud themes with shareable links and color wheel

---

## 12. File Sharing & Storage

- Free: 2GB per file, unlimited cloud storage
- Premium: 4GB per file
- Uncompressed documents option
- Video compression preview before sending
- Cloud sync across all devices
- Any media type supported

---

## 13. Multi-Device

- Seamless cloud sync (chats, messages, media, folders, themes, sounds)
- Desktop: Windows, Mac, Linux
- Web: WebK, WebA (mobile)
- Mobile: iOS, iPadOS, Android
- Smartwatch: Apple Watch, Android wearables
- Secret Chats exception: device-specific only

---

## 14. Premium Features (~$4.99/mo)

| Category | Feature |
|----------|---------|
| Uploads | 4GB files |
| Speed | Fastest download |
| Limits | 1,000 channels, 20 folders, 4 accounts, 10 pins, 20 public links |
| Voice-to-Text | Convert voice/video messages |
| Translation | Real-time full chat translation |
| Stickers | Exclusive animated, monthly updates |
| Reactions | 10+ exclusive emoji |
| Chat Mgmt | Default folder, auto-archive non-contacts |
| Profile | Animated video, badge, premium icons |
| Ads | No sponsored messages |
| Privacy | Control who sends voice/video messages |

---

## 15. UI/UX Patterns

### Navigation
- Desktop: sidebar chat list + conversation pane
- Android: hamburger menu + swipe tabs
- iOS: bottom tab bar (Chats, Calls, Settings)
- Long-press back button: recent chats quick jump

### Gestures
- Swipe left on message → reply
- Swipe left on chat → archive
- Pull down → reveal hidden archive
- Long-press chat → bulk actions
- Long-press send → schedule, silent, effects
- Swipe up lock → hands-free voice recording
- Pinch on PiP → resize player

### Visual
- Dark mode with accent color variants
- Custom cloud-synced themes with color wheel
- Message bubble corner radius toggle
- 120 FPS animations on supported devices
- Pulsing loading placeholders
- Swipe-to-reply animation feedback

### Media
- PiP on all platforms
- Video scrubbing with thumbnail previews
- Media compression preview

### Chat Interaction
- Long-press profile pic → chat preview without marking read
- Multi-select chats for batch operations
- Drag to rearrange folders
- Pull-to-refresh chat list

---

## Key Takeaways for Nexus Chat

1. **Reaction system** — synchronized real-time, per-emoji counts, admin control
2. **Secret chat model** — device-specific E2E, self-destruct, screenshot alerts, key verification
3. **Folders** — tab-based organization with custom filters, cross-device sync
4. **Search** — multi-dimensional (text, media, links, files, date, hashtags)
5. **Bot platform** — inline, slash commands, custom keyboards, payments, mini apps
6. **Notification granularity** — per-chat custom sounds, flexible mute, exception rules
7. **Privacy controls** — layered per-setting with exception lists
8. **Multi-account** — 3-4 accounts in single app
9. **Theming** — shareable, cloud-synced, color wheel customization
10. **Premium model** — cosmetic + limit boosts, not feature gating
