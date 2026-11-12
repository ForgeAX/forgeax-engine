import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// One benchmark run per (brief, condition): a scratch project, one capped non-interactive
// `claude -p` session with the condition's fixed prompt, and the raw transcript.

const here = import.meta.dirname;
const modelingRoot = resolve(here, '../..');
const engineRoot = resolve(modelingRoot, '../..');
const protocol = JSON.parse(readFileSync(join(here, 'protocol.json'), 'utf8'));
const briefSet = JSON.parse(readFileSync(join(here, 'briefs.json'), 'utf8'));

const { values: args } = parseArgs({
  options: {
    briefs: { type: 'string' },
    conditions: { type: 'string', default: 'tools,control' },
    root: { type: 'string', default: '/tmp/m5-runs' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    'setup-only': { type: 'boolean', default: false },
  },
});

const STARTERS = {
  tools: (packageId) => `import { model, sel } from '@forgeax/engine/modeling';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${packageId}'),
  build: () => {
    const m = model();
    m.box({ size: [0.1, 0.1, 0.1], tag: 'body' });
    m.markSharp(sel.edges.dihedral('>', 30));
    m.uv.project({ mode: 'box', scale: 0.1 });
    return m.finish({ key: 'prop', normals: { mode: 'weighted' } });
  },
});
`,
  control: (packageId) => `import { createMeshBuilder } from '@forgeax/engine/geometry';
import { definePack, definePackageId } from '@forgeax/engine/pack/source';

function box(sx: number, sy: number, sz: number) {
  const h = [sx / 2, sy / 2, sz / 2];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (const [n, u, v] of faces) {
    const base = position.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) position.push(n[k] * h[k] + a * u[k] * h[k] + b * v[k] * h[k]);
      normal.push(...n);
      uv.push((a + 1) / 2, (b + 1) / 2);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return createMeshBuilder({
    attributes: {
      position: new Float32Array(position),
      normal: new Float32Array(normal),
      uv: new Float32Array(uv),
    },
    indices: new Uint32Array(index),
  }).build();
}

export default definePack({
  schemaVersion: '2.0.0',
  packageId: definePackageId('${packageId}'),
  build: () => {
    const mesh = box(0.1, 0.1, 0.1);
    if (!mesh.ok) return mesh;
    return { ok: true, value: { 'mesh/prop': mesh.value } };
  },
});
`,
};

const CHECK = `import { readFileSync } from 'node:fs';
import { measurePack } from './.bench/measure.mjs';

const brief = JSON.parse(readFileSync(new URL('./.bench/brief.json', import.meta.url), 'utf8'));
const report = await measurePack(new URL('./assets/prop.pack.ts', import.meta.url).pathname, brief);
console.log(JSON.stringify(report, null, 2));
console.log(report.closedValid && report.checksPass ? 'CHECKS: PASS' : 'CHECKS: FAIL');
`;

function describeCheck(check) {
  switch (check.kind) {
    case 'size':
      return `- bounding-box size along ${check.axis.toUpperCase()} = ${check.value} m (+/- ${check.tolerance} m)`;
    case 'components':
      return check.min === check.max
        ? `- exactly ${check.min} separate closed part(s) (connected components)`
        : `- between ${check.min} and ${check.max} separate closed parts`;
    case 'genus':
      return `- total genus (through-holes, summed over parts) >= ${check.min}`;
    case 'volumeRatio':
      return `- solid volume / bounding-box volume <= ${check.max} (hollow)`;
    case 'triangles':
      return `- at most ${check.max} triangles`;
    default:
      throw new Error(`unknown check kind ${check.kind}`);
  }
}

export function promptFor(brief, condition) {
  const a = protocol.agent;
  const checks = [
    '- one closed, edge-manifold, consistently outward-oriented triangle mesh',
    ...brief.checks.map(describeCheck),
    ...(brief.checkNotes === undefined ? [] : [`  (${brief.checkNotes})`]),
  ].join('\n');
  return protocol.prompt
    .replace('{maxTurns}', String(a.maxTurns))
    .replace('{minutes}', String(a.wallClockSeconds / 60))
    .replace('{briefId}', brief.id)
    .replace('{briefText}', brief.text)
    .replace('{checks}', checks)
    .replace('{packageId}', brief.packageId)
    .replace('{conditionInstructions}', protocol.conditions[condition].instructions);
}

export function setupProject(dir, brief, condition) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/@forgeax'), { recursive: true });
  mkdirSync(join(dir, '.bench'), { recursive: true });
  mkdirSync(join(dir, 'reference'), { recursive: true });
  symlinkSync(join(engineRoot, 'packages/engine'), join(dir, 'node_modules/@forgeax/engine'));
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: `m5-${brief.id}-${condition}`, private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(join(dir, 'assets/prop.pack.ts'), STARTERS[condition](brief.packageId));
  writeFileSync(join(dir, 'check.mjs'), CHECK);
  cpSync(join(here, 'measure.mjs'), join(dir, '.bench/measure.mjs'));
  writeFileSync(join(dir, '.bench/brief.json'), `${JSON.stringify(brief, null, 2)}\n`);
  if (condition === 'tools') {
    mkdirSync(join(dir, '.claude/skills/forgeax-engine-modeling'), { recursive: true });
    cpSync(
      join(engineRoot, 'skills/forgeax-engine-modeling/SKILL.md'),
      join(dir, '.claude/skills/forgeax-engine-modeling/SKILL.md'),
    );
    cpSync(join(modelingRoot, 'README.md'), join(dir, 'reference/modeling-README.md'));
    cpSync(join(modelingRoot, 'reference'), join(dir, 'reference/reference'), { recursive: true });
    cpSync(join(modelingRoot, 'examples'), join(dir, 'reference/examples'), {
      recursive: true,
      filter: (path) => !path.includes('__tests__'),
    });
    mkdirSync(join(dir, 'bin'));
    writeFileSync(
      join(dir, 'bin/forgeax'),
      `#!/bin/sh\nexec node ${join(engineRoot, 'packages/engine/dist/bin/forgeax.mjs')} "$@"\n`,
      { mode: 0o755 },
    );
  } else {
    cpSync(
      join(engineRoot, 'packages/geometry/README.md'),
      join(dir, 'reference/geometry-README.md'),
    );
    cpSync(
      join(engineRoot, 'packages/geometry/src/mesh-builder.ts'),
      join(dir, 'reference/mesh-builder.ts'),
    );
  }
}

