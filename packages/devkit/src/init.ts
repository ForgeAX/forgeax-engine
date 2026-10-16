import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import devkitPackage from '../package.json' with { type: 'json' };
import type { SdkManifest } from './sdk.js';
import type { CommandResult, InitOptions, ProjectFacts } from './types.js';

// Vitest 4.1 adds a Vite peer chain that triggers npm 10 Arborist's
// `edgesOut` failure while installing the published SDK closure.
const sdkVitestVersion = devkitPackage.dependencies.vitest;

const STANDARD_SCRIPTS = {
  dev: 'forgeax dev start',
  build: 'forgeax project build',
  package: 'forgeax project package',
  serve: 'forgeax project preview',
  preview: 'forgeax project preview',
  doctor: 'forgeax project check',
  test: 'forgeax project test',
  typecheck: 'pnpm exec tsc --noEmit',
} as const;

const SDK_DEV_DEPENDENCIES = {
  '@types/node': '20.19.40',
  '@webgpu/types': '0.1.71',
  tsx: '4.23.1',
  typescript: '6.0.3',
  vitest: sdkVitestVersion,
} as const;

function isEnginePackage(name: string): boolean {
  return name === '@forgeax/engine' || name.startsWith('@forgeax/engine-');
}

export interface InitPlan {
  readonly root: string;
  readonly version: string;
  readonly pnpmVersion?: string;
  readonly archiveBacked: boolean;
  readonly dependencyChanges: readonly {
    readonly section: string;
    readonly name: string;
    readonly from?: string;
    readonly to: string;
  }[];
  readonly scriptChanges: readonly { readonly name: string; readonly to: string }[];
}

export function createInitPlan(
  facts: ProjectFacts,
  sdk?: Pick<SdkManifest, 'sdkVersion' | 'packages' | 'requirements'>,
): CommandResult<InitPlan> {
  const manifest = structuredClone(facts.packageJson) as Record<string, unknown>;
  const packageVersions = new Map(sdk?.packages.map((entry) => [entry.name, entry.version]));
  const devkitVersion = packageVersions.get('@forgeax/engine-devkit') ?? devkitPackage.version;
  const dependencyChanges: InitPlan['dependencyChanges'][number][] = [];
  if (sdk !== undefined) {
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const dependencies = manifest[section];
      if (dependencies === null || typeof dependencies !== 'object') continue;
      const unsupported = Object.keys(dependencies).filter(
        (name) => !isEnginePackage(name) && !(name in SDK_DEV_DEPENDENCIES),
      );
      if (unsupported.length > 0) {
        return {
          ok: false,
          error: {
            code: 'sdk-external-dependency-unsupported',
            expected: 'archive-backed init dependencies to belong to the SDK closure',
            hint: 'Remove the external dependency or use a network-backed package workflow explicitly.',
            detail: { root: facts.root, dependencies: unsupported.sort() },
          },
        };
      }
    }
  }
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[section];
    if (dependencies === null || typeof dependencies !== 'object') continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (isEnginePackage(name) && typeof value === 'string' && value.startsWith('workspace:')) {
        const version = packageVersions.get(name) ?? devkitVersion;
        dependencyChanges.push({ section, name, from: value, to: version });
      }
    }
  }
  if (sdk !== undefined) {
    const existingEngineNames = new Set(
      ['dependencies', 'devDependencies'].flatMap((section) => {
        const value = manifest[section];
        return value !== null && typeof value === 'object'
          ? Object.keys(value).filter((name) => isEnginePackage(name))
          : [];
      }),
    );
    for (const entry of sdk.packages) {
      if (entry.name === '@forgeax/engine-devkit' || existingEngineNames.has(entry.name)) continue;
      dependencyChanges.push({
        section: 'dependencies',
        name: entry.name,
        to: entry.version,
      });
    }
    const devDependencies =
      manifest.devDependencies !== null && typeof manifest.devDependencies === 'object'
        ? (manifest.devDependencies as Record<string, unknown>)
        : {};
    for (const [name, version] of Object.entries(SDK_DEV_DEPENDENCIES)) {
      if (devDependencies[name] === version) continue;
      dependencyChanges.push({
        section: 'devDependencies',
        name,
        ...(typeof devDependencies[name] === 'string' ? { from: devDependencies[name] } : {}),
        to: version,
      });
    }
  }
  const scriptsValue = manifest.scripts;
  const scripts =
    scriptsValue !== null && typeof scriptsValue === 'object'
      ? (scriptsValue as Record<string, unknown>)
      : {};
  const scriptChanges: InitPlan['scriptChanges'][number][] = [];
  for (const [name, command] of Object.entries(STANDARD_SCRIPTS)) {
    const existing = scripts[name];
    if (existing === undefined) scriptChanges.push({ name, to: command });
    else if (existing !== command) {
      return {
        ok: false,
        error: {
          code: 'project-script-conflict',
          expected: `package.json#scripts.${name} to be absent or ${JSON.stringify(command)}`,
          hint: `Rename the existing ${name} script, then rerun forgeax project init.`,
          detail: { root: facts.root, script: name, existing },
        },
      };
    }
  }
  const devDependencies = manifest.devDependencies;
  const existingDevkit =
    devDependencies !== null && typeof devDependencies === 'object'
      ? (devDependencies as Record<string, unknown>)['@forgeax/engine-devkit']
      : undefined;
  if (existingDevkit !== devkitVersion) {
    dependencyChanges.push({
      section: 'devDependencies',
      name: '@forgeax/engine-devkit',
      ...(typeof existingDevkit === 'string' ? { from: existingDevkit } : {}),
      to: devkitVersion,
    });
  }
  return {
    ok: true,
    value: {
      root: facts.root,
      version: sdk?.sdkVersion ?? devkitVersion,
      ...(sdk === undefined ? {} : { pnpmVersion: sdk.requirements.pnpm }),
      archiveBacked: sdk !== undefined,
      dependencyChanges,
      scriptChanges,
    },
  };
}

export async function applyInitPlan(
  facts: ProjectFacts,
  plan: InitPlan,
  options: InitOptions,
): Promise<CommandResult<InitPlan>> {
  if (options.dryRun === true) return { ok: true, value: plan };
  const manifest = structuredClone(facts.packageJson) as Record<string, unknown>;
  for (const change of plan.dependencyChanges) {
    const sectionValue = manifest[change.section];
    const section =
      sectionValue !== null && typeof sectionValue === 'object'
        ? (sectionValue as Record<string, unknown>)
        : {};
    section[change.name] = change.to;
    manifest[change.section] = section;
  }
  const scriptsValue = manifest.scripts;
  const scripts =
    scriptsValue !== null && typeof scriptsValue === 'object'
      ? (scriptsValue as Record<string, unknown>)
      : {};
  for (const change of plan.scriptChanges) scripts[change.name] = change.to;
  manifest.scripts = scripts;
  if (plan.archiveBacked) {
    if (plan.pnpmVersion === undefined) throw new Error('sdk-pnpm-version-missing');
    manifest.packageManager = `pnpm@${plan.pnpmVersion}`;
  }
  await writeFile(resolve(facts.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, value: plan };
}
