# Chat

A messenger with accounts, friends, group chats, saved message history — now backed by a real database so nothing gets wiped when the server sleeps or restarts.

## What changed in this version

- **Fixed data loss**: storage moved from a local JSON file to Postgres. Render's free tier resets its local disk on every sleep/restart, which was wiping accounts and messages — a real database doesn't have that problem.
- **Remove a friend** — hover a friend in the Friends tab, click "Remove"
- **Leave a group** — open a group chat, click "Leave" in the header
- **Profile** — click your name at the top of the sidebar to see your profile and change your password

## One-time setup: get a free Postgres database

Render's own free Postgres expires after a while, so use a provider built for staying free indefinitely. **Neon** (neon.tech) is a good fit — it auto-suspends when idle and wakes instantly on the next request, with no data loss.

1. Go to [neon.tech](https://neon.tech) and sign up (free, no credit card).
2. Create a new project. It gives you a **connection string** that looks like:
   ```
   postgres://username:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require
   ```
3. Copy that whole string — you'll need it in the next step.

## Deploying on Render

Same as before, plus one new environment variable:

- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Environment variable:** add `DATABASE_URL` and paste in the Neon connection string from above.

The server creates its own tables automatically the first time it starts — nothing else to set up.

## Running it locally

1. Install [Node.js](https://nodejs.org) and get a Postgres database (either install Postgres locally, or just use the same free Neon database from setup above — it works fine for local dev too).
2. In this folder:
   ```
   npm install
   ```
3. Set the `DATABASE_URL` environment variable to your connection string, then run:
   ```
   DATABASE_URL="your-connection-string-here" node server.js
   ```
   (On Windows PowerShell: `$env:DATABASE_URL="your-connection-string-here"; node server.js`)
4. Open the printed URL in Chrome.

## How it works

- `server.js` — Express REST API (auth, friends, conversations) + WebSocket server for real-time messages
- `db.js` — Postgres data layer (users, sessions, friendships, conversations, messages)
- `public/` — frontend: `index.html`, `styles.css`, `app.js`

## Notes

- Passwords are hashed, never stored in plain text.
- You can only DM or group-chat with people who've accepted your friend request.
- Leaving a group removes you from it; you'd need to be re-added to rejoin.
- Removing a friend also removes any pending request between you two, but existing DM history stays (you'd just need to re-add them to message again).
