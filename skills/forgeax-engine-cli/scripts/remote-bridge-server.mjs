#!/usr/bin/env node
// remote-bridge-server.mjs — DEV-only relay between a CLI and a live BROWSER engine.
//
// WHY THIS EXISTS
// ---------------
// @forgeax/engine-remote's only external transport is a Node WebSocket SERVER
// (packages/remote/src/server.ts). A browser page cannot bind a listening socket,
// so that server never starts in a real `pnpm --filter <app> dev` browser — the
// running engine is unreachable ("app.remote not available"). But a browser page
// CAN dial OUT. So createApp mounts a DEV-only bridge that opens a WebSocket
// CLIENT to this relay, and the relay runs @forgeax/engine-remote/execute
// (the ws-free eval core) inside the page realm against the live world/renderer/
// assets/rhiCapture.
//
// This relay is the meeting point both sides CAN reach:
//   • the engine page connects OUT to  ws://127.0.0.1:5733/bridge  (page dials the relay)
//   • the CLI POSTs code to            http://127.0.0.1:5733/eval  (shell dials the relay)
// The relay forwards {id, code} to the page, awaits {id, result}, and answers
// the CLI's still-open HTTP request with that JSON. One in-memory pending-map
// correlates request↔reply by id. No persistence, 127.0.0.1-only, DEV-only. The
// root dev tool declares its direct `ws` dependency; it is not inherited from a
// workspace package's nested node_modules.
//
// This is the engine-side mirror of the editor's gateway-bridge-server.mjs.
//
// SECURITY: this grants "run arbitrary JS in the engine page" to anything that
// can POST to :5733. It is bound to loopback and is only started by the dev
// stack (scripts/dev-live.mjs). Never run it against a production build / public
// interface.

import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.FORGEAX_ENGINE_BRIDGE_PORT ?? 5733);
const HOST = '127.0.0.1';

// The single page socket (last connection wins — one engine window at a time).
let pageSocket = null;
// id -> { res, timer }  correlating a CLI POST with the page's reply.
const pending = new Map();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // Health / status probe — lets the CLI tell "relay down" from "page not connected".
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, pageConnected: !!pageSocket, pending: pending.size });
  }

  // CLI entrypoint: POST { code } → forward to page → reply with { ok, value|error }.
  if (req.method === 'POST' && url.pathname === '/eval') {
    if (!pageSocket || pageSocket.readyState !== pageSocket.OPEN) {
      // Structured, property-access discriminable — not a bare 500.
      return sendJson(res, 200, {
        ok: false,
        error: {
          code: 'PAGE_NOT_CONNECTED',
          hint: 'no engine page attached to the bridge; open/refresh the app dev server (default :5173)',
        },
      });
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      let code;
      try {
        code = JSON.parse(body).code;
      } catch {
        code = undefined;
      }
      if (typeof code !== 'string') {
        return sendJson(res, 200, {
          ok: false,
          error: { code: 'BAD_REQUEST', hint: 'POST body must be JSON {"code": "<js>"}' },
        });
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          sendJson(res, 200, {
            ok: false,
            error: {
              code: 'EVAL_TIMEOUT',
              hint: 'page did not answer within 30s (dead loop, or the tab is backgrounded so rAF is paused — foreground the window)',
            },
          });
        }
      }, 30_000);
      pending.set(id, { res, timer });
      try {
        pageSocket.send(JSON.stringify({ type: 'eval', id, code }));
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        sendJson(res, 200, { ok: false, error: { code: 'SEND_FAILED', hint: String(e?.message ?? e) } });
      }
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', hint: 'endpoints: GET /health, POST /eval' } });
});

// Page side: the engine bridge connects here. It sends back {type:'result', id, payload}.
const wss = new WebSocketServer({ server, path: '/bridge' });
wss.on('connection', (ws) => {
  pageSocket = ws;
  log('engine page connected');
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg?.type !== 'result' || typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return; // already timed out
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    // msg.payload is the {ok, value|error} envelope the page produced.
    sendJson(entry.res, 200, normalizePayload(msg.payload));
  });
  ws.on('close', () => {
    if (pageSocket === ws) pageSocket = null;
    log('engine page disconnected');
  });
  ws.on('error', () => {
    try {
      ws.close();
    } catch {
      /* */
    }
  });
});

server.listen(PORT, HOST, () => {
  log(`relay up on http://${HOST}:${PORT}  (POST /eval, GET /health, page WS /bridge)`);
});

function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}
function normalizePayload(payload) {
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) return payload;
  return { ok: false, error: { code: 'EMPTY_RESULT', hint: 'page returned no payload' } };
}
function log(m) {
  console.log(`[remote-bridge] ${m}`);
}
