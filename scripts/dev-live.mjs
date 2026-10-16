#!/usr/bin/env node
// scripts/dev-live.mjs — one command to drive a live browser engine from a CLI.
//
// The engine has no root `dev` script (each app owns its own `vite` by design).
// This helper spawns the two processes remote-live needs:
//   1. the loopback relay (skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs)
//   2. the chosen app's vite dev server (pnpm --filter <pkg> dev)
//
// The page-side bridge is OPT-IN (createApp dials the relay only when
// VITE_FORGEAX_ENGINE_BRIDGE=1). This launcher injects that flag into the app's
// vite AND starts the relay, so `node scripts/dev-live.mjs <app>` is the single
// command that turns remote-live on — a plain `pnpm --filter <app> dev` (and CI)
// never dials a relay, so it never emits browser WebSocket-failed console noise
// (which would trip zero-console-error smokes). Once both are up, drive the
// running browser with:
//   node skills/forgeax-engine-cli/scripts/remote-live.mjs --health
//   node skills/forgeax-engine-cli/scripts/remote-live.mjs "world.inspect().entityCount"
//
// Usage:
//   node scripts/dev-live.mjs @forgeax/remote-demo
//   FORGEAX_ENGINE_BRIDGE_PORT=6001 node scripts/dev-live.mjs @forgeax/hello-app
//   FORGEAX_ENGINE_BRIDGE=0 node scripts/dev-live.mjs @forgeax/remote-demo   # relay + page bridge off
//
// Ctrl-C tears down both children.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RELAY = resolve(ROOT, 'skills/forgeax-engine-cli/scripts/remote-bridge-server.mjs');

const pkg = process.argv[2];
if (!pkg) {
  console.error('usage: node scripts/dev-live.mjs <pnpm-package-name>');
  console.error('  e.g. node scripts/dev-live.mjs @forgeax/remote-demo');
  process.exit(2);
}

const bridgeOff = process.env.FORGEAX_ENGINE_BRIDGE === '0';
const bridgePort = process.env.FORGEAX_ENGINE_BRIDGE_PORT ?? '5733';

const children = [];

function spawnChild(label, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  child.on('exit', (code, signal) => {
    console.log(`[dev-live] ${label} exited (code=${code} signal=${signal}) — shutting down`);
    shutdown();
  });
  children.push(child);
  return child;
}

// The page bridge turns on only when the app's vite sees VITE_FORGEAX_ENGINE_BRIDGE=1.
// Inject it (+ the port) only when the relay is actually started, so an off run
// leaves the page silent.
const appEnv = bridgeOff
  ? {}
  : { VITE_FORGEAX_ENGINE_BRIDGE: '1', VITE_FORGEAX_ENGINE_BRIDGE_PORT: bridgePort };

if (!bridgeOff) {
  console.log(`[dev-live] starting remote bridge relay on :${bridgePort} ...`);
  spawnChild('relay', 'node', [RELAY], { FORGEAX_ENGINE_BRIDGE_PORT: bridgePort });
} else {
  console.log('[dev-live] FORGEAX_ENGINE_BRIDGE=0 — relay NOT started, page bridge off');
}

console.log(`[dev-live] starting app dev server: pnpm --filter ${pkg} dev ...`);
spawnChild('app', 'pnpm', ['--filter', pkg, 'dev'], appEnv);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Give children a beat to exit, then hard-exit.
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
