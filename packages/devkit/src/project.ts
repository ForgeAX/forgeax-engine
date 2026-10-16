import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GameProjectSchema } from '@forgeax/engine-project';
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

function startupTimeoutFromPackage(
  root: string,
  packageJson: Record<string, unknown>,
): CommandResult<ProjectFacts['startupTimeoutMs']> {
  const forgeax = packageJson.forgeax;
  const forgeaxConfig =
    forgeax !== null && typeof forgeax === 'object' && !Array.isArray(forgeax)
      ? (forgeax as Record<string, unknown>)
      : undefined;
  const startupTimeoutMs = forgeaxConfig?.startupTimeoutMs;
  if (startupTimeoutMs !== undefined && !isValidStartupTimeoutMs(startupTimeoutMs)) {
    return projectError(
      'package-manifest-invalid',
      'package.json#forgeax.startupTimeoutMs to be a positive timer-safe integer or null',
      'Set a positive millisecond value or null to disable startup deadlines.',
      { root, startupTimeoutMs },
    );
  }
  return {
    ok: true,
    value: startupTimeoutMs as ProjectFacts['startupTimeoutMs'],
  };
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
  return startupTimeoutFromPackage(root, packageValue as Record<string, unknown>);
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
      'Run the command from a ForgeaX game root or pass its directory.',
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
  const startup = startupTimeoutFromPackage(root, packageJson);
  if (!startup.ok) return startup;
  return {
    ok: true,
    value: {
      root,
      id: forge.id,
      name: forge.name,
      roots: forge.roots,
      ...(startup.value === undefined ? {} : { startupTimeoutMs: startup.value }),
      assetRoots: ['assets'],
      packageJson,
    },
  };
}

export function commandError(cause: unknown, fallbackCode: string): CommandError {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    'expected' in cause &&
    'hint' in cause &&
    'detail' in cause
  ) {
    return cause as CommandError;
  }
  return {
    code: fallbackCode,
    expected: 'the ForgeaX command to complete',
    hint: 'Inspect the underlying diagnostic and repair the owning input.',
    detail: { reason: cause instanceof Error ? cause.message : String(cause) },
  };
}
