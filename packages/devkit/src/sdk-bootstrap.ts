import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { execFileCommand } from './child-process.js';
import type { SdkContext } from './sdk.js';
import type { CommandResult } from './types.js';
import { failCommand } from './types.js';

const SDK_TOOL_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const;
const SDK_INIT_PATH = ['.forgeax', 'sdk-init.json'] as const;
const SDK_INIT_SCHEMA_VERSION = '2.0.0' as const;

interface SdkInitState {
  readonly schemaVersion: typeof SDK_INIT_SCHEMA_VERSION;
  readonly sdkVersion: string;
  readonly engineCommit: string;
  readonly toolInputsDigest: string;
  readonly pnpm: string;
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

interface SdkInitReport extends SdkInitState {
  readonly root: string;
  readonly store: 'offline' | 'registry';
  readonly onboarding: AgentOnboarding;
}

interface AgentOnboarding {
  readonly read: readonly string[];
  readonly templateSelection?: {
    readonly required: true;
    readonly available: readonly string[];
  };
  readonly next?: {
    readonly cwd: string;
    readonly argv: readonly string[];
  };
}

export function agentOnboarding(sdk: SdkContext, projectRoot?: string): AgentOnboarding {
  const root = projectRoot ?? sdk.root;
  return {
    read: [resolve(root, 'AGENTS.md'), resolve(root, 'skills', 'forgeax-engine-sdk', 'SKILL.md')],
    ...(projectRoot === undefined
      ? {
          templateSelection: {
            required: true as const,
            available: [...sdk.templates.keys()].sort(),
          },
        }
      : {}),
    ...(projectRoot === undefined
      ? {}
      : { next: { cwd: root, argv: ['pnpm', 'exec', 'forgeax', 'help', '--tree', '--json'] } }),
  };
}

function sdkInitPath(sdk: SdkContext): string {
  return resolve(sdk.root, ...SDK_INIT_PATH);
}

export function sdkProjectInstallArgs(store: string | undefined): string[] {
  return sdkInstallArgs(store, true);
}

function sdkInstallArgs(store: string | undefined, ignoreScripts = false): string[] {
  const args = ['install', '--frozen-lockfile'];
  if (ignoreScripts)
    args.push('--ignore-scripts', '--side-effects-cache=true', '--child-concurrency=1');
  else args.push('--child-concurrency=1', '--side-effects-cache=true');
  if (store !== undefined)
    args.push('--offline', '--config.trust-lockfile=true', '--store-dir', store);
  return args;
}

/** pnpm writes the project graph last, after any separate environment graph. */
export function parsePnpmLockDocuments(text: string) {
  const documents = parseAllDocuments(text);
  for (const document of documents) {
    if (document.errors.length > 0) throw document.errors[0];
  }
  return documents;
}

export const MINIMUM_SUPPORTED_PNPM = '12.15.0';

export function pnpmVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string): [number, number, number] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const actual = parse(version);
  const required = parse(minimum);
  if (actual === undefined || required === undefined) return false;
  const [actualMajor, actualMinor, actualPatch] = actual;
  const [requiredMajor, requiredMinor, requiredPatch] = required;
  if (actualMajor !== requiredMajor) return false;
  if (actualMinor !== requiredMinor) return actualMinor > requiredMinor;
  return actualPatch >= requiredPatch;
}

export function sdkPnpmRequirement(minimum: string): string {
  const major = Number(minimum.split('.')[0]);
  return `>=${minimum} <${major + 1}`;
}

