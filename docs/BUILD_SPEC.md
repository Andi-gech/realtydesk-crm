# RealtyDesk CRM — Build Specification & Implementation Guide

> **Audience for this document:** an engineer or another AI continuing this build.
> **Purpose:** a complete, unambiguous guide to the architecture, data model, API
> contract, client flows, and — most importantly — the **security boundary** that
> must never be violated while implementing any feature below.

---

## 1. Product Summary

RealtyDesk is a Windows desktop CRM for real estate sales teams who prospect and
communicate with clients over Telegram.

- A **single installable app** (`RealtyDesk.exe`, built with Tauri). The same
  binary serves two roles, chosen at login:
  - **Agent Mode** — logged in with a team activation code.
  - **Owner Mode** — logged in with owner/admin credentials.
- Agents can link **multiple personal Telegram accounts** and send/receive
  messages directly through Telegram (MTProto), with everything synced to a
  central server so the team has one shared source of truth.
- The **Owner** gets an org-wide view across all agents and all linked
  accounts: unified inbox, agent-ownership tags, search/filter, duplicate-lead
  flagging, shared notes and templates.
- The server is a plain REST API over MongoDB. It never runs a live Telegram
  connection and never has the ability to send a message as an agent.

---

## 2. The One Rule That Overrides Every Feature Below

> **The server must never possess a usable Telegram credential for any agent.**

Concretely:
- An agent's MTProto session string (or the raw auth key material behind it)
  is generated and stored **only on that agent's own device** — in the OS
  keychain or an OS-DPAPI-encrypted local file. It is **never** included in
  any API request body, response, log line, or database document.
- The server stores **synced message content and metadata** (what was said,
  to whom, when, by which linked account) — never the credential that could
  be replayed to send new messages as that account.
- The Owner's "reply" action sends through **the Owner's own linked Telegram
  account** (added via the same `+ Add Telegram` flow, under their own
  Owner profile), not through any agent's session. The agent sees the
  owner's message appear in the synced thread, clearly attributed to the
  owner.
- If a future feature seems to require the server to hold or proxy an
  agent's session, stop and redesign — that is the line this product does
  not cross, for both ethical and legal-liability reasons (impersonation of
  a sales rep without their knowledge or consent).

Any implementer (human or AI) picking this project up must re-read this
section before touching session storage, auth, or the "reply" endpoints.

---

## 3. High-Level Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   Agent Desktop Client   │        │   Owner Desktop Client    │
│  (Tauri, Rust + WebView) │        │  (same binary, Owner Mode)│
│                          │        │                           │
│  - MTProto session(s)    │        │  - Own MTProto session(s) │
│    stored locally only   │        │    stored locally only    │
│  - GramJS/TDLib client   │        │  - GramJS/TDLib client    │
│  - Pushes synced messages│        │  - Reads org-wide synced  │
│    to server (one-way)   │        │    data from server       │
│  - Pulls notes/templates │        │  - Sends org activation   │
│    /duplicate flags      │        │    codes, views dup flags │
└───────────┬──────────────┘        └────────────┬──────────────┘
            │ HTTPS/REST (JWT)                     │ HTTPS/REST (JWT)
            ▼                                      ▼
