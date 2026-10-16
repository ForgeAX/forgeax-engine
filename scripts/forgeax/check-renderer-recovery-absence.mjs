#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECOVERY_SOURCE_FILES = Object.freeze([
  'packages/render/src/assembly/factory.ts',
  'packages/render/src/render-system.ts',
  'packages/render/src/assembly/recovery/generation.ts',
  'packages/render/src/assembly/recovery/recovery-attempt.ts',
  'packages/render/src/assembly/recovery/device-loss-fanout.ts',
  'packages/render/src/record/typed-frame-graph.ts',
  'packages/render/src/assembly/renderer-frame-transaction.ts',
  'packages/app/src/internal/frame-loop.ts',
  'packages/app/src/execution/engine-worker-runtime.ts',
]);

const RECOVERY_RULES = Object.freeze([
  {
    id: 'second-recovery-owner',
    severity: 'P0',
    description: 'Renderer recovery must not grow a second recovery manager.',
  },
  {
    id: 'global-gpu-ledger',
    severity: 'P1',
    description: 'GPU ownership must remain with producer roots and DeviceScope.',
  },
  {
    id: 'app-recovery-retry',
    severity: 'P1',
    description: 'App and Worker must not own an automatic recovery retry loop.',
  },
  {
    id: 'recovery-backend-switch',
    severity: 'P0',
    description: 'Recovery must reuse the selected backend pack.',
  },
  {
    id: 'raw-device-destroy',
    severity: 'P0',
    description: 'Recovery must not destroy the raw device.',
  },
  {
    id: 'recovery-specific-graph',
    severity: 'P1',
    description: 'Recovery must use the normal graph owner, not a second graph.',
  },
  {
    id: 'second-submit-path',
    severity: 'P1',
    description: 'Recovery must not introduce a second submit path.',
  },
  {
    id: 'recovery-early-active-swap',
    severity: 'P0',
    description: 'Active device-bound references may change only at candidate publication.',
  },
  {
    id: 'recovery-manual-cleanup',
    severity: 'P0',
    description: 'The old aggregate must retire through its owner boundary.',
  },
  {
    id: 'invalid-device-build',
    severity: 'P0',
    description: 'Recovery must not build device-bound work on a lost device.',
  },
]);

