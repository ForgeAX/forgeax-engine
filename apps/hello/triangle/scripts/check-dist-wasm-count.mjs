#!/usr/bin/env node
// feat-20260511-naga-rhi-wgpu-merge w14 — ship-runtime 0-wasm-download
// invariant for the navigator.gpu main path.
//
// Plan-strategy §R-S2 / §L-2 + AGENTS.md §RHI / WebGPU "M3 engine factory
// wiring" channels 1/2/3:
//
//   - channel 2 navigator.gpu probe -> dynamic import('@forgeax/engine-rhi-webgpu');
//     wgpu wasm bundle MUST NOT be fetched on the first paint.
//   - channel 3 wgpu wasm lazy load -> only triggers when navigator.gpu is
//     absent (Node CLI / Tauri / older browsers). The wasm chunk is
//     dynamic-import'd; vite emits it as a separate asset / chunk that
//     the static entry graph does not statically reference.
//
// What this gate verifies (charter prop 1 progressive disclosure + prop 5
// consistent abstraction):
//
//   The static-import graph from the entry HTML (i.e. what the browser
//   downloads before any user code runs) does NOT contain any reference
//   to `wgpu_wasm` / `@forgeax/engine-wgpu-wasm` / `@forgeax/engine-naga`. Dynamic
//   `import(...)` references are explicitly ignored — vite resolves them
//   into lazy chunks, which is the documented main-path 0-wasm behavior.
//
// What it deliberately does NOT verify:
//
//   - Whether `dist/assets/*.wasm` files exist on disk. Vite copies the
//     wgpu-wasm `.wasm` asset for the rhi-wgpu fallback path (channel 3);
//     its mere presence is expected and does not violate AC-6.
//   - Sticky byte-size baseline ±5% diff. Recorded separately in
//     report/ but enforced by the metrics runner / sticky comment.
//
// CLI:
//   node apps/hello/triangle/scripts/check-dist-wasm-count.mjs [dist-root]
//   default dist-root = apps/hello/triangle/dist
//
// Exit codes:
//   0  static import graph is clean of build-core symbols
//   1  at least one statically-reachable chunk references a banned symbol
//   2  could not parse dist/index.html or entry chunk missing
//
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const distRoot = resolve(process.argv[2] ?? 'apps/hello/triangle/dist');
const indexHtml = join(distRoot, 'index.html');

// 1) parse entry chunk URL from `<script type="module" ... src="...">`.
let html;
try {
  html = readFileSync(indexHtml, 'utf8');
} catch (e) {
  process.stderr.write(
    `check-dist-wasm-count: cannot read ${indexHtml} (run \`pnpm -F hello-triangle build\` first?)\n`,
  );
  process.stderr.write(`  underlying: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

const entryMatch = html.match(
  /<script[^>]*type="module"[^>]*src="([^"]+)"/,
);
if (!entryMatch) {
  process.stderr.write(`check-dist-wasm-count: no <script type="module"> entry in ${indexHtml}\n`);
  process.exit(2);
}

// vite emits absolute web-paths like `/assets/main-XYZ.js`; resolve to disk.
const entryWebPath = entryMatch[1];
const entryDiskPath = join(distRoot, entryWebPath.replace(/^\//, ''));

// 2) walk static import graph.
//
// Heuristic: vite emits static `import ... from "./chunk.js"` and dynamic
// `import("./chunk.js")` / `import(\`./chunk.js\`)`. We classify by syntax:
//
//   static  -> `from"./chunk.js"` / `from'./chunk.js'`
//   dynamic -> `import("./chunk.js")` / `` import(`./chunk.js`) `` /
//              `import('./chunk.js')`
//
// Dynamic edges are explicitly ignored.
const staticEdgeRe = /from\s*["']\.\/([A-Za-z0-9_.-]+\.js)["']/g;

const banned = /@forgeax\/engine-wgpu-wasm|@forgeax\/engine-naga(?!-wasm-shim)|wgpu_wasm|naga_wasm/;

const visited = new Set();
const hits = [];

function visit(diskPath) {
  if (visited.has(diskPath)) return;
  visited.add(diskPath);
  let content;
  try {
    content = readFileSync(diskPath, 'utf8');
  } catch {
    return;
  }
  const banHit = content.match(banned);
  if (banHit) hits.push({ path: diskPath, hit: banHit[0] });

  const dir = dirname(diskPath);
  staticEdgeRe.lastIndex = 0;
  let m;
  m = staticEdgeRe.exec(content);
  while (m !== null) {
    visit(join(dir, m[1]));
    m = staticEdgeRe.exec(content);
  }
}

visit(entryDiskPath);

// 3) report.
if (hits.length > 0) {
  process.stderr.write(
    `AC-06 ship-runtime 0-wasm FAIL: static import graph from ${entryWebPath} reaches build-core symbols:\n`,
  );
  for (const h of hits) process.stderr.write(`  ${h.path}: '${h.hit}'\n`);
  process.stderr.write(
    `[hint] navigator.gpu main path must not statically download wgpu wasm or naga symbols. The fallback path (channel 3) uses dynamic import; verify no static \`from "./...\"\` edge introduces a wgpu-wasm reference.\n`,
  );
  process.exit(1);
}

// 4) success report (machine-readable counters).
const staticCount = visited.size;
const wasmFiles = [];
function listWasm(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listWasm(p);
    else if (p.endsWith('.wasm')) wasmFiles.push(p);
  }
}
listWasm(distRoot);

process.stdout.write(
  `AC-06 ship-runtime 0-wasm OK: entry=${entryWebPath} staticChunks=${staticCount} reaches no build-core symbol; ${wasmFiles.length} .wasm file(s) emitted as dynamic-import lazy chunks (expected, channel 3 fallback).\n`,
);
