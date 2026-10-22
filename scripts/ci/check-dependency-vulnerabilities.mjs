#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

export const BASELINE_PATH = 'config/dependency-vulnerability-baseline.json';

// First-party lockfiles only. Pinned upstream sources (third_party, vendor)
// are scanned through the first-party lockfile that actually builds them, and
// test fixtures are inert data.
const LOCKFILE = /(?:^|\/)(?:pnpm-lock\.yaml|bun\.lock|Cargo\.lock|[^/]+\.Cargo\.lock)$/;
const EXCLUDED_PATH = /^third_party\/|(?:^|\/)vendor\/|(?:^|\/)__tests__\//;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

export function listLockfiles(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  return output
    .split('\0')
    .filter((path) => LOCKFILE.test(path) && !EXCLUDED_PATH.test(path))
    .sort();
}

function lockfileArgument(root, path) {
  const absolute = resolve(root, path);
  return path.endsWith('.Cargo.lock') ? `Cargo.lock:${absolute}` : absolute;
}

// One finding per alias group and package, so a RUSTSEC id and its GHSA alias
// need only one reviewed baseline entry.
export function collectFindings(report, root) {
  const findings = new Map();
  const prefix = `${resolve(root)}/`;
  for (const result of report.results ?? []) {
    const lockfile = result.source.path.startsWith(prefix)
      ? result.source.path.slice(prefix.length)
      : result.source.path;
    for (const entry of result.packages ?? []) {
      const groups = entry.groups?.length
        ? entry.groups.map((group) => group.ids)
        : entry.vulnerabilities.map((vulnerability) => [vulnerability.id]);
      for (const ids of groups) {
        const id = [...ids].sort()[0];
        const key = `${entry.package.ecosystem}/${entry.package.name}/${id}`;
        const finding = findings.get(key) ?? {
          key,
          id,
          aliases: [...ids].sort(),
          name: entry.package.name,
          versions: new Set(),
          lockfiles: new Set(),
        };
        finding.versions.add(entry.package.version);
        finding.lockfiles.add(lockfile);
        findings.set(key, finding);
      }
    }
  }
  return [...findings.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function readBaseline(root) {
  const parsed = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8'));
  return new Map(Object.entries(parsed.accepted));
}

export function compareWithBaseline(findings, baseline, today) {
  const found = new Set(findings.map((finding) => finding.key));
  const added = findings.filter((finding) => !baseline.has(finding.key));
  const expired = findings.filter((finding) => {
    const accepted = baseline.get(finding.key);
    return accepted !== undefined && accepted.until < today;
  });
  const stale = [...baseline.keys()].filter((key) => !found.has(key));
  return { added, expired, stale };
}

export function formatReport(findings, comparison) {
  const tag = '[dependency-vulnerabilities]';
  const describe = (finding) =>
    `key=${finding.key} versions=${[...finding.versions].join(',')} lockfiles=${[...finding.lockfiles].join(',')}`;
  const failures = [
    ...comparison.added.map((finding) => `${tag} FAIL new ${describe(finding)}`),
    ...comparison.expired.map((finding) => `${tag} FAIL expired ${describe(finding)}`),
    ...comparison.stale.map((key) => `${tag} FAIL stale key=${key}`),
  ];
  const summary = `findings=${findings.length}`;
  if (failures.length === 0) return { status: 0, stdout: `${tag} PASS ${summary}\n`, stderr: '' };
  failures.push(`${tag} FAIL total=${failures.length} ${summary}`);
  if (comparison.added.length > 0 || comparison.expired.length > 0) {
    failures.push(
      `${tag} HINT upgrade the owning dependency declaration and regenerate both lockfiles (AGENTS.md Dependency vulnerability remediation); accept only a reviewed non-reachable finding with a reason and an expiry in ${BASELINE_PATH}.`,
    );
  }
  if (comparison.stale.length > 0) {
    failures.push(`${tag} HINT the finding is gone; delete its entry from ${BASELINE_PATH}.`);
  }
  return { status: 1, stdout: '', stderr: `${failures.join('\n')}\n` };
}

export function runScanner(scanner, root, lockfiles) {
  const args = ['scan', 'source', '--format', 'json'];
  for (const path of lockfiles) args.push('-L', lockfileArgument(root, path));
  const result = spawnSync(scanner, args, {
    encoding: 'utf8',
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  if (result.error !== undefined) {
    throw new Error(`dependency-vulnerabilities: cannot run ${scanner}: ${result.error.message}`);
  }
  // osv-scanner exits 0 when clean and 1 when vulnerabilities were found.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `dependency-vulnerabilities: ${scanner} exited ${result.status}: ${result.stderr.trim().split('\n').slice(-3).join(' | ')}`,
    );
  }
  return JSON.parse(result.stdout);
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let root = process.cwd();
  let scanner = process.env.OSV_SCANNER ?? 'osv-scanner';
  let report;
  let acceptReason;
  let acceptUntil;
  const today = new Date().toISOString().slice(0, 10);
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--root') root = args.shift() ?? '';
    else if (arg === '--scanner') scanner = args.shift() ?? '';
    else if (arg === '--report') report = args.shift();
    else if (arg === '--accept') acceptReason = args.shift();
    else if (arg === '--until') acceptUntil = args.shift();
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/ci/check-dependency-vulnerabilities.mjs [--root <repo>] [--scanner <osv-scanner>] [--report <osv.json>] [--accept <reason> --until <YYYY-MM-DD>]\n',
      );
      return 0;
    } else throw new Error(`dependency-vulnerabilities: unknown argument ${arg}`);
  }
  if ((acceptReason === undefined) !== (acceptUntil === undefined)) {
    throw new Error('dependency-vulnerabilities: --accept and --until are required together');
  }

  const parsed =
    report === undefined
      ? runScanner(scanner, root, listLockfiles(root))
      : JSON.parse(readFileSync(report, 'utf8'));
  const findings = collectFindings(parsed, root);
  const baseline = readBaseline(root);

  if (acceptReason !== undefined) {
    const accepted = Object.fromEntries(
      findings.map((finding) => [
        finding.key,
        baseline.get(finding.key) ?? { reason: acceptReason, until: acceptUntil },
      ]),
    );
    writeFileSync(resolve(root, BASELINE_PATH), `${JSON.stringify({ accepted }, null, 2)}\n`);
    process.stdout.write(
      `[dependency-vulnerabilities] wrote ${BASELINE_PATH} entries=${findings.length}\n`,
    );
    return 0;
  }

  const result = formatReport(findings, compareWithBaseline(findings, baseline, today));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `[dependency-vulnerabilities] setup error: ${String(error?.message ?? error)}\n`,
    );
    process.exitCode = 2;
  }
}