┌─────────────────────────────────────────────────────────────┐
│                     REST API Server (Node.js)                │
│  - Express routes, JWT auth (agent + owner roles)             │
│  - MongoDB (Mongoose models)                                  │
│  - Duplicate-detection engine (contact matching)              │
│  - No outbound Telegram connection of its own                 │
└─────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────┐
│       MongoDB            │
│  orgs, agents, accounts  │
│  (metadata only), chats,  │
│  messages, contacts,      │
│  notes, templates         │
└─────────────────────────┘
```

**Why MTProto lives only in the client:** GramJS (Node/TS MTProto
implementation) or TDLib is embedded in the Tauri client's sidecar process,
not the server. The server's job is purely to be the shared database and
REST contract.

---

## 4. Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Server runtime | Node.js (LTS) + Express | REST only, no WebSocket requirement for v1 |
| Database | MongoDB + Mongoose | Document model fits chat/message shape well |
| Auth | JWT (short-lived access + refresh) | Role claim: `agent` or `owner` |
| Desktop client | Tauri (Rust shell + TypeScript/React frontend) | Small installer, native feel, fast |
| MTProto | GramJS (`telegram` npm package) run inside the client (Node sidecar or WebView-bundled) | Session string encrypted at rest via OS keychain |
| Installer | Tauri bundler → signed `.msi`/NSIS `.exe` | Normal double-click install, Start Menu entry, not "open a folder and run" |

---

## 5. Data Model (MongoDB Collections)

### `organizations`
```js
{
  _id, name, ownerId, createdAt,
  settings: { maxAgentsPerCode: Number }
}
```

### `activationCodes`
```js
{
  _id, orgId, code: String (unique, indexed),
  maxUses: Number, usesCount: Number,
  expiresAt: Date, active: Boolean, createdAt
}
```

### `agents`
```js
{
  _id, orgId, displayName, activationCodeUsed,
  passwordHash /* optional, if agents also set a personal password */,
  role: "agent", createdAt, lastSeenAt
}
```

### `telegramAccounts`  (metadata only — **no session material**)
```js
{
  _id, ownerType: "agent" | "owner", ownerId,
  orgId, telegramUserId, displayName, phoneMasked,
  linkedAt, lastSyncAt, status: "active"|"revoked"
}
```
> The actual MTProto session string lives in the OS keychain on the device
> that created it, keyed by this document's `_id`. The server only ever
> sees this `_id` as a correlation handle.

### `contacts`
```js
{
  _id, orgId, telegramUserId, username, phoneNumber,
  firstSeenByAgentId, linkedAgents: [agentId],
  duplicateFlag: Boolean, createdAt, updatedAt
}
```

### `chats`
```js
{
  _id, orgId, telegramAccountId, contactId, agentId,
  lastMessageAt, lastMessagePreview, unreadCount,
  isPinnedToTop: Boolean
}
```

### `messages`
```js
{
  _id, chatId, orgId, direction: "in"|"out",
  senderType: "contact"|"agent"|"owner", senderId,
  text, mediaRef, telegramMessageId, sentAt, syncedAt
}
```

### `notes`
```js
{ _id, orgId, contactId, authorId, authorType, text, createdAt }
```

### `templates`
```js
{ _id, orgId, title, body, createdBy, createdAt }
```

---

## 6. REST API Contract (v1)

Base path: `/api/v1`. All endpoints except activation/login require
`Authorization: Bearer <JWT>`.

### Auth
- `POST /auth/activation-code/redeem` `{ code, displayName }` → creates/returns
  agent identity + JWT (role: agent)
- `POST /auth/owner/login` `{ email, password }` → JWT (role: owner)
- `POST /auth/refresh`

### Owner — Activation Codes
- `POST /owner/activation-codes` `{ maxUses, expiresAt }` → new code
- `GET /owner/activation-codes` → list + usage stats

### Telegram Account Linking (metadata handshake only)
- `POST /telegram-accounts` `{ telegramUserId, displayName, phoneMasked }`
  — client calls this **after** it has completed the MTProto login locally;
  server just records the metadata row and returns its `_id` for the
  client to tag locally-stored session material with.
- `GET /telegram-accounts/mine`
- `DELETE /telegram-accounts/:id` (revoke/unlink)

### Sync (one-way push from client)
- `POST /sync/messages` `{ telegramAccountId, chatExternalId, contact: {...}, messages: [...] }`
  — idempotent upsert by `telegramMessageId`; triggers duplicate-detection
  pass on the contact.
- `POST /sync/chats/:chatId/read` — mark read, update unread count

### Chats / Inbox
- `GET /chats?scope=mine|all&filter=all|repeated|mine|unread&q=search`
  (`scope=all` requires owner role)
- `GET /chats/:id/messages?before=<ts>&limit=50`

### Contacts & Duplicate Detection
- `GET /contacts/:id` — includes `linkedAgents`, cross-agent history summary
- Internal: on every `sync/messages` call, engine matches new contact against
  existing `contacts` in the same `orgId` by `telegramUserId` OR `username`
  OR `phoneNumber`; if match found and `linkedAgents` gains a second agent,
  set `duplicateFlag = true` and return the match info in the sync response
  so the client can toast "this lead is already being worked by <agent>".

### Notes & Templates
- `GET/POST /contacts/:id/notes`
- `GET/POST /templates`

### Owner Reply (goes out via owner's own linked account — see §2)
- `POST /chats/:id/owner-reply` `{ text }` — server just stores it as an
  outbound message with `senderType: "owner"`; the **client** (Owner Mode)
  is the one that actually calls Telegram to send it, then confirms via
  this endpoint so it's recorded. Server never sends Telegram messages
  itself.

---

## 7. Client Flows

### 7.1 Agent — First Run
1. Launch `RealtyDesk.exe` → Login screen → enter activation code.
2. `POST /auth/activation-code/redeem` → JWT stored locally (keytar/OS
   keychain).
3. Main window loads, empty state: "+ Add Telegram".

### 7.2 `+ Add Telegram` (agent or owner — identical flow)
1. User enters phone number.
2. Client's embedded GramJS instance calls Telegram's `auth.sendCode`.
3. User enters the OTP (and 2FA password if enabled).
4. On success, GramJS returns a session string. Client encrypts it via OS
   keychain (DPAPI on Windows through Tauri's `keyring` crate or similar)
   under a key scoped to `telegramAccountId`.
5. Client calls `POST /telegram-accounts` with only metadata (Telegram user
   id, display name, masked phone). Server returns the `_id`.
6. Client tags the locally-stored session with that `_id` and begins
   syncing chat history via `POST /sync/messages`.

### 7.3 Ongoing Sync
- Client listens to GramJS's update loop; on each new message (in or out),
  batches and pushes to `POST /sync/messages` (debounced, e.g. every 1–2s
  or on each event — implementer's choice, favor low latency).

### 7.4 Inbox UI (both roles)
- Chat list panel: filter tabs `All / Repeated / Mine / Unread`, search box.
- Active chats auto-sort to top on new message (client-side sort by
  `lastMessageAt`, refreshed on sync push/pull).
- Quick-reply template picker, shared notes panel per contact.

### 7.5 Owner Mode Extras
- Org-wide chat list (`scope=all`), agent-ownership tag/avatar on each row.
- Clicking a chat shows full thread incl. agent's messages (read-only
  history) with an input box at the bottom — sends via the Owner's own
  linked Telegram account (§2), tagged `senderType: "owner"` so the agent
  can see the owner stepped in.
- Activation code generator screen.
- Duplicate-lead report view.

---

## 8. Duplicate Detection Engine — Logic Spec

Trigger: every `POST /sync/messages` call, after upserting the contact row.

```
match = contacts.findOne({
  orgId,
  $or: [
    { telegramUserId: incoming.telegramUserId },
    { username: incoming.username },
    { phoneNumber: incoming.phoneNumber }
  ],
  _id: { $ne: incomingContactId }
})

