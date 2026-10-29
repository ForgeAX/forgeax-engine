#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

// CodeCC's risk threshold: a function whose cyclomatic complexity exceeds 20
// is a risk function (tiers: 21-39 medium, 40-59 high, >=60 very high).
export const COMPLEXITY_THRESHOLD = 20;
export const BASELINE_PATH = 'config/function-complexity-baseline.json';

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Generated, vendored and minified sources are owned by their producers.
const EXCLUDED_PATH =
  /(?:^|\/)(?:pkg|vendor|dist|node_modules|generated)\/|^third_party\/|\.d\.[cm]?ts$|\.min\.js$/;
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

function listSourceFiles(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--stage', '-z'], {
    encoding: 'utf8',
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  return output
    .split('\0')
    .filter(Boolean)
    .flatMap((entry) => {
      const tab = entry.indexOf('\t');
      const mode = entry.slice(0, entry.indexOf(' '));
      const path = entry.slice(tab + 1);
      if (!mode.startsWith('100')) return [];
      return SOURCE_EXTENSIONS.test(path) && !EXCLUDED_PATH.test(path) ? [path] : [];
    })
    .sort();
}

function scriptKindFor(path) {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function isDecisionPoint(node) {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ConditionalExpression:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.CatchClause:
      return true;
    case ts.SyntaxKind.BinaryExpression:
      switch (node.operatorToken.kind) {
        case ts.SyntaxKind.AmpersandAmpersandToken:
        case ts.SyntaxKind.BarBarToken:
        case ts.SyntaxKind.QuestionQuestionToken:
        case ts.SyntaxKind.AmpersandAmpersandEqualsToken:
        case ts.SyntaxKind.BarBarEqualsToken:
        case ts.SyntaxKind.QuestionQuestionEqualsToken:
          return true;
        default:
          return false;
      }
    default:
      return false;
  }
}

function functionName(node) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name !== undefined) {
    const name = node.name.getText();
    if (ts.isGetAccessorDeclaration(node)) return `get ${name}`;
    if (ts.isSetAccessorDeclaration(node)) return `set ${name}`;
    return name;
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText();
  }
  if (ts.isPropertyAssignment(parent)) return parent.name.getText();
  if (ts.isExportAssignment(parent)) return 'default';
  return '<anonymous>';
}

function scopeName(node) {
  if (ts.isClassLike(node)) return node.name?.getText() ?? '<class>';
  return undefined;
}

// Identity is the lexical path of named scopes, not the line, so unrelated
// edits above a function do not churn the baseline.
export function measureSource(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const records = [];
  const seen = new Map();

  function visit(node, scope, current) {
    if (ts.isFunctionLike(node) && 'body' in node && node.body !== undefined) {
      const name = [...scope, functionName(node)].join('.');
      const ordinal = (seen.get(name) ?? 0) + 1;
      seen.set(name, ordinal);
      const record = {
        id: ordinal === 1 ? `${path}::${name}` : `${path}::${name}#${ordinal}`,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        complexity: 1,
      };
      records.push(record);
      ts.forEachChild(node, (child) => visit(child, [...scope, functionName(node)], record));
      return;
    }
    if (current !== undefined && isDecisionPoint(node)) current.complexity += 1;
    const nested = scopeName(node);
    const nextScope = nested === undefined ? scope : [...scope, nested];
    ts.forEachChild(node, (child) => visit(child, nextScope, current));
  }

  visit(source, [], undefined);
  return records;
}

export function scanFunctionComplexity(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const risks = [];
  let functionCount = 0;
  const files = listSourceFiles(absoluteRoot);
  for (const path of files) {
    const text = readFileSync(resolve(absoluteRoot, path), 'utf8');
    for (const record of measureSource(path, text)) {
      functionCount += 1;
      if (record.complexity > COMPLEXITY_THRESHOLD) risks.push(record);
    }
  }
  risks.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { fileCount: files.length, functionCount, risks };
}

export function readBaseline(root) {
  const parsed = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8'));
  if (parsed.threshold !== COMPLEXITY_THRESHOLD) {
    throw new Error(
      `function-complexity: ${BASELINE_PATH} threshold ${parsed.threshold} != ${COMPLEXITY_THRESHOLD}`,
    );
  }
  return new Map(Object.entries(parsed.functions));
}

