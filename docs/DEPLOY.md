# Deploying RealtyDesk

## Architecture
- **Client**: Tauri desktop app + Vite web build (`client/`).
- **Server**: Node/Express + MongoDB (`server/`), deployable to Vercel as a serverless function.
- **Database**: MongoDB Atlas (required; local Mongo won't run on Vercel).

## Vercel (monorepo)
The root `vercel.json` builds both the server (`server/src/server.js`) and the client (`client/`), routing `/api/*` and `/health` to the server and everything else to the client.

### Environment variables (set in Vercel dashboard)
Server:
- `MONGO_URI` — MongoDB Atlas connection string
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — strong random strings (see `server/.env.example`)
- `CORS_ORIGIN` — your production origin (e.g. `https://realtydesk.vercel.app`)

Client (optional, auto-set by `client/.env.production`):
- `VITE_API_BASE_URL=/api/v1`

### Steps
1. Create a MongoDB Atlas cluster, create a DB user, allow network access from anywhere (or Vercel IPs).
2. Push the repo to GitHub.
3. Import the repo into Vercel; it will read `vercel.json`.
4. Add the env vars above.
5. Deploy. The first cold start connects to Mongo (cached across invocations).

## Desktop (Tauri)
- Set `VITE_API_BASE_URL` to your Vercel URL (e.g. `https://realtydesk.vercel.app/api/v1`) when building the desktop client.
- Run `npm run tauri:build` in `client/`.
- MTProto sessions are stored in the OS keychain; they never leave the device.

## Notes
- No WebSocket: the client polls the server, which works on Vercel's serverless runtime.
- Photo uploads are stored as data URLs (16 MB body cap) — keep photos reasonably sized.
- Rate limits apply to login and activation-code redemption.
