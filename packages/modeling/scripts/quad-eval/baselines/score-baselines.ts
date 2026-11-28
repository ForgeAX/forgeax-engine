#!/usr/bin/env node
// Score converted baseline meshes with the L4 evaluator only.
//   node scripts/quad-eval/baselines/score-baselines.ts
// Reads results/<tool>/<case>.json + .manifest.json, writes results/results.json and results/TABLE.md.
// Missing or failed runs are rows with status "baseline not available" / "failed"; nothing is invented.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCase, type ReadyCase } from '../cases.ts';
import { hausdorff, sharpCoverage, sharpEdges } from '../fidelity.ts';
import { boundsOf, parseMesh } from '../mesh.ts';
import { evaluate, quantile } from '../metrics.ts';
import { LIMITS } from '../report.ts';
import { BASELINE_CASES, TOOL_NAMES, TOOLS, type Tool } from './config.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface Score {
  readonly tool: Tool;
  readonly case: string;
  readonly status: 'scored' | 'failed' | 'baseline not available';
  readonly detail?: string;
  readonly targetFaces?: number;
  readonly faces?: number;
  readonly quadRatio?: number;
  readonly sjMin?: number;
  readonly sjP05?: number;
  readonly sjP10?: number;
  readonly sjMean?: number;
  readonly inverted?: number;
  readonly singularities?: number;
  readonly valenceInterior?: Record<string, number>;
  readonly openEdges?: number;
  readonly nonManifoldEdges?: number;
  readonly sharpEdges?: number;
  readonly sharpCovered?: number | null;
  readonly hausdorffRel?: number;
  /** Wall time of the final (reported) run. QuadWild's first attempt only calibrates scaleFact; see totalWallSeconds. */
  readonly wallSeconds?: number;
  readonly totalWallSeconds?: number;
  readonly attempts?: number;
  readonly droppedNonQuad?: number;
  readonly toolCommit?: string;
  readonly outputSha256?: string;
}

/** 5th percentile of per-element scaled Jacobian (the L4 report carries only min/p10/mean/max). */
export function p05(values: readonly number[]): number {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.05,
  );
}

function scoreOne(tool: Tool, id: string, target: number): Score {
  const base = join(here, 'results', tool);
  const manifestPath = join(base, `${id}.manifest.json`);
  if (!existsSync(manifestPath))
    return {
      tool,
      case: id,
      status: 'baseline not available',
      detail: 'no run recorded',
    };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  if (manifest.available === false)
    return {
      tool,
      case: id,
      status: 'baseline not available',
      detail: 'tool not built',
    };
  if (manifest.outcome !== 'ok')
    return {
      tool,
      case: id,
      status: 'failed',
      detail: String(manifest.failure ?? 'unknown'),
      wallSeconds: manifest.wallSeconds as number,
    };
  const parsed = parseMesh(JSON.parse(readFileSync(join(base, `${id}.json`), 'utf8')));
  if (!parsed.ok)
    return {
      tool,
      case: id,
      status: 'failed',
      detail: `parseMesh: ${parsed.issue.code}`,
    };
  const entry = findCase(id) as ReadyCase;
  const reference = entry.build().reference;
  const diag = boundsOf(reference.positions).diag;
  const mesh = parsed.mesh;
  const ev = evaluate(mesh);
  const sj = ev.elements.map((e) => e.sJ);
  const sharpSet = sharpEdges(reference, diag);
  const sharp = sharpCoverage(mesh, diag, sharpSet);
  const hd = hausdorff(mesh, reference, diag);
  const hist: Record<string, number> = {};
  for (const h of ev.valence.interior) hist[String(h.valence)] = h.count;
  const attempts = manifest.attempts as { wallSeconds: number }[] | undefined;
  const lastAttempt = attempts?.[attempts.length - 1];
  const dropped = manifest.dropped as { count: number } | undefined;
  return {
    tool,
    case: id,
    status: 'scored',
    targetFaces: target,
    faces: mesh.faces.length,
    quadRatio: ev.counts.faces === 0 ? 0 : ev.counts.quads / ev.counts.faces,
    sjMin: ev.scaledJacobian.min,
    sjP05: p05(sj),
    sjP10: ev.scaledJacobian.p10,
    sjMean: ev.scaledJacobian.mean,
    inverted: ev.inverted.count,
    singularities: ev.valence.singularities.count,
    valenceInterior: hist,
    openEdges: ev.topology.boundaryEdges,
    nonManifoldEdges: ev.topology.nonManifoldEdges,
    sharpEdges: sharpSet.length,
    sharpCovered: sharp === null ? null : sharp.covered,
    hausdorffRel: diag > 0 ? hd.max / diag : 0,
    wallSeconds: lastAttempt?.wallSeconds ?? (manifest.wallSeconds as number),
    totalWallSeconds: manifest.wallSeconds as number,
    attempts: attempts?.length ?? 1,
    droppedNonQuad: dropped?.count ?? 0,
    toolCommit: manifest.toolCommit as string,
    outputSha256: manifest.outputSha256 as string,
  };
}

const f = (v: number | null | undefined, d = 3): string =>
  v === null || v === undefined ? 'n/a' : v.toFixed(d);

export function tableOf(scores: readonly Score[]): string {
  const rows = [
    '| case | tool | faces (target) | quad % | SJ min | SJ p05 | inverted | singularities | sharp covered | Hausdorff/diag | open edges | s |',
    '|:--|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
  ];
  for (const s of scores) {
    if (s.status !== 'scored') {
      rows.push(
        `| ${s.case} | ${TOOL_NAMES[s.tool]} | ${s.status}: ${s.detail ?? ''} | | | | | | | | | |`,
      );
      continue;
    }
    rows.push(
      `| ${s.case} | ${TOOL_NAMES[s.tool]} | ${s.faces} (${s.targetFaces}) | ${f((s.quadRatio ?? 0) * 100, 1)} | ${f(s.sjMin)} | ${f(s.sjP05)} | ${s.inverted} | ${s.singularities} | ${s.sharpCovered === null ? 'n/a' : f((s.sharpCovered ?? 0) * 100, 1)} | ${f(s.hausdorffRel, 4)} | ${s.openEdges} | ${f(s.wallSeconds, 1)} |`,
    );
  }
  return `${rows.join('\n')}\n`;
}

function main(): number {
  const scores: Score[] = [];
  for (const c of BASELINE_CASES)
    for (const tool of TOOLS) scores.push(scoreOne(tool, c.id, c.targetFaces));
  writeFileSync(
    join(here, 'results', 'results.json'),
    `${JSON.stringify({ schema: 'forgeax.modeling.quad-baselines/1', limits: LIMITS, scores }, null, 2)}\n`,
  );
  writeFileSync(join(here, 'results', 'TABLE.md'), tableOf(scores));
  process.stdout.write(tableOf(scores));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
