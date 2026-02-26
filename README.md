# Cuse Pitch

Cuse Pitch is a real-time multiplayer implementation of the classic card game Pitch built as a full-stack web application.

Play live with friends at:
https://cusepitch.com

---

## Features

• Real-time multiplayer rooms  
• Reconnect & seat reclaim system  
• Invite links  
• Mobile responsive table layout  
• Authenticated accounts  
• Leaderboard & stats tracking  
• Accurate Pitch scoring (High / Low / Jack / Game)  
• Tiebreaker hands at target score  
• Chat system  
• Production deployment with SSL

---

## Tech Stack

### Frontend
React  
TypeScript  
Vite  
Socket.IO Client

### Backend
Node.js  
Express  
Socket.IO Server  
PostgreSQL

### Infrastructure
Fly.io hosting  
Let's Encrypt SSL certificates  
GoDaddy domain

---

## Architecture

The server is authoritative.

All game logic executes server-side.  
Clients receive masked state based on seat ownership.

Phases:
SETUP → BIDDING → DEALER_TRUMP → DISCARD → PLAY → SCORE_HAND → GAME_END

This prevents cheating and ensures deterministic scoring across reconnects.

---

## Local Development

Install dependencies:
