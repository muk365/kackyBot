# KackyAlarm

Two-sided web application that tracks **kacky.gg** live servers ("Now on servers") and sends **1-minute Twitch chat alarms** to the logged-in Twitch user's channel when selected maps are about to start.

## Features

1. **Side 1 — Now on Servers (`https://api.kacky.gg/v1/servers/live`)**
   - Polls all 10 live Kacky servers every 15 seconds.
   - Displays current map, next map, player count, and a live 1-second countdown timer.
   - Highlights servers whose next map has an alarm armed or is within the trigger window (`<= 60s`).

2. **Side 2 — All Maps & Alarm Selector (`https://api.kacky.gg/v1/events/active` & `/v1/events/{id}/maps`)**
   - Loads all maps for the active Kacky event (`Kacky Reloaded 7`).
   - Search by map number, author, or WR holder; filter by All / Armed / Not Armed / On Servers.
   - Per-user alarm toggle switches + bulk Arm/Clear actions persisted in SQLite (`data/kackyalarm.sqlite`).

3. **Twitch Chat Alarm Delivery (No WizeBot Required)**
   - Users log in with **Twitch OAuth2** (`user:write:chat` scope).
   - A 1-second background alarm engine checks `mapEndsAt - now <= 60s` for each user's armed maps and posts the alarm message directly to that user's Twitch channel chat via Twitch Helix `POST /helix/chat/messages` (with automatic OAuth token refresh and per-cycle deduplication).
   - **Optional WizeBot support**: If you also want WizeBot to receive alarms, enable WizeBot in **Settings** and enter your WizeBot API key (`https://wapi.wizebot.tv/api/custom-events/{API_KEY}/send`).

## Setup & Running

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure Twitch OAuth in `.env` (for Twitch Login & chat posting):
   - Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and click **Register Your Application**.
   - Set **OAuth Redirect URLs** to `http://localhost:3000/auth/twitch/callback`.
   - Copy **Client ID** and **Client Secret** into `.env`:
     ```env
     TWITCH_CLIENT_ID=your_client_id
     TWITCH_CLIENT_SECRET=your_client_secret
     TWITCH_REDIRECT_URI=http://localhost:3000/auth/twitch/callback
     ```

3. Start the server:
   ```bash
   npm start
   ```
   Open [http://localhost:3000](http://localhost:3000).

## Tests

```bash
npm test
```

## Hosting on Free Servers

This app includes a `Dockerfile` (`node:22-alpine`), `render.yaml`, `trust proxy` + HTTPS cookie handling, `0.0.0.0` binding, and a `GET /health` endpoint so it runs smoothly on free container/Node hosts such as **Render**, **Koyeb**, **Fly.io**, or **Oracle Cloud Free Tier**:

1. Set environment variables on your host:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - `BASE_URL` (e.g. `https://your-app.onrender.com`; Render also sets `RENDER_EXTERNAL_URL` automatically)
   - `TWITCH_REDIRECT_URI` (e.g. `https://your-app.onrender.com/auth/twitch/callback` — add this exact URL in your Twitch Developer Console)
2. **Important for free tiers**:
   - Hosts like **Render Free** sleep after ~15 minutes of no incoming HTTP requests. If you want the background alarm poller to stay awake while you aren't viewing the page, point a free uptime pinger (e.g., UptimeRobot) at `https://your-app/health` every 5–10 minutes.
   - Free tiers without a persistent volume reset `./data/kackyalarm.sqlite` on redeploy/restart. Mount a persistent disk/volume at `/app/data` (or set `DB_PATH`) if available.