const sourcePatterns = Object.freeze([
  {
    ruleId: 'second-recovery-owner',
    expression:
      /\b(?:class\s+\w*RecoveryManager|new\s+\w*RecoveryManager|create\w*RecoveryManager|(?:recovery|recover)[A-Z]\w*Manager)\b/gu,
  },
  {
    ruleId: 'global-gpu-ledger',
    expression:
      /\b(?:global|shared|all)(?:Gpu|GPU)(?:Resource|Handle|Store)?(?:Ledger|Registry|Set|Map)\b|\b(?:gpu|GPU)(?:Resource|Handle)(?:Ledger|Registry)\b/gu,
  },
  {
    ruleId: 'app-recovery-retry',
    paths: new Set([
      'packages/app/src/internal/frame-loop.ts',
      'packages/app/src/execution/engine-worker-runtime.ts',
    ]),
    expression:
      /\b(?:renderer|this\.renderer|activeRenderer)\s*\.\s*recover\s*\(|\b(?:recoverRenderer|retryRecovery|recoveryRetry)\b/gu,
  },
  {
    ruleId: 'raw-device-destroy',
    expression: /\b(?:rawDevice|backendDevice|internals\.device|device)\s*\.\s*destroy\s*\(/gu,
  },
  {
    ruleId: 'recovery-specific-graph',
    expression:
      /\b(?:RecoveryGraph|recoveryGraph|buildRecoveryGraph|createRecoveryGraph|recoverGraph)\b/gu,
  },
  {
    ruleId: 'second-submit-path',
    expression:
      /\b(?:recovery|recover)[A-Za-z0-9_]*(?:Submit|submit)\b|\bsubmit(?:Recovery|Recovered|Replacement)\w*\b/gu,
  },
]);

function lineAndColumn(source, index) {
  const prefix = source.slice(0, index);
  const line = prefix.split('\n').length;
  const lineStart = prefix.lastIndexOf('\n') + 1;
  return { line, column: index - lineStart + 1 };
}

function maskNonCode(source) {
  const output = [...source];
  let mode = 'code';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (mode === 'line-comment') {
      if (character === '\n') mode = 'code';
      else output[index] = ' ';
      continue;
    }
    if (mode === 'block-comment') {
      if (character === '*' && next === '/') {
        output[index] = ' ';
        output[index + 1] = ' ';
        index += 1;
        mode = 'code';
      } else if (character !== '\n') {
        output[index] = ' ';
      }
      continue;
    }
    if (mode === 'quoted') {
      if (character === '\\') {
        if (character !== '\n') output[index] = ' ';
        if (index + 1 < source.length && source[index + 1] !== '\n') output[index + 1] = ' ';
        index += 1;
      } else if (character === quote) {
        output[index] = ' ';
        mode = 'code';
      } else if (character !== '\n') {
        output[index] = ' ';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      mode = 'line-comment';
    } else if (character === '/' && next === '*') {
      output[index] = ' ';
      output[index + 1] = ' ';
      index += 1;
      mode = 'block-comment';
    } else if (character === "'" || character === '"' || character === '`') {
      output[index] = ' ';
      quote = character;
      mode = 'quoted';
    }
  }
  return output.join('');
}

function findRecoverOnceSpan(_source, masked) {
  const start = masked.indexOf('async function recoverOnce');
  if (start < 0) return undefined;
  const open = masked.indexOf('{', start);
  if (open < 0) return undefined;
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === '{') depth += 1;
    if (masked[index] === '}') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return undefined;
}

function matchAt(source, ruleId, index, detail) {
  const position = lineAndColumn(source, index);
  return {
    ruleId,
    ...position,
    detail,
  };
}

function matchesInRange(source, masked, expression, ruleId, start = 0, end = masked.length) {
  const matches = [];
  const scoped = masked.slice(start, end);
  expression.lastIndex = 0;
  for (const match of scoped.matchAll(expression)) {
    const index = start + (match.index ?? 0);
    matches.push(matchAt(source, ruleId, index, match[0]));
  }
  return matches;
}

function scopedRecoveryMatches(source, masked, ruleId, expression) {
  const span = findRecoverOnceSpan(source, masked);
  return span === undefined
    ? []
    : matchesInRange(source, masked, expression, ruleId, span.start, span.end);
}

export function scanSource({ path, source }) {
  const masked = maskNonCode(source);
  const matches = [];
  for (const pattern of sourcePatterns) {
    if (pattern.paths !== undefined && !pattern.paths.has(path)) continue;
    matches.push(...matchesInRange(source, masked, pattern.expression, pattern.ruleId));
  }

  const earlySwap =
    /\b(?:internals\.(?:device|context)|activeDeviceScope|gpuStore|dynamicTextureStore)\s*=|\binternals\.context\s*\.\s*unconfigure\s*\(/gu;
  matches.push(...scopedRecoveryMatches(source, masked, 'recovery-early-active-swap', earlySwap));

  const backendSwitch =
    /\b(?:loadRhiPack|selectBackendForRecovery|switchBackend|setBackend)\s*\(/gu;
  matches.push(...scopedRecoveryMatches(source, masked, 'recovery-backend-switch', backendSwitch));

  const manualCleanup =
    /\b(?:previous|active)(?:GpuStore|DynamicTextureStore)\s*\.\s*destroyAll\s*\(|\brenderSystem\s*\.\s*(?:resetForRecover|disposeFrameState)\s*\(|\b(?:materialShaderPipelineCache|perShaderMaterialLayoutCache|group0ResourceLayouts|preparedMaterialPipelineLayoutCache|postProcessPipelineCache)\s*\.\s*clear\s*\(|\b(?:pipelineState|group0MaterialLayout|viewOnlyMaterialPipelineLayout)\s*=\s*(?:null|undefined)\b/gu;
  matches.push(...scopedRecoveryMatches(source, masked, 'recovery-manual-cleanup', manualCleanup));

  const invalidDeviceBuild =
    /\b(?:buildPipeline|prepareMaterialShaders|createRecoveryRoots)\s*\([^)]*\binternals\.device\b/gsu;
  matches.push(
    ...scopedRecoveryMatches(source, masked, 'invalid-device-build', invalidDeviceBuild),
  );

  return matches.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
}

function sourceShaFor(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

export function buildAbsenceReport({ root, sourceSha = sourceShaFor(root) } = {}) {
  const matches = [];
  const missingFiles = [];
  for (const path of RECOVERY_SOURCE_FILES) {
    const absolutePath = join(root, path);
    let source;
    try {
      source = readFileSync(absolutePath, 'utf8');
    } catch {
      missingFiles.push(path);
      continue;
    }
    for (const match of scanSource({ path, source })) matches.push({ path, ...match });
  }
  for (const path of missingFiles) {
    matches.push({
      path,
      ruleId: 'scope-missing',
      line: 1,
      column: 1,
      detail: 'recovery source surface is missing',
    });
  }
  const rules = [
    ...RECOVERY_RULES,
    {
      id: 'scope-missing',
      severity: 'P0',
      description: 'The declared recovery surface must remain auditable.',
    },
  ];
  return {
    schemaVersion: '1.0.0',
    reportKind: 'renderer-recovery-absence',
    sourceSha,
    status: matches.length === 0 ? 'passed' : 'blocked',
    scope: [...RECOVERY_SOURCE_FILES],
    rules,
    matches,
    packageBudget: {
      status: 'deferred',
      owner: 'DFR-01',
      reason: 'render-core package entropy is outside AC-20',
    },
  };
}

function parseArgs(argv) {
  const options = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = resolve(argv[++index]);
    else if (argument?.startsWith('--root='))
      options.root = resolve(argument.slice('--root='.length));
    else if (argument === '--output') options.output = resolve(argv[++index]);
    else if (argument?.startsWith('--output='))
      options.output = resolve(argument.slice('--output='.length));
    else if (argument === '--source-sha') options.sourceSha = argv[++index];
    else if (argument?.startsWith('--source-sha='))
      options.sourceSha = argument.slice('--source-sha='.length);
    else throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = buildAbsenceReport(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== undefined) writeFileSync(options.output, serialized);
    process.stdout.write(serialized);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `[renderer-recovery-absence] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
