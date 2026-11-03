# WebRTC Inspector

Node signaling server + built-in STUN server + a demo page that shows what WebRTC is doing under the hood.

## Run

```bash
npm install
npm start            # http://localhost:3000 (signaling on /ws, STUN on udp/3478)
```

Open the page in two or more tabs (or devices), open the **Room** menu, use the same room name and click **Join / create room**.

- **1:1 call**: room of exactly 2 people.
- **Group call**: the person who creates the room picks the maximum number of people (`0` = no limit, capped by `MAX_ROOM_SIZE`, default 50). Later joiners get the room's existing limit. The host can change it from the Room menu.

Group calls are a *full mesh*: every person has a direct connection to every other person, so each person uploads their video once per other person. That is fine for roughly 2–5 people. For big rooms you would need an SFU (media server).

The only dependency is `ws` (WebSocket). HTTP is plain `node:http`, STUN is plain `node:dgram`.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP + WebSocket port |
| `STUN_PORT` | 3478 | UDP port for the built-in STUN server |
| `MAX_ROOM_SIZE` | 50 | Hard cap for "no limit" rooms |
| `STUN` | on | `STUN=off` disables the built-in STUN server |
| `TURN_URL` / `TURN_USER` / `TURN_PASS` | – | Advertise an external TURN server (e.g. coturn) to clients |
| `SSL_KEY` / `SSL_CERT` | – | Serve HTTPS/WSS (camera + mic need HTTPS on anything but localhost) |

Self-signed cert for testing on a LAN:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=localhost"
SSL_KEY=key.pem SSL_CERT=cert.pem npm start
```

## STUN vs TURN

- **STUN**: a client asks "what public IP:port do you see me at?". That becomes a *srflx* candidate. Cheap, stateless, no media goes through it. Implemented in `server.js`.
- **TURN**: a relay. When no direct path works (symmetric NAT, strict firewalls), both peers send media to the TURN server, which forwards it. Gives *relay* candidates. Costs bandwidth, needs auth. Use [coturn](https://github.com/coturn/coturn) and pass it in with `TURN_URL`/`TURN_USER`/`TURN_PASS`.

Tip: tick **relay only** in the UI to force TURN and confirm that it works.

## Files

- `server.js` – static files, WebSocket glue, STUN, `/api/ice-config`
- `signaling.js` – room logic (capacity, host, relaying offers/answers/candidates); must sit next to `server.js`
- `public/index.html`, `public/app.js` – the demo/inspector page
