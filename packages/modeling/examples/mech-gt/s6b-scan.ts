// Case C-100 S6b: full-assembly interference of the S7 rig with the S6b robot form, against
// the S3 blocks as the baseline. Prints the confirmed pairs that involve S6b members or
// sub-parts and those that are new against the baseline report.
// Usage: node examples/mech-gt/s6b-scan.ts [s6b|s3] [out.json] [--step 0.05]
import { writeFileSync } from 'node:fs';
import { buildS6bMech, members, s6bMechSource, s6bRig } from './s6b-robot.ts';
import { buildS7 } from './s7-motion.ts';

const which = process.argv[2] ?? 's6b';
const out = process.argv[3];
const step = Number(process.argv[process.argv.indexOf('--step') + 1] ?? 0.05) || 0.05;
const started = performance.now();
const s7 = buildS7('sheet', which === 's6b' ? s6bMechSource() : undefined);
const built = performance.now();
const scan = s7.rig.scan(s7.forward, { step });
if (!scan.ok) throw scan.error;
const report = scan.value;
const confirmed = report.pairs.filter((p) => p.status === 'confirmed');
// Every S6b part: the members and every sub-part the rig extension binds.
const robot = new Set([...members().map((m) => m.part), ...Object.keys(s6bRig(buildS6bMech()).bindings)]);
const ours = (p: string) => robot.has(p);
const summary = {
  which,
  buildMs: Math.round(built - started),
  scanMs: Math.round(performance.now() - built),
  pass: report.pass,
  samples: report.samples.length,
  clamped: report.clamped.length,
  confirmed: confirmed.length,
  robotConfirmed: confirmed.filter((p) => p.parts.some(ours)).map((p) => ({ parts: p.parts, first: p.firstConfirmed, depth: +p.maxDepth.toFixed(4), at: +p.maxDepthAt.toFixed(3) })),
  other: confirmed.filter((p) => !p.parts.some(ours)).map((p) => p.parts.join(' x ')),
};
if (out !== undefined) writeFileSync(out, `${JSON.stringify({ summary, confirmed: confirmed.map((p) => ({ parts: p.parts, first: p.firstConfirmed, depth: p.maxDepth, at: p.maxDepthAt })) }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 1));
