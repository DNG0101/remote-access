import http from "node:http";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSignalingServer } from "../../server/signaling.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const signal = createSignalingServer({ port: 4174 });
const agentWss = new WebSocketServer({ port: 4175 });
const agentInputs = [];

agentWss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return; }

    if (packet.type === "hello") {
      ws.send(JSON.stringify({
        type: "hello_ack",
        nativeInput: true,
        clipboard: false,
        files: false,
        monitors: true
      }));
      return;
    }

    if (packet.type === "input") {
      agentInputs.push(packet.message);
    }
  });
});

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const staticServer = http.createServer((req, res) => {
  if (req.url === "/agent-events") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({
      count: agentInputs.length
    }));
    return;
  }

  const rawPath = (req.url || "/").split("?")[0];
  const requestPath = decodeURIComponent(rawPath === "/" ? "/index.html" : rawPath);
  const file = path.resolve(root, "." + requestPath);

  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "content-type": mime[path.extname(file).toLowerCase()] || "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(file).pipe(res);
});

signal.httpServer.listen(4174, "127.0.0.1");
staticServer.listen(4173, "127.0.0.1");

const shutdown = () => {
  agentWss.close();
  staticServer.close();
  signal.httpServer.close();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
