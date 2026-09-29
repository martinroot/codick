#!/usr/bin/env node
/**
 * Basic-auth gate + reverse proxy for the local dashboard.
 *
 * `hermes dashboard` refuses to bind a non-loopback address unless an
 * auth provider is configured — there is deliberately no unauthenticated
 * public mode. This sits in front of the loopback backend so the
 * dashboard can be reviewed from another machine without registering an
 * auth provider or editing system nginx (which needs root).
 *
 * It is a review aid, not a deployment: the credentials come from the
 * environment, the listener is plain HTTP, and the WebSocket paths are
 * proxied so the terminal/chat surfaces actually work.
 *
 *   DASHBOARD_PROXY_PASSWORD=... node scripts/auth-proxy.mjs \
 *     --port 8090 --upstream http://127.0.0.1:8210
 */

import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const PORT = Number(arg("port", 8090));
const UPSTREAM = new URL(arg("upstream", "http://127.0.0.1:8210"));
const USER = process.env.DASHBOARD_PROXY_USER || "preview";
const PASS = process.env.DASHBOARD_PROXY_PASSWORD || "";

if (!PASS) {
  console.error("[proxy] set DASHBOARD_PROXY_PASSWORD — refusing to serve unauthenticated");
  process.exit(1);
}

/** Constant-time compare so a wrong password cannot be brute-forced by timing. */
function safeEqual(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return (
    safeEqual(decoded.slice(0, separator), USER) && safeEqual(decoded.slice(separator + 1), PASS)
  );
}

function challenge(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Hermes dashboard preview", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required\n");
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const server = createServer((req, res) => {
  if (!authorized(req)) return challenge(res);

  const upstreamReq = httpRequest(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: UPSTREAM.host },
    },
    (upstreamRes) => {
      const headers = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) headers[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${error.message}\n`);
  });

  req.pipe(upstreamReq);
});

/* ------------------------------------------------------------------ */
/* WebSocket upgrade — the dashboard's chat, event stream and PTY all  */
/* need this, and a plain HTTP proxy silently breaks them.             */
/* ------------------------------------------------------------------ */

server.on("upgrade", (req, socket, head) => {
  if (!authorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstreamSocket = connect(
    { host: UPSTREAM.hostname, port: Number(UPSTREAM.port || 80) },
    () => {
      const headers = Object.entries(req.headers)
        .filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase()) || key.toLowerCase() === "upgrade")
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
      upstreamSocket.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    },
  );

  upstreamSocket.on("error", () => socket.destroy());
  socket.on("error", () => upstreamSocket.destroy());
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] http://0.0.0.0:${PORT}/ -> ${UPSTREAM.origin} (basic auth as "${USER}")`);
});
