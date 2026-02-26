# Security & Technical Design

This document describes how Cuse Pitch protects users and maintains fair gameplay.

---

## Authentication & Password Storage

Passwords are never stored directly.

When a user creates an account:

1. Password is hashed using a one-way cryptographic hashing function
2. Salt is applied
3. Only the hash is stored in PostgreSQL

The server compares hashes during login.

Result:
Even if the database is leaked, original passwords cannot be recovered.

---

## Session Security

Authentication uses session cookies.

• Cookies are HTTP-only
• Client JavaScript cannot access them
• Socket.IO reconnects after login to attach auth session
• Server validates session for all protected actions

Unauthorized sockets cannot:
• Join games
• Access leaderboard
• Submit moves

---

## Server Authoritative Game Engine

All gameplay logic runs server-side.

Clients DO NOT decide:
• legal plays
• trick winners
• scoring
• turn order

Instead the client sends an action:

PLAY_CARD

Server validates legality and updates state.

This prevents cheating, modified clients, or packet tampering.

---

## Card Randomization

Cards are shuffled server-side using a randomized deck generator.

Process:
1. Create ordered deck
2. Apply Fisher-Yates shuffle
3. Deal from shuffled deck

Because shuffle happens only on the server and the client never sees full deck state, players cannot predict or manipulate cards.

---

## Data Protection

Database stores only:
• user id
• username
• password hash
• game statistics

No sensitive personal information is collected.

---

## Network Safety

Real-time communication uses WebSockets via Socket.IO.

Server verifies:
• session
• seat ownership token
• action validity

Invalid actions are ignored.

---

## Fair Play Guarantees

Server authoritative reducer ensures:

• No double plays
• No illegal suit breaking
• No turn skipping
• No scoring manipulation
• Reconnect safe recovery

Game state is deterministic across reconnects.

---

## Deployment Security

Hosted on Fly.io with:
• Automatic TLS certificates
• Encrypted HTTPS
• Isolated runtime instances

All traffic is encrypted in transit.
