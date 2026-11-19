/**
 * Mario Party 3 Web (marioparty3web) — Cloudflare Worker + Durable Object Hub
 * ===========================================================================
 * Serves static assets (`./public`) and runs a global 1–4 Player Room Browser,
 * WebRTC SDP/ICE signaling hub, and CGNAT-proof per-peer WebSocket binary relay
 * inside a single SQLite-backed Durable Object (`MarioParty3RelayHub`).
 *
 * 100% Cloudflare Workers Free Plan compatible (`new_sqlite_classes`, no credit card).
 *
 * Binary Wire Protocol:
 *   Client -> Server:
 *     0x01 [targetSlot:u8 (0=broadcast, 1..4=slot)] [...payload]
 *     0x03 [...utf8 JSON]  (Host updates room metadata, e.g. { name })
 *   Server -> Client:
 *     0x01 [senderSlot:u8 (1..4)] [...payload]
 *     0x02 [...utf8 JSON]  Room state snapshot { room, name, mySlot, hostSlot, slots, maxPlayers, core }
 *     0xFF [...utf8 text]  Rejection reason (room full, invalid, etc.)
 */

const FRAME_RELAY = 0x01;
const FRAME_ROOM_STATE = 0x02;
const FRAME_UPDATE_ROOM = 0x03;
const FRAME_REJECTED = 0xff;

const MAX_PLAYERS = 4;
const VALID_CORES = new Set(["mupen64plus_next", "parallel_n64"]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

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
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const out = new Uint8Array(1 + jsonBytes.length);
  out[0] = frameType;
  out.set(jsonBytes, 1);
  return out;
}

function encodeReasonFrame(frameType, reason) {
  const textBytes = new TextEncoder().encode(String(reason || ""));
  const out = new Uint8Array(1 + textBytes.length);
  out[0] = frameType;
  out.set(textBytes, 1);
  return out;
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (
      upgradeHeader.toLowerCase() === "websocket" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/ws"
    ) {
      const id = env.RELAY_HUB.idFromName("global-mp3-hub");
      const stub = env.RELAY_HUB.get(id);
      return stub.fetch(request);
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (url.pathname.endsWith(".bin") || /\.part\d+$/.test(url.pathname)) {
        const headers = new Headers(res.headers);
        headers.set("Content-Type", "application/octet-stream");
        headers.set("Cache-Control", "public, max-age=604800, immutable");
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }

    return new Response("Mario Party 3 Web Relay Worker is online.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
    });
  },
};

export class MarioParty3RelayHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /**
     * Map<string, {
     *   id: string,
     *   name: string,
     *   core: string,
     *   createdAt: number,
     *   slots: Map<number, { ws: WebSocket, joinedAt: number }>
     * }>
     */
    this.rooms = new Map();
    /** Map<WebSocket, { roomId: string, slot: number }> */
    this.clients = new Map();
  }

  getRoomSummaries() {
    const list = [];
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.slots.size === 0) {
        this.rooms.delete(roomId);
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

  safeSend(ws, data) {
    try {
      ws.send(data);
    } catch (_) {}
  }

  broadcastRoomState(room) {
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
      this.safeSend(entry.ws, encodeJsonFrame(FRAME_ROOM_STATE, { ...base, mySlot: slot }));
    }
  }

  findFreeSlot(room) {
    for (let s = 1; s <= MAX_PLAYERS; s++) {
      if (!room.slots.has(s)) return s;
    }
    return 0;
  }

  cleanupSocket(ws) {
    const info = this.clients.get(ws);
    if (!info) return;
    this.clients.delete(ws);

    const room = this.rooms.get(info.roomId);
    if (!room) return;

    const existing = room.slots.get(info.slot);
    if (existing && existing.ws === ws) {
      room.slots.delete(info.slot);
    }

    if (room.slots.size === 0) {
      this.rooms.delete(info.roomId);
      return;
    }

    // If Slot 1 (Host) left, promote lowest-slot guest to Slot 1 so Star Topology stays clean
    if (info.slot === 1 && !room.slots.has(1)) {
      const nextSlot = [...room.slots.keys()].sort((a, b) => a - b)[0];
      if (nextSlot !== undefined) {
        const promoted = room.slots.get(nextSlot);
        room.slots.delete(nextSlot);
        room.slots.set(1, promoted);
        const promotedMeta = this.clients.get(promoted.ws);
        if (promotedMeta) promotedMeta.slot = 1;
      }
    }

    this.broadcastRoomState(room);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/info") {
      const rooms = this.getRoomSummaries();
      return new Response(
        JSON.stringify({
          mode: "cloudflare-durable-object",
          maxPlayers: MAX_PLAYERS,
          activeRooms: rooms.length,
          defaultRoom: "PARTY1",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
        }
      );
    }

    if (url.pathname === "/api/rooms") {
      return new Response(JSON.stringify({ rooms: this.getRoomSummaries() }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...CORS_HEADERS,
        },
      });
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426, headers: CORS_HEADERS });
    }

    const roomId = sanitizeRoomCode(url.searchParams.get("room"));
    const requestedName = url.searchParams.get("name");
    const requestedCore = sanitizeCore(url.searchParams.get("core"));
    const createFlag = url.searchParams.get("create") === "1";

    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        name: sanitizeRoomName(requestedName, roomId),
        core: requestedCore,
        createdAt: Date.now(),
        slots: new Map(),
      };
      this.rooms.set(roomId, room);
    } else if (createFlag && room.slots.size === 0) {
      room.name = sanitizeRoomName(requestedName, roomId);
      room.core = requestedCore;
      room.createdAt = Date.now();
    }

    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);
    serverWs.accept();

    const assignedSlot = this.findFreeSlot(room);
    if (assignedSlot === 0) {
      this.safeSend(serverWs, encodeReasonFrame(FRAME_REJECTED, `Room ${roomId} is full (4/4 players).`));
      try {
        serverWs.close(1008, "Room full");
      } catch (_) {}
      return new Response(null, { status: 101, webSocket: clientWs });
    }

    if (assignedSlot === 1 && requestedName) {
      room.name = sanitizeRoomName(requestedName, roomId);
    }
    if (assignedSlot === 1 && url.searchParams.get("core")) {
      room.core = requestedCore;
    }

    room.slots.set(assignedSlot, { ws: serverWs, joinedAt: Date.now() });
    this.clients.set(serverWs, { roomId, slot: assignedSlot });

    serverWs.addEventListener("message", (event) => {
      const bytes = toUint8Array(event.data);
      if (!bytes || bytes.length === 0) return;

      const meta = this.clients.get(serverWs);
      if (!meta) return;
      const activeRoom = this.rooms.get(meta.roomId);
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
            if (slot !== meta.slot) {
              this.safeSend(entry.ws, forwarded);
            }
          }
        } else {
          const target = activeRoom.slots.get(targetSlot);
          if (target && targetSlot !== meta.slot) {
            this.safeSend(target.ws, forwarded);
          }
        }
      } else if (frameType === FRAME_UPDATE_ROOM && meta.slot === 1) {
        try {
          const obj = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
          if (obj.name) activeRoom.name = sanitizeRoomName(obj.name, activeRoom.id);
          if (obj.core) activeRoom.core = sanitizeCore(obj.core);
          this.broadcastRoomState(activeRoom);
        } catch (_) {}
      }
    });

    serverWs.addEventListener("close", () => this.cleanupSocket(serverWs));
    serverWs.addEventListener("error", () => this.cleanupSocket(serverWs));

    this.broadcastRoomState(room);
    return new Response(null, { status: 101, webSocket: clientWs });
  }
}
