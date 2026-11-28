#!/usr/bin/env node
// L4 quad evaluator CLI.
//   node scripts/quad-eval/run.ts --case <id> --producer identity|json:<path> --out <dir> [--no-strict]
//   node scripts/quad-eval/run.ts --all --producer identity --out <dir> [--no-strict]
//   node scripts/quad-eval/run.ts --list
// Exit codes: 0 pass (or pending, or --no-strict), 1 a verdict gate failed, 2 usage or producer input error.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CASES, type CaseEntry, findCase, type ReadyCase } from './cases.ts';
import { hausdorff, sharpCoverage, sharpEdges } from './fidelity.ts';
import { boundsOf } from './mesh.ts';
import { evaluate } from './metrics.ts';
import { type ProducerError, parseProducerSpec, resolveProducer } from './producers.ts';
import { pngOf, renderJacobian, renderShaded, renderWire } from './raster.ts';
import { buildReport, type Fidelity, pendingReport, verdictOf } from './report.ts';

export interface RunOptions {
  readonly caseId: string;
  readonly producerSpec: string;
  readonly outDir: string;
  readonly strict: boolean;
}

export interface RunOutcome {
  readonly exitCode: number;
  readonly message: string;
}

function reportPath(outDir: string, producerId: string, caseId: string): string {
  return join(outDir, producerId, caseId);
}

function describeProducerError(error: ProducerError): string {
  switch (error.code) {
    case 'bad-producer-spec':
      return `bad --producer spec: ${error.spec} (expected identity or json:<path>)`;
    case 'read-failed':
      return `cannot read producer file: ${error.path}`;
    case 'not-json':
      return `producer file is not JSON: ${error.path}`;
    case 'invalid-mesh':
      return `producer mesh rejected: ${JSON.stringify(error.issue)}`;
  }
}

/** Run one case and write report.json plus three renders into <out>/<producer>/<case>/. */
export function runCase(entry: CaseEntry, options: RunOptions): RunOutcome {
  if (entry.status === 'pending') {
    const dir = reportPath(options.outDir, 'identity', entry.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'report.json'), `${JSON.stringify(pendingReport(entry), null, 2)}\n`);
    return { exitCode: 0, message: `${entry.id}: pending on ${entry.pendingOn}` };
  }
  return runReady(entry, options);
}

function runReady(entry: ReadyCase, options: RunOptions): RunOutcome {
  const parsed = parseProducerSpec(options.producerSpec);
  if (!parsed.ok) return { exitCode: 2, message: describeProducerError(parsed.error) };
  const built = entry.build();
  const producer = resolveProducer(parsed.producer, built);
  if (!producer.ok) return { exitCode: 2, message: describeProducerError(producer.error) };

  const reference = built.reference;
  const diag = boundsOf(reference.positions).diag;
  const ev = evaluate(producer.mesh);
  const sharpSet = sharpEdges(reference, diag);
  const hd = hausdorff(producer.mesh, reference, diag);
  const sharp = sharpCoverage(producer.mesh, diag, sharpSet);
  const fid: Fidelity = { diag, hausdorff: hd, sharp };

  const dir = reportPath(options.outDir, producer.id, entry.id);
  mkdirSync(dir, { recursive: true });
  const fit = [...reference.positions, ...producer.mesh.positions];
  writeFileSync(join(dir, 'wire.png'), pngOf(renderWire(producer.mesh, fit)));
  writeFileSync(join(dir, 'shaded.png'), pngOf(renderShaded(producer.mesh, ev.elements, fit)));
  writeFileSync(join(dir, 'jacobian.png'), pngOf(renderJacobian(producer.mesh, ev.elements, fit)));

  const report = buildReport({
    entry,
    producer:
      producer.inputDigest === undefined
        ? { id: producer.id }
        : { id: producer.id, inputDigest: producer.inputDigest },
    ev,
    fid,
    notes: built.notes,
  });
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const verdict = verdictOf(ev, fid);
  const failed = verdict.failed.length > 0;
  const summary = failed ? `FAIL [${verdict.failed.join(', ')}]` : 'pass';
  const exitCode = failed && options.strict ? 1 : 0;
  return { exitCode, message: `${entry.id} (${producer.id}): ${summary} -> ${dir}` };
}

function parseArgs(
  argv: readonly string[],
):
  | { ok: true; mode: 'list' | 'one' | 'all'; opts: Partial<RunOptions> & { caseId?: string } }
  | { ok: false; message: string } {
  const opts: { caseId?: string; producerSpec?: string; outDir?: string; strict: boolean } = {
    strict: true,
  };
  let mode: 'list' | 'one' | 'all' | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const take = (): string | undefined => {
      const v = argv[i + 1];
      if (v === undefined) return undefined;
      i++;
      return v;
    };
    if (arg === '--list') mode = 'list';
    else if (arg === '--all') mode = 'all';
    else if (arg === '--no-strict') opts.strict = false;
    else if (arg === '--case') {
      const v = take();
      if (v === undefined) return { ok: false, message: '--case needs an id' };
      opts.caseId = v;
      mode = 'one';
    } else if (arg === '--producer') {
      const v = take();
      if (v === undefined)
        return { ok: false, message: '--producer needs identity or json:<path>' };
      opts.producerSpec = v;
    } else if (arg === '--out') {
      const v = take();
      if (v === undefined) return { ok: false, message: '--out needs a directory' };
      opts.outDir = v;
    } else return { ok: false, message: `unknown argument: ${arg}` };
  }
  if (mode === undefined) return { ok: false, message: 'expected --case <id>, --all or --list' };
  return { ok: true, mode, opts };
}

const USAGE = `usage:
  node scripts/quad-eval/run.ts --case <id> --producer identity|json:<path> --out <dir> [--no-strict]
  node scripts/quad-eval/run.ts --all --producer identity --out <dir> [--no-strict]
  node scripts/quad-eval/run.ts --list`;

export function main(argv: readonly string[]): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n${USAGE}\n`);
    return 2;
  }
  if (parsed.mode === 'list') {
    for (const c of CASES) process.stdout.write(`${c.id}\t${c.status}\t${c.title}\n`);
    return 0;
  }
  const producerSpec = parsed.opts.producerSpec ?? 'identity';
  const outDir = parsed.opts.outDir;
  if (outDir === undefined) {
    process.stderr.write(`--out <dir> is required\n${USAGE}\n`);
    return 2;
  }
  const strict = parsed.opts.strict ?? true;
  const targets: CaseEntry[] = [];
  if (parsed.mode === 'all') targets.push(...CASES);
  else {
    const entry = findCase(parsed.opts.caseId ?? '');
    if (entry === undefined) {
      process.stderr.write(`unknown case id: ${parsed.opts.caseId ?? ''} (see --list)\n`);
      return 2;
    }
    targets.push(entry);
  }
  let worst = 0;
  for (const entry of targets) {
    const outcome = runCase(entry, { caseId: entry.id, producerSpec, outDir, strict });
    process.stdout.write(`${outcome.message}\n`);
    if (outcome.exitCode > worst) worst = outcome.exitCode;
  }
  return worst;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
