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
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/**
 * Browsers do not send an `Authorization` header on a WebSocket upgrade,
 * so a basic-auth gate alone kills every WS the dashboard opens (chat,
 * event stream, PTY). A cookie is sent on the upgrade automatically,
 * so a successful basic-auth exchange mints one and later requests —
 * upgrades included — authenticate with it instead.
 */
const COOKIE_NAME = "hermes_preview_auth";
const COOKIE_SECRET = randomBytes(32);
const COOKIE_VALUE = createHmac("sha256", COOKIE_SECRET).update(PASS).digest("hex");

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function hasValidCookie(req) {
  const value = readCookie(req, COOKIE_NAME);
  return value !== null && safeEqual(value, COOKIE_VALUE);
}

function hasBasicAuth(req) {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return (
    safeEqual(decoded.slice(0, separator), USER) && safeEqual(decoded.slice(separator + 1), PASS)
  );
}

function authorized(req) {
  return hasBasicAuth(req) || hasValidCookie(req);
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
  // A WebSocket upgrade arrives with a cookie but no Authorization
  // header; challenge it on basic auth alone and the browser cannot
  // answer, so the socket dies silently. Accept the cookie first.
  if (!authorized(req)) return challenge(res);

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) headers[key] = value;

  const upstreamReq = httpRequest(
    {
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 80,
      path: req.url,
      method: req.method,
      headers: { ...headers, host: UPSTREAM.host },
    },
    (upstreamRes) => {
      const outHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase()) && value !== undefined) outHeaders[key] = value;
      }
      // Mint the cookie only on the exchange that carried the password,
      // so a stolen cookie is useless without it and the response that
      // sets it is the one the browser just authenticated.
      if (hasBasicAuth(req)) {
        outHeaders["set-cookie"] = [
          `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
        ];
      }
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
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

/**
 * The backend's HTTP middleware rejects a WS upgrade that carries no
 * `Authorization` header — and a browser cannot set one on an upgrade.
 * The token is the one the backend already inlines into `index.html`,
 * so read it once from upstream and attach it to upgrades here.
 */
const TOKEN_RE = /__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/;
let upstreamToken = null;

async function fetchUpstreamToken() {
  if (upstreamToken) return upstreamToken;
  try {
    const res = await fetch(UPSTREAM.origin, { headers: { accept: "text/html" } });
    const match = TOKEN_RE.exec(await res.text());
    if (match) upstreamToken = match[1];
  } catch {
    /* the dashboard may still be starting; retry on the next upgrade */
  }
  return upstreamToken;
}

/** Headers that must survive a WS upgrade. `Connection` and `Upgrade` are
 *  hop-by-hop in general, but the RFC 6455 handshake requires both, so
 *  dropping them turns every upgrade into a 404. */
const WS_PRESERVED = new Set(["connection", "upgrade"]);

server.on("upgrade", async (req, socket, head) => {
  if (!authorized(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = await fetchUpstreamToken();
  if (!token) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstreamSocket = connect(
    { host: UPSTREAM.hostname, port: Number(UPSTREAM.port || 80) },
    () => {
      const headers = Object.entries({
        ...req.headers,
        authorization: `Bearer ${token}`,
      })
        .filter(([key]) => !HOP_BY_HOP.has(key.toLowerCase()) || WS_PRESERVED.has(key.toLowerCase()))
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
