import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { UnifiedCliResult } from './unified-cli.js';

/**
 * Compact CLI presentation. Agents re-read every CLI result on each later turn,
 * so the default process output keeps decision-relevant facts and counts; the
 * owners' full values stay available through `--detail` and through
 * `runUnifiedCli` for programmatic callers.
 */
const DETAIL_FLAG = '--detail';

export interface CliPresentationContext {
  readonly root: string;
  /** Final command arguments, after flag coercion or `--input`. */
  readonly args: unknown;
  readonly tree: boolean;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const LARGEST_ARTIFACTS = 3;
const ATTENTION_ASSETS = 20;
const LIVE_STATUS_COMMANDS = new Set(['dev start', 'dev status', 'dev reload', 'dev stop']);

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relativeTo(root: string, path: unknown): unknown {
  if (typeof path !== 'string' || !isAbsolute(path)) return path;
  const local = relative(root, path);
  return local.startsWith('..') || isAbsolute(local) ? path : local;
}

function withOmitted(
  result: UnifiedCliResult,
  value: unknown,
  fields: readonly string[],
): UnifiedCliResult {
  return { ...result, value, omitted: { fields, flag: DETAIL_FLAG } };
}

/** Build owners resolve the project root; report the same physical path. */
function physicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function buildEntry(target: unknown): string {
  return target === 'wechat' ? 'game.js' : target === 'tauri' ? 'web/index.html' : 'index.html';
}

function compactBuild(result: UnifiedCliResult, context: CliPresentationContext): UnifiedCliResult {
  const value = result.value;
  if (!isRecord(value) || !Array.isArray(value.artifacts)) return result;
  const { artifacts, ...manifest } = value;
  const sized = artifacts.filter(
    (entry): entry is { readonly path: string; readonly bytes: number } =>
      isRecord(entry) && typeof entry.path === 'string' && typeof entry.bytes === 'number',
  );
  const args = isRecord(context.args) ? context.args : {};
  const root = typeof args.root === 'string' ? resolve(args.root) : resolve(context.root);
  const outDir = resolve(root, typeof args.outDir === 'string' ? args.outDir : 'dist');
  return withOmitted(
    result,
    {
      ...manifest,
      manifestPath: resolve(physicalPath(outDir), 'forgeax-dist.json'),
      entry: buildEntry(manifest.target),
      artifactCount: artifacts.length,
      artifactBytes: sized.reduce((total, entry) => total + entry.bytes, 0),
      largestArtifacts: [...sized]
        .sort((left, right) => right.bytes - left.bytes)
        .slice(0, LARGEST_ARTIFACTS)
        .map(({ path, bytes }) => ({ path, bytes })),
    },
    ['value.artifacts'],
  );
}

function enabledWorkers(workers: unknown): unknown {
  if (!isRecord(workers)) return workers;
  return Object.fromEntries(
    // An enabled Worker is one bit; a disabled one keeps its reason and gaps.
    Object.entries(workers).map(([name, selection]) => [
      name,
      isRecord(selection) && selection.enabled === true ? true : selection,
    ]),
  );
}

function p95(measurement: unknown): number | null {
  if (!isRecord(measurement) || typeof measurement.p95 !== 'number') return null;
  return Math.round(measurement.p95 * 100) / 100;
}

function compactExecution(execution: JsonRecord): JsonRecord {
  const engine = isRecord(execution.engine) ? execution.engine : {};
  const world = isRecord(execution.world) ? execution.world : {};
  const frame = isRecord(execution.frame) ? execution.frame : {};
  const render = isRecord(execution.render) ? execution.render : undefined;
  const performance = isRecord(execution.performance) ? execution.performance : {};
  return {
    engine: engine.health,
    world: world.health,
    worldIdentity: world.identity,
    ...(world.partialWrite === true ? { partialWrite: true } : {}),
    ...(render === undefined ? {} : { render: render.state }),
    frames: frame.completed,
    hostFrameP95Ms: p95(performance.hostFrameMs),
    engineUpdateP95Ms: p95(performance.engineUpdateMs),
    fault: execution.fault ?? null,
  };
}

function compactLiveStatus(result: UnifiedCliResult): UnifiedCliResult {
  const value = result.value;
  if (!isRecord(value) || (value.execution === undefined && value.workers === undefined))
    return result;
  const { execution, workers, ...status } = value;
  return withOmitted(
    result,
    {
      ...status,
      ...(workers === undefined ? {} : { workers: enabledWorkers(workers) }),
      ...(isRecord(execution) ? { execution: compactExecution(execution) } : {}),
    },
    [
      ...(workers === undefined ? [] : ['value.workers']),
      ...(execution === undefined ? [] : ['value.execution']),
    ],
  );
}

function compactCheck(result: UnifiedCliResult): UnifiedCliResult {
  const value = result.value;
  if (!isRecord(value) || !isRecord(value.uiAuthoringProfile)) return result;
  const { uiAuthoringProfile, ...facts } = value;
  return withOmitted(result, { ...facts, uiAuthoringProfileVersion: uiAuthoringProfile.version }, [
    'value.uiAuthoringProfile',
  ]);
}

/** Every asset whose output is not produced and available, e.g. before a build. */
function needsAttention(asset: unknown): boolean {
  if (!isRecord(asset) || !isRecord(asset.output)) return true;
  return asset.output.status !== 'produced' || asset.output.availability !== 'available';
}

function compactVerify(result: UnifiedCliResult): UnifiedCliResult {
  const value = result.value;
  if (
    !isRecord(value) ||
    value.schemaVersion !== 'asset-verification-v1' ||
    !Array.isArray(value.assets) ||
    !isRecord(value.scope)
  )
    return result;
  const root = typeof value.root === 'string' ? value.root : '';
  const { assets, scope, ...report } = value;
  const { sourcePaths: _paths, scriptablePackSources: _sources, ...scopeCounts } = scope;
  const attention = assets.filter(needsAttention);
  return withOmitted(
    result,
    {
      ...report,
      scope: scopeCounts,
      attention: attention.slice(0, ATTENTION_ASSETS).map((asset) => {
        const record = isRecord(asset) ? asset : {};
        const source = isRecord(record.source) ? record.source : {};
        const output = isRecord(record.output) ? record.output : {};
        return {
          guid: record.guid,
          type: record.type,
          source: relativeTo(root, source.path),
          status: output.status,
          availability: output.availability,
        };
      }),
      ...(attention.length > ATTENTION_ASSETS
        ? { omittedAttentionCount: attention.length - ATTENTION_ASSETS }
        : {}),
    },
    ['value.assets', 'value.scope.sourcePaths', 'value.scope.scriptablePackSources'],
  );
}

interface HelpNode {
  readonly name: string;
  readonly summary?: string;
  readonly children?: readonly HelpNode[];
  readonly leaf?: unknown;
}

/** A tree keeps names and leaf purposes; paths derive from nesting and group
 *  summaries only echo an arbitrary descendant. */
function compactHelpNode(node: HelpNode): HelpNode {
  if (node.children === undefined) return { name: node.name, summary: node.summary ?? '' };
  return { name: node.name, children: node.children.map(compactHelpNode) };
}

function compactHelpTree(result: UnifiedCliResult): UnifiedCliResult {
  const value = result.value;
  if (!isRecord(value) || !Array.isArray(value.nodes) || value.leaf !== undefined) return result;
  return withOmitted(
    result,
    { ...value, nodes: (value.nodes as readonly HelpNode[]).map(compactHelpNode) },
    ['value.nodes[].path', 'value.nodes[].summary (groups)'],
  );
}

export function compactCliResult(
  result: UnifiedCliResult,
  context: CliPresentationContext,
): UnifiedCliResult {
  if (!result.ok || result.command === undefined) return result;
  if (context.tree && Array.isArray(isRecord(result.value) ? result.value.nodes : undefined))
    return compactHelpTree(result);
  if (result.command === 'project build') return compactBuild(result, context);
  if (result.command === 'project check') return compactCheck(result);
  if (result.command === 'asset verify') return compactVerify(result);
  if (LIVE_STATUS_COMMANDS.has(result.command)) return compactLiveStatus(result);
  return result;
}
