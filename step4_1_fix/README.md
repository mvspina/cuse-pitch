# Cuse Pitch v10.2

This version adds:
- Production ready build: one server that serves the built client
- Deploy configs for Render, Railway, Fly.io
- Gameplay polish: smoother cards, trick winner highlight, sounds, dealer chip
- Game logic UX: highlight playable cards and disable illegal plays
- Trick history panel (review completed tricks)
- Per-player stats (hands played, tricks won, STM attempts)

## Requirements
- Node.js 18+ (Node 20 LTS recommended)

## Local dev (LAN phones)
```powershell
npm install
npm run install:all
npm run dev
```

Open:
- PC: http://localhost:5173
- Phone: use the **Network** URL printed by Vite (same WiFi)

## Production build (single server)
```powershell
npm install
npm run install:all
npm run build
npm run start
```

Open:
http://localhost:3001

## Deploy
### Render
- Push this repo to GitHub
- Create a new Web Service on Render
- It will detect `render.yaml` automatically
- Set NODE_ENV=production

### Railway
- Push to GitHub and deploy
- Railway will run `npm run start` using `railway.json`

### Fly.io
- Install flyctl and run:
```bash
fly launch
fly deploy
```

## Notes
- In production, the client connects to the same host at port 3001 automatically.
- For real internet play, you will deploy the server and share the URL.


## Production note
This version fixes Windows production start by compiling the server to CommonJS.


Fix: distPath scope for production SPA catch-all.


Fix: serve built client whenever client/dist exists (no reliance on NODE_ENV), and start sets NODE_ENV=production.
