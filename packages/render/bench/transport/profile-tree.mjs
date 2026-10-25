// Summarize a sampled heap profile (run.mjs --profile-receiver/--profile-source) as a
// per-frame KiB allocation tree: node profile-tree.mjs <profile.json> [frames] [depth] [minKiB]
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(process.argv[2]));
const frames = Number(process.argv[3] ?? 120), depth = Number(process.argv[4] ?? 4), min = Number(process.argv[5] ?? 2);
const name = n => { const f = n.callFrame; return `${f.functionName || '(anon)'} ${f.url.split('/').slice(-1)[0]}:${f.lineNumber + 1}`; };
const sum = n => n.selfSize + n.children.reduce((a, c) => a + sum(c), 0);
const tree = (n, d) => { const v = sum(n) / frames / 1024; if (v < min) return; console.log(`${'  '.repeat(d)}${v.toFixed(1).padStart(7)} ${name(n)}`); if (d < depth) for (const c of [...n.children].sort((a, b) => sum(b) - sum(a))) tree(c, d + 1); };
tree(profile.head, 0);
