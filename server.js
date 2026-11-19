#!/usr/bin/env node
/**
 * Mario Party 3 Web (marioparty3web) — Local Zero-Dependency HTTP & 4P WebSocket Relay
 * ====================================================================================
 * Mirrors the exact protocol of `cloudflare_worker.js` (`MarioParty3RelayHub`)
 * so local development (`npm run dev`) matches Cloudflare Workers + Durable Objects.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

const FRAME_RELAY = 0x01;
const FRAME_ROOM_STATE = 0x02;
const FRAME_UPDATE_ROOM = 0x03;
const FRAME_REJECTED = 0xff;

const MAX_PLAYERS = 4;
const VALID_CORES = new Set(["mupen64plus_next", "parallel_n64"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
};

class MiniWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._emitClose());
    socket.on("error", () => this._emitClose());
  }

  _emitClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        this.close();
        return;
      } else if (opcode === 0x09) {
        this._sendFrame(0x0a, payload);
      } else if (opcode === 0x0a) {
        // Pong
      } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (opcode !== 0x00) {
          this.fragments = [payload];
        } else {
          this.fragments.push(payload);
        }
        if (fin) {
          const full = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.onMessage) {
            this.onMessage(new Uint8Array(full.buffer, full.byteOffset, full.byteLength));
          }
        }
      }
    }
  }

  _sendFrame(opcode, dataBuffer) {
    if (this.closed || !this.socket.writable) return;
    const len = dataBuffer.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, dataBuffer]));
    } catch (_) {
      this._emitClose();
    }
  }

  send(data) {
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    this._sendFrame(0x02, buf);
  }

  close() {
    if (this.closed) return;
    try {
      this._sendFrame(0x08, Buffer.alloc(0));
      this.socket.end();
    } catch (_) {}
    this._emitClose();
  }
}

const rooms = new Map();
const clients = new Map();

function sanitizeRoomCode(raw) {
  const cleaned = String(raw || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, "")
    .slice(0, 16);
  return cleaned || "PARTY1";
}

function sanitizeRoomName(raw, roomId) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || `Party #${roomId}`;
}

function sanitizeCore(raw) {
  const c = String(raw || "").trim().toLowerCase();
  return VALID_CORES.has(c) ? c : "mupen64plus_next";
}

function encodeJsonFrame(frameType, payloadObj) {
  const jsonBytes = Buffer.from(JSON.stringify(payloadObj), "utf-8");
  const out = Buffer.alloc(1 + jsonBytes.length);
  out[0] = frameType;
  jsonBytes.copy(out, 1);
  return out;
}

function encodeReasonFrame(frameType, reason) {
  const textBytes = Buffer.from(String(reason || ""), "utf-8");
  const out = Buffer.alloc(1 + textBytes.length);
  out[0] = frameType;
  textBytes.copy(out, 1);
  return out;
}

function getRoomSummaries() {
  const list = [];
  for (const [roomId, room] of rooms.entries()) {
    if (room.slots.size === 0) {
      rooms.delete(roomId);
      continue;
    }
    const occupied = [...room.slots.keys()].sort((a, b) => a - b);
    list.push({
      id: roomId,
      name: room.name,
      core: room.core,
      playerCount: room.slots.size,
      maxPlayers: MAX_PLAYERS,
      slots: occupied,
      hostSlot: occupied[0] || 1,
      createdAt: room.createdAt,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

function broadcastRoomState(room) {
  const occupied = [...room.slots.keys()].sort((a, b) => a - b);
  const hostSlot = room.slots.has(1) ? 1 : (occupied[0] || 1);
  const base = {
    room: room.id,
    name: room.name,
    core: room.core,
    hostSlot,
    maxPlayers: MAX_PLAYERS,
    playerCount: room.slots.size,
    slots: occupied,
    createdAt: room.createdAt,
  };
  for (const [slot, entry] of room.slots.entries()) {
    entry.ws.send(encodeJsonFrame(FRAME_ROOM_STATE, { ...base, mySlot: slot }));
  }
}

function findFreeSlot(room) {
  for (let s = 1; s <= MAX_PLAYERS; s++) {
    if (!room.slots.has(s)) return s;
  }
  return 0;
}

function cleanupSocket(ws) {
  const info = clients.get(ws);
  if (!info) return;
  clients.delete(ws);

  const room = rooms.get(info.roomId);
  if (!room) return;

  const existing = room.slots.get(info.slot);
  if (existing && existing.ws === ws) {
    room.slots.delete(info.slot);
  }

  if (room.slots.size === 0) {
    rooms.delete(info.roomId);
    return;
  }

  if (info.slot === 1 && !room.slots.has(1)) {
    const nextSlot = [...room.slots.keys()].sort((a, b) => a - b)[0];
    if (nextSlot !== undefined) {
      const promoted = room.slots.get(nextSlot);
      room.slots.delete(nextSlot);
      room.slots.set(1, promoted);
      const promotedMeta = clients.get(promoted.ws);
      if (promotedMeta) promotedMeta.slot = 1;
    }
  }

  broadcastRoomState(room);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/info") {
    const list = getRoomSummaries();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        mode: "local-node-relay",
        maxPlayers: MAX_PLAYERS,
        activeRooms: list.length,
        defaultRoom: "PARTY1",
      })
    );
    return;
  }

  if (url.pathname === "/api/rooms") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ rooms: getRoomSummaries() }));
    return;
  }

  let reqPath = decodeURIComponent(url.pathname);
  if (reqPath === "/") reqPath = "/index.html";
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = /\.part\d+$/.test(filePath)
      ? "application/octet-stream"
      : MIME_TYPES[ext] || "application/octet-stream";
    const cacheCtrl =
      ext === ".bin" || /\.part\d+$/.test(filePath)
        ? "public, max-age=604800, immutable"
        : "no-cache";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": cacheCtrl,
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const ws = new MiniWebSocket(socket);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const roomId = sanitizeRoomCode(url.searchParams.get("room"));
  const requestedName = url.searchParams.get("name");
  const requestedCore = sanitizeCore(url.searchParams.get("core"));
  const createFlag = url.searchParams.get("create") === "1";

  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      name: sanitizeRoomName(requestedName, roomId),
      core: requestedCore,
      createdAt: Date.now(),
      slots: new Map(),
    };
    rooms.set(roomId, room);
  } else if (createFlag && room.slots.size === 0) {
    room.name = sanitizeRoomName(requestedName, roomId);
    room.core = requestedCore;
    room.createdAt = Date.now();
  }

  const assignedSlot = findFreeSlot(room);
  if (assignedSlot === 0) {
    ws.send(encodeReasonFrame(FRAME_REJECTED, `Room ${roomId} is full (4/4 players).`));
    ws.close();
    return;
  }

  if (assignedSlot === 1 && requestedName) {
    room.name = sanitizeRoomName(requestedName, roomId);
  }
  if (assignedSlot === 1 && url.searchParams.get("core")) {
    room.core = requestedCore;
  }

  room.slots.set(assignedSlot, { ws, joinedAt: Date.now() });
  clients.set(ws, { roomId, slot: assignedSlot });

  ws.onMessage = (bytes) => {
    if (!bytes || bytes.length === 0) return;
    const meta = clients.get(ws);
    if (!meta) return;
    const activeRoom = rooms.get(meta.roomId);
    if (!activeRoom) return;

    const frameType = bytes[0];
    if (frameType === FRAME_RELAY && bytes.length >= 2) {
      const targetSlot = bytes[1];
      const payload = bytes.subarray(2);
      const forwarded = new Uint8Array(2 + payload.length);
      forwarded[0] = FRAME_RELAY;
      forwarded[1] = meta.slot;
      forwarded.set(payload, 2);

      if (targetSlot === 0) {
        for (const [slot, entry] of activeRoom.slots.entries()) {
          if (slot !== meta.slot) entry.ws.send(forwarded);
        }
      } else {
        const target = activeRoom.slots.get(targetSlot);
        if (target && targetSlot !== meta.slot) target.ws.send(forwarded);
      }
    } else if (frameType === FRAME_UPDATE_ROOM && meta.slot === 1) {
      try {
        const obj = JSON.parse(Buffer.from(bytes.subarray(1)).toString("utf-8"));
        if (obj.name) activeRoom.name = sanitizeRoomName(obj.name, activeRoom.id);
        if (obj.core) activeRoom.core = sanitizeCore(obj.core);
        broadcastRoomState(activeRoom);
      } catch (_) {}
    }
  };

  ws.onClose = () => cleanupSocket(ws);
  broadcastRoomState(room);
});

server.listen(PORT, () => {
  console.log(`Mario Party 3 Web local server running at http://localhost:${PORT}`);
});
