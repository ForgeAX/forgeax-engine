#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const action = argv[0];
const args = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === '--root' && argv[i + 1]) args.root = argv[++i];
  else if (argv[i] === '--artifacts' && argv[i + 1]) args.artifacts = argv[++i];
  else if (argv[i] === '--json') args.json = true;
  else if (!args.scenario) args.scenario = argv[i];
}

const root = resolve(args.root ?? process.cwd());

function fail(code, expected, hint) {
  process.stderr.write(
    `[reason] ${code}: ${expected}\n[rerun]  pnpm gauntlet <run|audit>\n[hint]   ${hint}\n`,
  );
  process.exit(1);
}

const EVIDENCE_LEGS = new Set(['semantic', 'live', 'gpu', 'behavioral', 'recovery']);

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.length > 0)
  );
}

function findPackageJsons(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  if (existsSync(join(dir, 'package.json'))) {
    acc.push(join(dir, 'package.json'));
    return acc;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.'))
      continue;
    findPackageJsons(join(dir, entry.name), acc);
  }
  return acc;
}

function scenarios() {
  const found = [];
  for (const packagePath of findPackageJsons(join(root, 'apps'))) {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    const scenario = pkg?.forgeax?.gauntletScenario;
    if (scenario === undefined) continue;
    if (
      !scenario ||
      typeof scenario.id !== 'string' ||
      typeof scenario.script !== 'string' ||
      !Array.isArray(scenario.domains) ||
      !Array.isArray(scenario.packages) ||
      !Array.isArray(scenario.risks) ||
      !Array.isArray(scenario.phaseInputs) ||
      !scenario.evidence ||
      !isNonEmptyStringArray(scenario.evidence.frontDoors) ||
      !isNonEmptyStringArray(scenario.evidence.legs) ||
      !Array.isArray(scenario.oracle?.stdoutIncludes)
    ) {
      fail(
        'gauntlet-scenario-malformed',
        `${relative(root, packagePath)} has a complete forgeax.gauntletScenario declaration`,
        'declare id, script, domains, packages, risks, phaseInputs, evidence, and oracle.stdoutIncludes',
      );
    }
    for (const leg of scenario.evidence.legs) {
      if (typeof leg !== 'string' || !EVIDENCE_LEGS.has(leg)) {
        fail(
          'gauntlet-evidence-leg-unknown',
          `${relative(root, packagePath)} declares one of ${[...EVIDENCE_LEGS].join(', ')}`,
          'use the roadmap evidence-leg names: semantic, live, gpu, behavioral, recovery',
        );
      }
    }
    found.push({ ...scenario, packageDir: resolve(packagePath, '..') });
  }
  return found;
}

function coverage(items) {
  const count = (select) => {
    const out = {};
    for (const item of items) for (const value of select(item)) out[value] = (out[value] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  return {
    scenarios: items.map((item) => item.id).sort(),
    domains: count((item) => item.domains),
    packages: count((item) => item.packages),
    risks: count((item) => item.risks),
    frontDoors: count((item) => item.evidence.frontDoors),
    evidenceLegs: count((item) => item.evidence.legs),
  };
}

if (action === 'audit') {
  const result = coverage(scenarios());
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`Gauntlet scenarios: ${result.scenarios.join(', ') || '(none)'}\n`);
  process.exit(0);
}

if (action !== 'run' || !args.scenario) {
  fail(
    'gauntlet-usage',
    'run <scenario-id> [--artifacts <dir>] or audit [--json]',
    'run pnpm gauntlet audit first',
  );
}

const scenario = scenarios().find((item) => item.id === args.scenario);
if (!scenario)
  fail(
    'gauntlet-scenario-unknown',
    `a declared scenario named '${args.scenario}'`,
    'run pnpm gauntlet audit',
  );

const artifacts = resolve(args.artifacts ?? join(root, '.forgeax-gauntlet'));
const artifactDir = join(artifacts, scenario.id);
mkdirSync(artifactDir, { recursive: true });
const child = spawnSync('pnpm', ['--dir', scenario.packageDir, 'run', scenario.script], {
  cwd: root,
  env: { ...process.env, FORGEAX_GAUNTLET_ARTIFACT_DIR: artifactDir },
  encoding: 'utf8',
});
const stdout = child.stdout ?? '';
const stderr = child.stderr ?? '';
writeFileSync(join(artifactDir, 'stdout.log'), stdout);
writeFileSync(join(artifactDir, 'stderr.log'), stderr);
const missing = scenario.oracle.stdoutIncludes.filter((line) => !stdout.includes(line));
const passed = child.status === 0 && missing.length === 0;
const result = {
  scenarioId: scenario.id,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  phaseInputs: scenario.phaseInputs,
  evidence: scenario.evidence,
  oracle: { passed, exitCode: child.status, missingStdout: missing },
};
writeFileSync(join(artifactDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(stdout);
process.stderr.write(stderr);
if (!passed) process.exit(1);
