// Room + signaling logic, kept separate from the network layer so it can be tested without sockets.
//
// A "connection" is any object with a send(obj) method. server.js wraps a ws WebSocket in one.
//
// Protocol (client → server):
//   {type:'join', room, name, capacity}   capacity only matters for the FIRST person in a room:
//                                         2 = 1:1 call, N>=2 = group of at most N, 0 = no limit (server hard cap)
//   {type:'set-capacity', capacity}       host only
//   {type:'offer'|'answer'|'candidate', to, ...}   relayed to the peer with id `to`
// Server → client:
//   joined {id, room, capacity, host, max, peers:[{id,name}]}
//   room-info {room, capacity, count, host, max}
//   peer-joined {id, name}      peer-left {id, host}
//   offer/answer/candidate {from, ...}      error {code, message}

const RELAYED = new Set(['offer', 'answer', 'candidate']);

export class Hub {
  constructor({ maxRoomSize = 50, log = () => {} } = {}) {
    this.maxRoomSize = maxRoomSize;
    this.log = log;
    this.rooms = new Map(); // name -> { name, capacity, host, members: Map(id -> conn) }
    this.nextId = 1;
  }

  connect(conn) {
    conn.id = `peer-${this.nextId++}`;
    conn.name = conn.id;
    conn.room = null;
    return conn;
  }

  // 0 = unlimited. Anything invalid or 1 becomes 2 (a call needs two people).
  normalizeCapacity(c) {
    const n = Math.floor(Number(c));
    if (!Number.isFinite(n) || n < 0) return 2;
    if (n === 0) return 0;
    return Math.min(Math.max(n, 2), this.maxRoomSize);
  }

  message(conn, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'join') return this.#join(conn, msg);
    if (!conn.room) return;
    const room = this.rooms.get(conn.room);
    if (!room) return;

    if (msg.type === 'set-capacity') {
      if (room.host !== conn.id) return conn.send({ type: 'error', code: 'not-host', message: 'Only the host can change the room size.' });
      const cap = this.normalizeCapacity(msg.capacity);
      if (cap !== 0 && cap < room.members.size) {
        return conn.send({ type: 'error', code: 'too-small', message: `${room.members.size} people are already in the room, so the limit can't be lower than that.` });
      }
      room.capacity = cap;
      this.log(`room "${room.name}" capacity -> ${cap || 'unlimited'}`);
      return this.#broadcastInfo(room);
    }

    if (RELAYED.has(msg.type)) {
      const target = room.members.get(msg.to);
      if (!target) return;
      if (msg.type === 'candidate' && msg.candidate) this.log(`relay candidate ${conn.id} -> ${msg.to}: ${msg.candidate.candidate}`);
      else this.log(`relay ${msg.type} ${conn.id} -> ${msg.to}`);
      target.send({ ...msg, from: conn.id });
    }
  }

  disconnect(conn) {
    if (!conn.room) return;
    const room = this.rooms.get(conn.room);
    conn.room = null;
    if (!room) return;
    room.members.delete(conn.id);
    this.log(`${conn.id} left "${room.name}" (${room.members.size} remain)`);
    if (room.members.size === 0) { this.rooms.delete(room.name); return; }
    if (room.host === conn.id) room.host = room.members.keys().next().value; // oldest member becomes host
    for (const c of room.members.values()) c.send({ type: 'peer-left', id: conn.id, host: room.host });
    this.#broadcastInfo(room);
  }

  #join(conn, msg) {
    if (conn.room) return conn.send({ type: 'error', code: 'already-joined', message: 'You are already in a room.' });
    const name = String(msg.room ?? '').trim().slice(0, 64);
    if (!name) return conn.send({ type: 'error', code: 'bad-room', message: 'Room name required.' });

    let room = this.rooms.get(name);
    if (!room) {
      room = { name, capacity: this.normalizeCapacity(msg.capacity), host: conn.id, members: new Map() };
      this.rooms.set(name, room);
      this.log(`room "${name}" created by ${conn.id}, capacity ${room.capacity || 'unlimited'}`);
    }
    const limit = room.capacity || this.maxRoomSize;
    if (room.members.size >= limit) {
      if (room.members.size === 0) this.rooms.delete(name);
      return conn.send({
        type: 'error', code: 'room-full',
        message: room.capacity ? `Room "${name}" is full (${room.members.size}/${room.capacity}).` : `Room "${name}" reached the server limit of ${this.maxRoomSize} people.`,
      });
    }

    conn.name = String(msg.name ?? '').trim().slice(0, 32) || conn.id;
    const existing = [...room.members.values()].map((c) => ({ id: c.id, name: c.name }));
    room.members.set(conn.id, conn);
    conn.room = name;
    this.log(`${conn.id} ("${conn.name}") joined "${name}" (${room.members.size}/${room.capacity || '∞'})`);
    conn.send({ type: 'joined', id: conn.id, room: name, capacity: room.capacity, host: room.host, max: this.maxRoomSize, peers: existing });
    // Everyone who was already here will send the newcomer an offer.
    for (const c of room.members.values()) if (c !== conn) c.send({ type: 'peer-joined', id: conn.id, name: conn.name });
    this.#broadcastInfo(room);
  }

  #broadcastInfo(room) {
    const info = { type: 'room-info', room: room.name, capacity: room.capacity, count: room.members.size, host: room.host, max: this.maxRoomSize };
    for (const c of room.members.values()) c.send(info);
  }
}
