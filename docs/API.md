# RealtyDesk Server API

Base URL: `http://localhost:4000/api/v1` (override with `VITE_API_BASE_URL` on the client).
All routes return JSON. Authenticated routes require `Authorization: Bearer <accessToken>`.

Health check: `GET /health` → `{ ok, service }`.

## Auth (`/auth`)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/auth/owner/login` | none | `{ email, password }` | `{ accessToken, refreshToken, owner }` |
| POST | `/auth/agent/login` | none | `{ username, password }` | `{ accessToken, refreshToken, agent }` |
| POST | `/auth/activation-code/redeem` | none | `{ code, displayName }` | `{ accessToken, refreshToken, agent }` |
| POST | `/auth/refresh` | none | `{ refreshToken }` | `{ accessToken }` |
| POST | `/auth/logout` | bearer | — | `{ ok }` (agent: wipes their chats/messages) |

Access tokens expire in ~15 min; refresh tokens are long-lived. A deleted agent's refresh is rejected (`401`).

## Telegram accounts (`/telegram-accounts`)

| Method | Path | Auth | Body/Params | Response |
|---|---|---|---|---|
| POST | `/telegram-accounts` | bearer | `{ telegramUserId, displayName?, username?, phoneMasked? }` | `{ telegramAccount }` |
| GET | `/telegram-accounts/mine` | bearer | — | `{ telegramAccounts }` |
| GET | `/telegram-accounts/org-accounts` | bearer | — | `{ telegramAccounts }` (owner sees all) |
| DELETE | `/telegram-accounts/:id` | bearer (owner or owner of account) | — | `{ ok }` (revokes + deletes its chats/messages) |

## Sync (`/sync`)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/sync/messages` | bearer | `{ telegramAccountId, chatExternalId, contact, isArchived?, messages[] }` | `{ chatId, contactId, duplicate, otherAgents }` |
| POST | `/sync/batch-messages` | bearer | `{ telegramAccountId, items: [{ chatExternalId, contact, isArchived?, messages[] }] }` | `{ ok, chatsSynced }` |
| POST | `/sync/chats/:chatId/read` | bearer | — | `{ ok }` |

Messages are upserted by `(chatId, telegramMessageId)`. Only metadata is stored; MTProto session strings never reach the server.

## Chats (`/chats`)

| Method | Path | Auth | Query/Body | Response |
|---|---|---|---|---|
| GET | `/chats` | bearer | `scope`, `filter`, `q`, `includeArchived` | `{ chats }` |
| GET | `/chats/repeated-ids` | bearer | — | `{ repeatedChatIds, collisionMap }` |
| GET | `/chats/:id` | bearer | — | `{ chat }` |
| GET | `/chats/:id/messages` | bearer | `before` (timestamp ms), `limit` (≤300) | `{ messages }` |
| PATCH | `/chats/:id/archive` | bearer | `{ isArchived }` | `{ ok, isArchived, chat }` |
| PATCH | `/chats/:id/block` | bearer | `{ isBlocked }` | `{ ok, isBlocked, chat }` |
| POST | `/chats/:id/owner-reply` | bearer (owner) | `{ text, telegramMessageId, mediaRef? }` | `{ message }` |

## Contacts (`/contacts`)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/contacts/:id` | bearer | — | `{ contact }` |
| GET | `/contacts/:id/notes` | bearer | — | `{ notes }` |
| POST | `/contacts/:id/notes` | bearer | `{ text }` | `{ note }` |

## Templates (`/templates`)

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/templates` | bearer | — | `{ templates }` |
| POST | `/templates` | bearer | `{ title, body }` | `{ template }` |

## Owner admin (`/owner`) — owner role only

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| GET | `/owner/agents` | owner | — | `{ agents }` |
| POST | `/owner/agents` | owner | `{ username, password, displayName }` | `{ agent }` |
| DELETE | `/owner/agents/:id` | owner | — | `{ ok, message }` (cascades) |
| PATCH | `/owner/agents/:id/password` | owner | `{ newPassword }` | `{ ok, message }` |
| POST | `/owner/activation-codes` | owner | `{ maxUses, expiresAt? }` | `{ activationCode }` |
| GET | `/owner/activation-codes` | owner | — | `{ activationCodes }` |

## Notes
- Org isolation: every query is scoped by `orgId` from the JWT.
- Agent vs owner: agents see only their own chats; owners see all org chats.
- Real-time: no WebSocket; clients poll `/chats`, `/telegram-accounts/mine`, `/chats/repeated-ids`.
- Rate limits: login and activation-code redemption are rate-limited (10 req / 15 min).
- Body size limit: 16 MB (to accommodate photo data URLs).
- Set `CORS_ORIGIN` (or `CLIENT_ORIGIN`) in production to restrict origins.