if match exists:
    merge linkedAgents sets
    if linkedAgents.length > 1: set duplicateFlag = true on the contact
    return { duplicate: true, otherAgents: [...], priorHistorySummary }
```

Response is surfaced in the client as a non-blocking toast + a badge in the
`Repeated` filter tab.

---

## 9. Security / Compliance Checklist (re-check before each release)

- [ ] No endpoint accepts or returns a raw MTProto session string or auth key.
- [ ] No server log line contains phone OTPs, 2FA passwords, or session
      material.
- [ ] JWTs are short-lived; refresh tokens are rotated and revocable per
      device.
- [ ] Owner "reply" always resolves to the owner's own `telegramAccountId`,
      never an arbitrary one from the request body without ownership check.
- [ ] Activation codes are rate-limited against brute-force redemption.
- [ ] All contact PII (phone, username) encrypted at rest in MongoDB
      (field-level encryption or disk-level, per deployment environment).

---

## 10. Suggested Build Order

1. Server: project skeleton, Mongoose models, auth (activation + owner
   login), JWT middleware.
2. Server: telegram-accounts metadata endpoints, sync endpoint, duplicate
   engine, chats/messages read endpoints.
3. Server: notes, templates, owner-reply recording endpoint.
4. Client: Tauri project skeleton, login/activation screen, secure local
   session storage module.
5. Client: `+ Add Telegram` flow with GramJS integration.
6. Client: inbox UI — chat list, filters, search, message thread view.
7. Client: Owner Mode views (org-wide inbox, activation code admin,
   duplicate report).
8. Packaging: Tauri bundler config for signed Windows installer.

---

*This document is the source of truth for the project's architecture and
security boundary. Any change to §2 or §6's owner-reply/session-handling
behavior requires updating this file in the same change.*