function lastResult(transcript) {
  const lines = transcript.split('\n').filter((line) => line.startsWith('{'));
  let result;
  const bash = [];
  let assistantTurns = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'result') result = event;
    if (event.type === 'assistant') {
      assistantTurns++;
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use' && block.name === 'Bash')
          bash.push(block.input?.command ?? '');
      }
    }
  }
  return { result, bash, assistantTurns };
}

export function runAgent(dir, brief, condition) {
  const a = protocol.agent;
  const prompt = promptFor(brief, condition);
  writeFileSync(join(dir, '.bench/prompt.txt'), prompt);
  const path = [
    ...(condition === 'tools' ? [join(dir, 'bin')] : []),
    '/tmp/m5-bin',
    join(homedir(), '.local/bin'),
    process.env.PATH,
  ].join(':');
  const argv = [
    '-p',
    prompt,
    '--model',
    a.model,
    '--effort',
    a.effort,
    '--max-turns',
    String(a.maxTurns),
    '--max-budget-usd',
    String(a.maxBudgetUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    a.tools.join(','),
    '--allowedTools',
    a.tools.join(','),
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
  ];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn('claude', argv, {
      cwd: dir,
      env: { ...process.env, PATH: path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, a.wallClockSeconds * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const wallSeconds = (Date.now() - started) / 1000;
      writeFileSync(join(dir, '.bench/transcript.jsonl'), out);
      writeFileSync(join(dir, '.bench/stderr.log'), err);
      const { result, bash, assistantTurns } = lastResult(out);
      const usage = result?.usage ?? {};
      const record = {
        schema: 'forgeax.ai-benchmark.run/1',
        brief: brief.id,
        condition,
        protocol: protocol.version,
        briefSet: briefSet.version,
        startedAt: new Date(started).toISOString(),
        wallSeconds,
        timedOut,
        exitCode: code,
        signal,
        resultSubtype: result?.subtype ?? null,
        terminalReason: result?.terminal_reason ?? (timedOut ? 'wall-clock-cap' : null),
        turns: result?.num_turns ?? assistantTurns,
        assistantMessages: assistantTurns,
        costUsd: result?.total_cost_usd ?? null,
        tokens: {
          input: usage.input_tokens ?? null,
          output: usage.output_tokens ?? null,
          cacheRead: usage.cache_read_input_tokens ?? null,
          cacheCreation: usage.cache_creation_input_tokens ?? null,
        },
        models: Object.keys(result?.modelUsage ?? {}),
        humanInterventions: 0,
        bashCommands: bash,
        finalMessage: typeof result?.result === 'string' ? result.result.slice(0, 2000) : null,
      };
      writeFileSync(join(dir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
      done(record);
    });
  });
}

async function pool(tasks, size) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      results.push(await task());
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const wanted = args.briefs?.split(',');
  const briefs = briefSet.briefs.filter((b) => wanted === undefined || wanted.includes(b.id));
  const conditions = args.conditions.split(',');
  const tasks = [];
  for (let r = 1; r <= Number(args.repeat); r++) {
    for (const brief of briefs) {
      for (const condition of conditions) {
        const dir = join(args.root, `${brief.id}--${condition}--r${r}`);
        tasks.push(async () => {
          if (existsSync(join(dir, 'run.json')) && !args['setup-only']) {
            console.log(`skip ${dir}: run.json exists`);
            return undefined;
          }
          setupProject(dir, brief, condition);
          if (args['setup-only']) return dir;
          console.log(`start ${dir}`);
          const record = await runAgent(dir, brief, condition);
          console.log(
            `done ${dir}: ${record.terminalReason} turns=${record.turns} ${record.wallSeconds.toFixed(0)}s $${record.costUsd}`,
          );
          return record;
        });
      }
    }
  }
  await pool(tasks, Number(args.concurrency));
}

if (process.argv[1] === import.meta.filename) await main();
