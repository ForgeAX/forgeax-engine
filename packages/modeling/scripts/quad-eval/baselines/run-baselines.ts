#!/usr/bin/env node
// Offline baseline runner: Instant Meshes, QuadriFlow and QuadWild on L4 reference meshes.
//   node scripts/quad-eval/baselines/run-baselines.ts [--tool im|qf|qw] [--case <id>] [--root <dir>] [--work <dir>]
// The tools are built outside every repository (default root under the OS temp directory,
// override with QB_ROOT or --root). For each case x tool it writes results/<tool>/<case>.json (producer format) and
// results/<tool>/<case>.manifest.json. A missing tool binary is recorded as "baseline not available" (no output file).
// Tests never call this script; it needs the external tools.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCase, type ReadyCase } from '../cases.ts';
import { BASELINE_CASES, SHARP_DEG, TOOLS, type Tool } from './config.ts';
import { evalMeshToObj, objToEvalMesh, producerJson, sha256, triangleInput } from './convert.ts';

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 900_000;

interface Args {
  tools: Tool[];
  cases: string[];
  root: string;
  work: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    tools: [...TOOLS],
    cases: BASELINE_CASES.map((c) => c.id),
    root: process.env.QB_ROOT ?? join(tmpdir(), 'forgeax-quad-baselines'),
    work: '',
  };
  for (let i = 0; i + 1 < argv.length; i++) {
    const v = argv[i + 1] as string;
    if (argv[i] === '--tool') args.tools = [v as Tool];
    else if (argv[i] === '--case') args.cases = [v];
    else if (argv[i] === '--root') args.root = v;
    else if (argv[i] === '--work') args.work = v;
    else continue;
    i++;
  }
  if (args.work === '') args.work = join(args.root, 'work');
  return args;
}

function commitOf(root: string, tool: Tool): string {
  const dir = join(root, tool);
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

interface Attempt {
  readonly argv: readonly string[];
  readonly cwd: string | null;
  readonly wallSeconds: number;
  readonly status: number | null;
  readonly signal: string | null;
  readonly outputFile: string;
  readonly settings: Record<string, string | number>;
}

function timed(binary: string, argv: readonly string[], cwd: string | undefined, log: string) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(binary, [...argv], {
    cwd,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 1 << 28,
  });
  const wall = Number(process.hrtime.bigint() - t0) / 1e9;
  writeFileSync(log, `${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}\n`);
  return { r, wall };
}

function runIm(
  root: string,
  dir: string,
  inputObj: string,
  target: number,
): { attempts: Attempt[]; outputs: string[] } {
  const out = join(dir, 'im.obj');
  const argv = [
    '-f',
    String(Math.max(1, Math.round(target / 4))),
    '-c',
    String(SHARP_DEG),
    '-d',
    '-t',
    '1',
    '-o',
    out,
    inputObj,
  ];
  const { r, wall } = timed(
    join(root, 'build/im/instant-meshes-headless'),
    argv,
    undefined,
    join(dir, 'im.log'),
  );
  return {
    attempts: [
      {
        argv: argv.map((a) => (a === out ? '<out.obj>' : a === inputObj ? '<in.obj>' : a)),
        cwd: null,
        wallSeconds: wall,
        status: r.status,
        signal: r.signal,
        outputFile: out,
        settings: {
          faces: Math.round(target / 4),
          crease: SHARP_DEG,
          mode: 'pure quad, -f target/4 (pure-quad 2x2 subdivision)',
        },
      },
    ],
    outputs: [out],
  };
}

function runQf(
  root: string,
  dir: string,
  inputObj: string,
  target: number,
): { attempts: Attempt[]; outputs: string[] } {
  const out = join(dir, 'qf.obj');
  const argv = ['-i', inputObj, '-o', out, '-f', String(target), '-sharp', '-seed', '1'];
  const { r, wall } = timed(
    join(root, 'build/qf/quadriflow'),
    argv,
    undefined,
    join(dir, 'qf.log'),
  );
  return {
    attempts: [
      {
        argv: argv.map((a) => (a === out ? '<out.obj>' : a === inputObj ? '<in.obj>' : a)),
        cwd: null,
        wallSeconds: wall,
        status: r.status,
        signal: r.signal,
        outputFile: out,
        settings: {
          faces: target,
          sharp: 'on (threshold fixed at 60 deg in upstream source)',
          seed: 1,
        },
      },
    ],
    outputs: [out],
  };
}

function facesOf(file: string): number {
  if (!existsSync(file)) return 0;
  const parsed = objToEvalMesh(readFileSync(file, 'utf8'));
  return parsed.ok ? parsed.value.mesh.faces.length : 0;
}

