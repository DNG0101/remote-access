import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8787);
const ROOM_TTL_MS = Math.max(60_000, Number(process.env.ROOM_TTL_MS || 30 * 60_000));
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_CONNECTIONS_PER_IP = Math.max(2, Number(process.env.MAX_CONNECTIONS_PER_IP || 20));
const MAX_JOINS_PER_IP = Math.max(2, Number(process.env.MAX_JOINS_PER_IP || 20));
const WINDOW_MS = 60_000;

const rooms = new Map();
const ips = new Map();

function now() { return Date.now(); }

function getIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function validRoomId(roomId) {
  return typeof roomId === "string" && /^[0-9]{6}$/.test(roomId);
}

function validPeerId(peerId) {
  return typeof peerId === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(peerId);
}

function withinRateLimit(ip, kind) {
  const current = ips.get(ip) || {
    windowStart: now(),
    joins: 0,
    sockets: 0
  };

  if (now() - current.windowStart > WINDOW_MS) {
    current.windowStart = now();
    current.joins = 0;
  }

  if (kind === "join") current.joins++;
  ips.set(ip, current);

  return kind === "join"
    ? current.joins <= MAX_JOINS_PER_IP
    : current.sockets <= MAX_CONNECTIONS_PER_IP;
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (now() - room.createdAt > ROOM_TTL_MS) {
    for (const peer of room.peers.values()) {
      send(peer.ws, {
        kind: "error",
        codeName: "SESSION_EXPIRED",
        message: "Session expired."
      });
      try { peer.ws.close(4001, "Session expired"); } catch {}
    }
    rooms.delete(roomId);
  }
}

function broadcastLeave(roomId, peerId) {
  const room = rooms.get(roomId);
  if (!room) return;

  for (const other of room.peers.values()) {
    send(other.ws, {
      roomId,
      from: peerId,
      to: other.id,
      kind: "leave",
      sentAt: now()
    });
  }
}

export function createSignalingServer({ port = PORT } = {}) {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({
        ok: true,
        rooms: rooms.size
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false
  });

  wss.on("connection", (ws, req) => {
    const ip = getIp(req);
    const ipState = ips.get(ip) || {
      windowStart: now(),
      joins: 0,
      sockets: 0
    };

    ipState.sockets++;
    ips.set(ip, ipState);

    if (!withinRateLimit(ip, "socket")) {
      ws.close(4008, "Too many connections from this IP");
      return;
    }

    let peer = null;

    ws.on("message", (raw) => {
      if (raw.length > MAX_MESSAGE_BYTES) {
        ws.close(4009, "Message too large");
        return;
      }

      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, {
          kind: "error",
          codeName: "INVALID_JSON",
          message: "Invalid JSON."
        });
        return;
      }

      if (!message || typeof message !== "object") return;

      const roomId = message.roomId;
      const from = message.from;

      if (!validRoomId(roomId) || !validPeerId(from)) {
        send(ws, {
          kind: "error",
          codeName: "INVALID_ENVELOPE",
          message: "roomId and from are required."
        });
        return;
      }

      cleanupRoom(roomId);

      if (message.announce === true) {
        if (!withinRateLimit(ip, "join")) {
          send(ws, {
            kind: "error",
            codeName: "RATE_LIMITED",
            message: "Too many session attempts. Try again later."
          });
          return;
        }

        let room = rooms.get(roomId);
        if (!room) {
          room = {
            createdAt: now(),
            peers: new Map()
          };
          rooms.set(roomId, room);
        }

        if (room.peers.size >= 2 && !room.peers.has(from)) {
          send(ws, {
            kind: "error",
            codeName: "SESSION_BUSY",
            message: "This session already has two peers."
          });
          return;
        }

        const existing = room.peers.get(from);
        if (existing && existing.ws !== ws) {
          try { existing.ws.close(4002, "Session replaced"); } catch {}
        }

        peer = {
          id: from,
          role: message.role === "host" ? "host" : "controller",
          roomId,
          ws,
          joinedAt: now()
        };

        room.peers.set(from, peer);

        for (const other of room.peers.values()) {
          if (other.id === from) continue;

          send(other.ws, {
            roomId,
            from,
            role: peer.role,
            announce: true,
            sentAt: now()
          });

          send(ws, {
            roomId,
            from: other.id,
            role: other.role,
            announce: true,
            sentAt: now()
          });
        }
        return;
      }

      if (!peer ||
          peer.roomId !== roomId ||
          peer.id !== from) {
        send(ws, {
          kind: "error",
          codeName: "NOT_JOINED",
          message: "Join the session before sending signaling messages."
        });
        return;
      }

      const room = rooms.get(roomId);
      if (!room) return;

      if (message.to) {
        const target = room.peers.get(message.to);
        if (!target) {
          send(ws, {
            kind: "error",
            codeName: "PEER_NOT_FOUND",
            message: "The other peer is no longer connected."
          });
          return;
        }
        send(target.ws, message);
      } else {
        for (const other of room.peers.values()) {
          if (other.id !== peer.id) send(other.ws, message);
        }
      }
    });

    ws.on("close", () => {
      if (peer) {
        const room = rooms.get(peer.roomId);
        if (room?.peers.get(peer.id)?.ws === ws) {
          room.peers.delete(peer.id);
          broadcastLeave(peer.roomId, peer.id);
          if (!room.peers.size) rooms.delete(peer.roomId);
        }
      }

      const current = ips.get(ip);
      if (current) {
        current.sockets = Math.max(0, current.sockets - 1);
        ips.set(ip, current);
      }
    });

    ws.on("error", () => {});
  });

  const interval = setInterval(() => {
    for (const roomId of rooms.keys()) cleanupRoom(roomId);
    for (const [ip, state] of ips) {
      if (state.sockets === 0 && now() - state.windowStart > WINDOW_MS) {
        ips.delete(ip);
      }
    }
  }, 30_000);

  httpServer.on("close", () => clearInterval(interval));

  return { httpServer, wss, rooms };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const server = createSignalingServer({ port: PORT });
  server.httpServer.listen(PORT, () => {
    console.log("P2P Desk signaling server listening on " + PORT);
  });
}