export function compareWithBaseline(scan, baseline) {
  const grown = [];
  const added = [];
  const current = new Map();
  for (const risk of scan.risks) {
    current.set(risk.id, risk.complexity);
    const allowed = baseline.get(risk.id);
    if (allowed === undefined) added.push(risk);
    else if (risk.complexity > allowed) grown.push({ ...risk, allowed });
  }
  const stale = [...baseline]
    .filter(([id, allowed]) => (current.get(id) ?? 0) < allowed)
    .map(([id, allowed]) => ({ id, allowed, complexity: current.get(id) ?? 0 }));
  return { added, grown, stale };
}

function serializeBaseline(entries) {
  const functions = Object.fromEntries(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify({ threshold: COMPLEXITY_THRESHOLD, functions }, null, 2)}\n`;
}

// --write only tightens: entries drop or lower to the measured value. Growth
// and new risk functions need --accept-increase, which keeps them visible in
// the baseline diff for review.
export function nextBaseline(scan, baseline, { acceptIncrease }) {
  const next = new Map();
  for (const risk of scan.risks) {
    const allowed = baseline.get(risk.id);
    if (allowed === undefined || risk.complexity > allowed) {
      if (acceptIncrease) next.set(risk.id, risk.complexity);
      else if (allowed !== undefined) next.set(risk.id, allowed);
      continue;
    }
    next.set(risk.id, risk.complexity);
  }
  return next;
}

export function formatReport(scan, comparison) {
  const tag = '[function-complexity]';
  const failures = [
    ...comparison.added.map(
      (r) =>
        `${tag} FAIL new id=${r.id} line=${r.line} complexity=${r.complexity} max=${COMPLEXITY_THRESHOLD}`,
    ),
    ...comparison.grown.map(
      (r) =>
        `${tag} FAIL grown id=${r.id} line=${r.line} complexity=${r.complexity} baseline=${r.allowed}`,
    ),
    ...comparison.stale.map(
      (r) => `${tag} FAIL stale id=${r.id} complexity=${r.complexity} baseline=${r.allowed}`,
    ),
  ];
  const summary = `files=${scan.fileCount} functions=${scan.functionCount} risks=${scan.risks.length} max=${COMPLEXITY_THRESHOLD}`;
  if (failures.length === 0) return { status: 0, stdout: `${tag} PASS ${summary}\n`, stderr: '' };
  failures.push(`${tag} FAIL total=${failures.length} ${summary}`);
  if (comparison.added.length > 0 || comparison.grown.length > 0) {
    failures.push(
      `${tag} HINT split decision logic by owner until each function is <= ${COMPLEXITY_THRESHOLD}; do not hide branches behind lookup tables or dynamic dispatch.`,
    );
  }
  if (comparison.stale.length > 0) {
    failures.push(
      `${tag} HINT complexity dropped; run \`pnpm check:function-complexity --write\` to lock it in.`,
    );
  }
  return { status: 1, stdout: '', stderr: `${failures.join('\n')}\n` };
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let root = process.cwd();
  let write = false;
  let acceptIncrease = false;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--root') {
      const value = args.shift();
      if (!value) throw new Error('function-complexity: --root requires a path');
      root = value;
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--accept-increase') {
      acceptIncrease = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'usage: node scripts/check-function-complexity.mjs [--root <repo-root>] [--write [--accept-increase]]\n',
      );
      return 0;
    } else {
      throw new Error(`function-complexity: unknown argument ${arg}`);
    }
  }
  if (acceptIncrease && !write)
    throw new Error('function-complexity: --accept-increase requires --write');

  const scan = scanFunctionComplexity(root);
  const baseline = readBaseline(root);
  if (write) {
    const next = nextBaseline(scan, baseline, { acceptIncrease });
    writeFileSync(resolve(root, BASELINE_PATH), serializeBaseline(next));
    process.stdout.write(`[function-complexity] wrote ${BASELINE_PATH} entries=${next.size}\n`);
    return formatReport(scan, compareWithBaseline(scan, next)).status;
  }
  const report = formatReport(scan, compareWithBaseline(scan, baseline));
  if (report.stdout) process.stdout.write(report.stdout);
  if (report.stderr) process.stderr.write(report.stderr);
  return report.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[function-complexity] setup error: ${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}
