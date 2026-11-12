import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GameProjectSchema } from '@forgeax/engine-project';
import { resolveAssetLibraries } from './asset-libraries.js';
import type { CommandError, CommandResult, ProjectFacts } from './types.js';

function projectError(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export function isValidStartupTimeoutMs(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= 2_147_483_647)
  );
}

function timeoutFromPackage(
  root: string,
  packageJson: Record<string, unknown>,
  key: 'startupTimeoutMs' | 'frameTimeoutMs' = 'startupTimeoutMs',
): CommandResult<ProjectFacts['startupTimeoutMs']> {
  const forgeax = packageJson.forgeax;
  const forgeaxConfig =
    forgeax !== null && typeof forgeax === 'object' && !Array.isArray(forgeax)
      ? (forgeax as Record<string, unknown>)
      : undefined;
  const timeoutMs = forgeaxConfig?.[key];
  if (timeoutMs !== undefined && !isValidStartupTimeoutMs(timeoutMs)) {
    return projectError(
      'package-manifest-invalid',
      `package.json#forgeax.${key} to be a positive timer-safe integer or null`,
      `Set a positive millisecond value or null to disable ${key} deadlines.`,
      { root, [key]: timeoutMs },
    );
  }
  return {
    ok: true,
    value: timeoutMs as ProjectFacts['startupTimeoutMs'],
  };
}

/**
 * `package.json#forgeax.pointShadows: true` compiles the Standard shaders with
 * the point-shadow cube-array lane, so `PointLightShadow` casters render in
 * DevKit dev and production builds. Omitted or false keeps the smaller default
 * shader build.
 */
function pointShadowsFromPackage(
  root: string,
  packageJson: Record<string, unknown>,
): CommandResult<{ readonly pointShadows?: true }> {
  const forgeax = packageJson.forgeax;
  const value =
    forgeax !== null && typeof forgeax === 'object' && !Array.isArray(forgeax)
      ? (forgeax as Record<string, unknown>).pointShadows
      : undefined;
  if (value !== undefined && typeof value !== 'boolean') {
    return projectError(
      'package-manifest-invalid',
      'package.json#forgeax.pointShadows to be a boolean',
      'Set true to build point-light shadow shaders, or remove the field.',
      { root, pointShadows: value },
    );
  }
  return { ok: true, value: value === true ? { pointShadows: true } : {} };
}