function runQw(
  root: string,
  dir: string,
  inputObj: string,
  target: number,
): { attempts: Attempt[]; outputs: string[] } {
  const attempts: Attempt[] = [];
  const outputs: string[] = [];
  let scale = 1;
  for (let round = 0; round < 2; round++) {
    const sub = join(dir, `qw${round}`);
    rmSync(sub, { recursive: true, force: true });
    mkdirSync(sub, { recursive: true });
    const setup = [
      'do_remesh 1',
      `sharp_feature_thr ${SHARP_DEG}`,
      'alpha 0.01',
      `scaleFact ${scale}`,
      '',
    ].join('\n');
    writeFileSync(join(sub, 'basic_setup.txt'), setup);
    const local = join(sub, 'input.obj');
    writeFileSync(local, readFileSync(inputObj));
    const argv = ['input.obj'];
    const { r, wall } = timed(join(root, 'build/qw/quadwild'), argv, sub, join(sub, 'qw.log'));
    const out = join(sub, 'input_quadrangulation_smooth.obj');
    attempts.push({
      argv: ['quadwild', 'input.obj'],
      cwd: '<run dir with basic_setup.txt>',
      wallSeconds: wall,
      status: r.status,
      signal: r.signal,
      outputFile: out,
      settings: {
        do_remesh: 1,
        sharp_feature_thr: SHARP_DEG,
        alpha: 0.01,
        scaleFact: Number(scale.toFixed(4)),
      },
    });
    outputs.push(out);
    const got = facesOf(out);
    if (got === 0 || Math.abs(got - target) / target <= 0.25) break;
    scale = Math.min(8, Math.max(0.2, scale * Math.sqrt(got / target)));
  }
  return { attempts, outputs };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  let failures = 0;
  for (const tool of args.tools) {
    const binary = {
      im: join(args.root, 'build/im/instant-meshes-headless'),
      qf: join(args.root, 'build/qf/quadriflow'),
      qw: join(args.root, 'build/qw/quadwild'),
    }[tool];
    const resultDir = join(here, 'results', tool);
    mkdirSync(resultDir, { recursive: true });
    for (const id of args.cases) {
      const config = BASELINE_CASES.find((c) => c.id === id);
      const entry = findCase(id);
      if (config === undefined || entry === undefined || entry.status !== 'ready') {
        process.stderr.write(`skip unknown case ${id}\n`);
        continue;
      }
      const manifestPath = join(resultDir, `${id}.manifest.json`);
      if (!existsSync(binary)) {
        writeFileSync(
          manifestPath,
          `${JSON.stringify({ tool, case: id, available: false, note: 'baseline not available' }, null, 2)}\n`,
        );
        continue;
      }
      const dir = join(args.work, id);
      mkdirSync(dir, { recursive: true });
      const input = triangleInput((entry as ReadyCase).build().reference);
      const inputObj = join(dir, 'input.obj');
      const inputText = evalMeshToObj(input);
      writeFileSync(inputObj, inputText);
      const ran = { im: runIm, qf: runQf, qw: runQw }[tool](
        args.root,
        dir,
        inputObj,
        config.targetFaces,
      );
      const last = ran.attempts[ran.attempts.length - 1] as Attempt;
      const outFile = last.outputFile;
      const manifest: Record<string, unknown> = {
        tool,
        case: id,
        available: true,
        toolCommit: commitOf(args.root, tool),
        inputSha256: sha256(inputText),
        inputFaces: input.faces.length,
        targetFaces: config.targetFaces,
        sharpDeg: SHARP_DEG,
        attempts: ran.attempts.map(({ outputFile: _o, ...rest }) => rest),
        wallSeconds: ran.attempts.reduce((s, a) => s + a.wallSeconds, 0),
      };
      if (!existsSync(outFile) || last.status !== 0) {
        manifest.outcome = 'failed';
        manifest.failure = `exit ${last.status ?? 'none'} signal ${last.signal ?? 'none'}; output ${existsSync(outFile) ? 'present' : 'missing'}`;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        rmSync(join(resultDir, `${id}.json`), { force: true });
        failures++;
        process.stdout.write(`${tool} ${id}: FAILED (${String(manifest.failure)})\n`);
        continue;
      }
      const converted = objToEvalMesh(readFileSync(outFile, 'utf8'));
      if (!converted.ok) {
        manifest.outcome = 'failed';
        manifest.failure = `converter: ${converted.error.code}`;
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        failures++;
        continue;
      }
      const json = producerJson(converted.value.mesh);
      writeFileSync(join(resultDir, `${id}.json`), json);
      manifest.outcome = 'ok';
      manifest.outputSha256 = sha256(json);
      manifest.rawOutputSha256 = sha256(readFileSync(outFile));
      manifest.outputFaces = converted.value.mesh.faces.length;
      manifest.dropped = converted.value.dropped;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(
        `${tool} ${id}: ${converted.value.mesh.faces.length} faces (target ${config.targetFaces}) in ${(manifest.wallSeconds as number).toFixed(1)} s\n`,
      );
    }
  }
  return failures > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
