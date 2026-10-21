# COBB CAN MOVE — Multiplayer

A multiplayer remake of the survival-horror game *COBB CAN MOVE*: feed the furnace, keep its light alive, and get out before Cobb gets you. The rules change every level.

## Play

```bash
npm install
npm start
```

Open http://localhost:3000. Friends on the same network can join at `http://<your-LAN-IP>:3000`; use **COPY LINK** in the lobby to share a link with the room code filled in.

| Key | Action |
| --- | --- |
| WASD / arrows | Move |
| Shift | Sprint |
| E / Space | Pick up, feed the furnace, flip breakers, escape; hold to revive |
| F | Shutter your lantern |
| Click / R | Throw a rock |
| M | Facility map |
| N | Sound on/off |

Gamepads work too: left stick, RT or LB to sprint, A interact/revive, B throw, Y lantern, Back map.

## Modes

- **Co-op**: escape together. Downed teammates can be revived for 10 seconds. Seven story levels, then endless.
- **Versus**: one player is Cobb (the role rotates each round). Cobb can't enter the fire's light.
- **Race**: feed 3 coal of your own to open your exit. First out wins; rocks stun rivals.

## Rules by level

Level 1 is a fixed facility. Level 2 adds one of Cobb's senses. Levels 3–6 roll from the pool, with FREEZE or STARVE possible from level 4. Level 7 and endless stack two rules plus a debuff. Co-op teams of two or more can also roll TETHERED, HOT COAL, SHARED HEARTBEAT and COBB CAN MIMIC. Rule details live in [shared/rules.js](shared/rules.js).

## Develop

```bash
npm test
```

Runs the simulation, rules, modes and map-generation checks, then a socket smoke test against a real server.

Set `COBB_START_LEVEL=7` to start new rooms at a later level for playtesting.

## Deploy

Any Node 18+ host that supports WebSockets works (Render, Railway, Fly.io). Use `npm install` to build and `npm start` to run. The server listens on `PORT`, and `/health` returns its status.

## Layout

- `server/`: Socket.IO server, rooms, Cobb's AI (`cobb.js`) and the per-tick round rules (`game.js`)
- `shared/`: constants, rules and the map generator, used by both sides
- `client/`: Phaser 3 scenes, menu and HUD, synthesized audio
- `test/`: plain Node checks, no framework