/** Read the shared project startup policy without requiring a forge.json project. */
export async function readProjectStartupTimeoutMs(
  rootInput = process.cwd(),
): Promise<CommandResult<ProjectFacts['startupTimeoutMs']>> {
  const root = resolve(rootInput);
  let packageValue: unknown;
  try {
    packageValue = await readJson(resolve(root, 'package.json'));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: undefined };
    return projectError(
      'package-manifest-unreadable',
      'readable package.json',
      'Repair package.json before starting the Engine backend.',
      { root, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (packageValue === null || typeof packageValue !== 'object' || Array.isArray(packageValue)) {
    return projectError(
      'package-manifest-invalid',
      'package.json to contain an object',
      'Repair package.json before starting the Engine backend.',
      { root },
    );
  }
  return timeoutFromPackage(root, packageValue as Record<string, unknown>);
}

export async function readProjectFacts(
  rootInput = process.cwd(),
): Promise<CommandResult<ProjectFacts>> {
  const requestedRoot = resolve(rootInput);
  // All generated Vite entries, filesystem allow-lists and output URLs must
  // share one identity. A symlink such as /tmp -> /private/tmp otherwise
  // makes Vite resolve the input from one path while the generated host uses
  // the other and can emit an invalid relative filename.
  let root = requestedRoot;
  try {
    root = await realpath(requestedRoot);
  } catch {
    // Preserve the requested path so the existing manifest-unreadable error
    // identifies the path the caller supplied.
  }
  let forgeValue: unknown;
  let packageValue: unknown;
  try {
    [forgeValue, packageValue] = await Promise.all([
      readJson(resolve(root, 'forge.json')),
      readJson(resolve(root, 'package.json')),
    ]);
  } catch (cause) {
    return projectError(
      'project-manifest-unreadable',
      'readable forge.json and package.json files',
      'Run the command from a ForgeAX game root or pass its directory.',
      { root, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (forgeValue === null || typeof forgeValue !== 'object') {
    return projectError(
      'project-manifest-invalid',
      'forge.json to contain an object',
      'Repair forge.json before running DevKit.',
      { root },
    );
  }
  if (packageValue === null || typeof packageValue !== 'object') {
    return projectError(
      'package-manifest-invalid',
      'package.json to contain an object',
      'Repair package.json before running DevKit.',
      { root },
    );
  }
  const parsedForge = GameProjectSchema.safeParse(forgeValue);
  if (!parsedForge.success) {
    return projectError(
      'project-manifest-invalid',
      'forge.json to satisfy @forgeax/engine-project GameProjectSchema',
      'Repair the fields reported by the authoritative project schema.',
      { root, issues: parsedForge.error.issues },
    );
  }
  const forge = parsedForge.data;
  if (forge.id.length === 0 || forge.name.length === 0) {
    return projectError(
      'project-manifest-invalid',
      'forge.json to declare id and name',
      'Restore the project identity in the authoritative project manifest.',
      { root },
    );
  }
  const packageJson = packageValue as Record<string, unknown>;
  const startup = timeoutFromPackage(root, packageJson);
  if (!startup.ok) return startup;
  const frame = timeoutFromPackage(root, packageJson, 'frameTimeoutMs');
  if (!frame.ok) return frame;
  const shaders = pointShadowsFromPackage(root, packageJson);
  if (!shaders.ok) return shaders;
  const assetLibraries = await resolveAssetLibraries(root, forge.assetLibraries);
  if (!assetLibraries.ok) return assetLibraries;
  return {
    ok: true,
    value: {
      root,
      id: forge.id,
      name: forge.name,
      roots: forge.roots,
      ...(startup.value === undefined ? {} : { startupTimeoutMs: startup.value }),
      ...(frame.value === undefined ? {} : { frameTimeoutMs: frame.value }),
      ...shaders.value,
      assetRoots: forge.assetRoots,
      assetLibraries: assetLibraries.value,
      packageJson,
    },
  };
}

/** Follow structured native error envelopes; never recover fields from message text. */
function ownerFailures(cause: unknown, seen = new Set<object>()): CommandError[] {
  if (cause === null || typeof cause !== 'object' || seen.has(cause)) return [];
  seen.add(cause);
  const value = cause as Record<string, unknown>;
  const fields =
    typeof value.expected === 'string' && typeof value.hint === 'string'
      ? value
      : value.meta !== null && typeof value.meta === 'object'
        ? (value.meta as Record<string, unknown>)
        : undefined;
  if (
    typeof value.code === 'string' &&
    fields !== undefined &&
    typeof fields.expected === 'string' &&
    typeof fields.hint === 'string'
  ) {
    if (fields === value && typeof value.pluginCode !== 'string' && 'detail' in value)
      return [cause as CommandError];
    return [
      {
        code: typeof value.pluginCode === 'string' ? value.pluginCode : value.code,
        expected: fields.expected,
        hint: fields.hint,
        detail:
          fields.detail !== null && typeof fields.detail === 'object'
            ? (fields.detail as Record<string, unknown>)
            : {},
      },
    ];
  }
  return [
    ...(Array.isArray(value.errors)
      ? value.errors.flatMap((error) => ownerFailures(error, seen))
      : []),
    ...ownerFailures(value.cause, seen),
  ];
}

export function commandError(cause: unknown, fallbackCode: string): CommandError {
  const failures = ownerFailures(cause);
  const [first] = failures;
  if (failures.length === 1 && first !== undefined) return first;
  return {
    code: fallbackCode,
    expected: 'the ForgeAX command to complete',
    hint: 'Inspect the underlying diagnostic and repair the owning input.',
    detail: {
      ...(failures.length === 0 ? {} : { failures }),
      reason:
        cause !== null &&
        typeof cause === 'object' &&
        'message' in cause &&
        typeof cause.message === 'string'
          ? cause.message
          : String(cause),
    },
  };
}