export async function readPnpmVersion(cwd?: string, packageManager?: unknown): Promise<string> {
  if (typeof packageManager === 'string' && packageManager.startsWith('pnpm@')) {
    try {
      return (await execFileCommand('corepack', ['pnpm', '--version'], { cwd })).stdout.trim();
    } catch {
      // Corepack is optional. Report the pnpm version available directly.
    }
  }
  return (
    await execFileCommand('pnpm', ['--version'], { cwd, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}

function matchesState(sdk: SdkContext, state: unknown, digest: string): state is SdkInitState {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  return (
    value.schemaVersion === SDK_INIT_SCHEMA_VERSION &&
    value.sdkVersion === sdk.manifest.sdkVersion &&
    value.engineCommit === sdk.manifest.engineCommit &&
    value.toolInputsDigest === digest &&
    typeof value.pnpm === 'string' &&
    pnpmVersionAtLeast(value.pnpm, sdk.manifest.requirements.pnpm) &&
    value.node === process.versions.node &&
    value.platform === process.platform &&
    value.arch === process.arch
  );
}

async function toolRuntimeReady(sdk: SdkContext): Promise<boolean> {
  const runtime = resolve(sdk.root, '.forgeax/cli-runtime');
  await access(resolve(runtime, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs'));
  await access(resolve(runtime, 'node_modules/@forgeax/view/host.pack.json'));
  await access(
    createRequire(resolve(runtime, 'package.json')).resolve('@forgeax/view/host.pack.json'),
  );
  for (const name of SDK_TOOL_INPUTS) {
    if (
      !(await readFile(resolve(runtime, name))).equals(
        await readFile(resolve(sdk.root, 'toolchain/cli-runtime', name)),
      )
    )
      return false;
  }
  return true;
}

async function readSdkInitState(sdk: SdkContext): Promise<SdkInitState | undefined> {
  try {
    const value = JSON.parse(await readFile(sdkInitPath(sdk), 'utf8')) as unknown;
    const digest = await toolInputsDigest(sdk);
    if (!matchesState(sdk, value, digest)) return undefined;
    if (!(await toolRuntimeReady(sdk))) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export async function requireSdkInitialization(
  sdk: SdkContext,
): Promise<CommandResult<SdkInitState>> {
  const state = await readSdkInitState(sdk);
  if (state === undefined) {
    return failCommand(
      'sdk-not-initialized',
      'the downloaded SDK to be initialized for this Node/pnpm/platform tuple',
      'Run ./bin/forgeax project init from the SDK root once, then run forgeax project new outside the SDK.',
      {
        sdkRoot: sdk.root,
        sdkVersion: sdk.manifest.sdkVersion,
        pnpm: sdk.manifest.requirements.pnpm,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
    );
  }
  return { ok: true, value: state };
}

async function toolInputsDigest(sdk: SdkContext): Promise<string> {
  const hash = createHash('sha256');
  for (const name of SDK_TOOL_INPUTS)
    hash.update(await readFile(resolve(sdk.root, 'toolchain/cli-runtime', name)));
  return hash.digest('hex');
}

async function copyBootstrapInputs(sdk: SdkContext, root: string): Promise<void> {
  const template = resolve(sdk.root, 'toolchain/cli-runtime');
  for (const name of SDK_TOOL_INPUTS) {
    await cp(resolve(template, name), resolve(root, name));
  }
  try {
    await cp(resolve(template, '.npmrc'), resolve(root, '.npmrc'));
  } catch (cause) {
    if (
      cause === null ||
      typeof cause !== 'object' ||
      !('code' in cause) ||
      cause.code !== 'ENOENT'
    ) {
      throw cause;
    }
  }
}

export async function sdkInitCommand(
  sdk: SdkContext,
  options: { readonly dryRun?: boolean; readonly install?: boolean } = {},
): Promise<CommandResult<SdkInitReport>> {
  let pnpm: string;
  try {
    pnpm = await readPnpmVersion();
    if (!pnpm) throw new Error('pnpm returned an empty version');
  } catch (cause) {
    return failCommand(
      'pnpm-unavailable',
      `pnpm ${sdkPnpmRequirement(MINIMUM_SUPPORTED_PNPM)} to be available on PATH`,
      `Install or activate pnpm ${MINIMUM_SUPPORTED_PNPM} or newer in the pnpm 12 line, then rerun forgeax project init from the SDK root.`,
      { reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (!pnpmVersionAtLeast(pnpm, sdk.manifest.requirements.pnpm)) {
    return failCommand(
      'pnpm-version-unsupported',
      `pnpm ${sdkPnpmRequirement(sdk.manifest.requirements.pnpm)}`,
      `Activate pnpm ${sdk.manifest.requirements.pnpm} or newer in the pnpm ${sdk.manifest.requirements.pnpm.split('.')[0]} line, then rerun forgeax project init.`,
      { actual: pnpm, expected: sdk.manifest.requirements.pnpm },
    );
  }
  let digest: string;
  try {
    digest = await toolInputsDigest(sdk);
  } catch (cause) {
    return failCommand(
      'sdk-init-failed',
      'the SDK toolchain inputs to exist',
      'Download a complete SDK archive, then rerun project init.',
      { reason: String(cause), sdkRoot: sdk.root },
    );
  }
  const state: SdkInitState = {
    schemaVersion: SDK_INIT_SCHEMA_VERSION,
    sdkVersion: sdk.manifest.sdkVersion,
    engineCommit: sdk.manifest.engineCommit,
    toolInputsDigest: digest,
    pnpm,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
  const report: SdkInitReport = {
    ...state,
    root: sdk.root,
    store: sdk.store === undefined ? 'registry' : 'offline',
    onboarding: agentOnboarding(sdk),
  };
  if (options.dryRun === true || options.install === false) return { ok: true, value: report };

  const staging = resolve(sdk.root, '.forgeax/cli-runtime');
  try {
    await mkdir(staging, { recursive: true });
    await copyBootstrapInputs(sdk, staging);
    await execFileCommand('pnpm', sdkInstallArgs(sdk.store), {
      cwd: staging,
      env: { ...process.env, CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (!(await toolRuntimeReady(sdk))) throw new Error('sdk-tool-runtime-incomplete');
    await mkdir(resolve(sdk.root, '.forgeax'), { recursive: true });
    await writeFile(sdkInitPath(sdk), `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true, value: report };
  } catch (cause) {
    return failCommand(
      'sdk-init-failed',
      'the SDK dependency closure to install and build native packages successfully',
      'Inspect the pnpm output, repair Node/pnpm or platform permissions, then rerun forgeax project init from the SDK root.',
      { reason: cause instanceof Error ? cause.message : String(cause), sdkRoot: sdk.root },
    );
  }
}
