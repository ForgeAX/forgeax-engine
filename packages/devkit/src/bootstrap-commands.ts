import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { UI_AUTHORING_PROFILE, type UiAuthoringProfile } from '@forgeax/engine-ui/authoring';
import { parseDocument } from 'yaml';
import { execFileCommand } from './child-process.js';
import { engineDoctorCommand, readEngineBinding } from './engine-binding.js';
import { isFilesystemPathWithin } from './filesystem-path.js';
import { applyInitPlan, createInitPlan } from './init.js';
import { commandError, readProjectFacts } from './project.js';
import { inspectRunDependencyClosure } from './run-snapshot.js';
import { findSdkContext } from './sdk.js';
import {
  agentOnboarding,
  MINIMUM_SUPPORTED_PNPM,
  pnpmVersionAtLeast,
  requireSdkInitialization,
  sdkInitCommand,
  sdkProjectInstallArgs,
} from './sdk-bootstrap.js';
import { checkSdkUpdate } from './sdk-update.js';
import { copySdkSkills, installProjectSkills, PROJECT_SKILL_MOUNT_ROOTS } from './skill-install.js';
import {
  readTemplateDescriptor,
  resolveProjectIdentity,
  writeProjectIdentity,
} from './templates/materialize.js';
import type { CommandResult, InitOptions, NewOptions, ProjectCommandOptions } from './types.js';

function isMissingPathError(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse());
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
      const parent = dirname(cursor);
      if (parent === cursor) throw cause;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function configureSdkStore(root: string, store: string | undefined): Promise<void> {
  if (store === undefined) return;
  const path = resolve(root, 'pnpm-workspace.yaml');
  const settings = parseDocument(await readFile(path, 'utf8'));
  if (settings.errors.length > 0) throw settings.errors[0];
  settings.set('storeDir', store);
  await writeFile(path, settings.toString());
}

export interface DoctorReport {
  readonly root: string;
  readonly projectId: string;
  readonly node: string;
  readonly pnpm: string;
  readonly workspaceDependencies: readonly string[];
  readonly uiAuthoringProfile: UiAuthoringProfile;
}

function nodeSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

async function readPnpmVersion(
  root: string,
  packageJson: Record<string, unknown>,
): Promise<string> {
  const packageManager = packageJson.packageManager;
  if (typeof packageManager === 'string' && packageManager.startsWith('pnpm@')) {
    try {
      return (
        await execFileCommand('corepack', ['pnpm', '--version'], { cwd: root })
      ).stdout.trim();
    } catch {
      // Corepack is optional on some installations. Preserve the plain pnpm
      // fallback while allowing the doctor result to report its actual version.
    }
  }
  return (await execFileCommand('pnpm', ['--version'], { cwd: root })).stdout.trim();
}

export async function doctorCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<DoctorReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  let pnpm: string;
  try {
    pnpm = await readPnpmVersion(facts.value.root, facts.value.packageJson);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'pnpm-unavailable',
        expected: 'pnpm to be available on PATH',
        hint: 'Install the SDK-supported pnpm version and retry.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
  if (!nodeSupported()) {
    return {
      ok: false,
      error: {
        code: 'node-version-unsupported',
        expected: 'Node.js >=22.13.0',
        hint: 'Select a supported Node.js installation and retry.',
        detail: { actual: process.versions.node },
      },
    };
  }
  if (!pnpmVersionAtLeast(pnpm, MINIMUM_SUPPORTED_PNPM)) {
    return {
      ok: false,
      error: {
        code: 'pnpm-version-unsupported',
        expected: `pnpm >=${MINIMUM_SUPPORTED_PNPM} <13`,
        hint: 'Enable the packageManager-declared pnpm version with Corepack and retry.',
        detail: { actual: pnpm },
      },
    };
  }
  const workspaceDependencies = new Set<string>();
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const value = facts.value.packageJson[section];
    if (value === null || typeof value !== 'object') continue;
    for (const [name, version] of Object.entries(value)) {
      if (
        typeof version === 'string' &&
        (version.startsWith('workspace:') || version.startsWith('file:'))
      ) {
        workspaceDependencies.add(name);
      }
    }
  }
  const localDependencies = [...workspaceDependencies].sort();
  const binding = await readEngineBinding(facts.value.root);
  if (!binding.ok) return binding;
  let engineDigest: string | undefined;
  if (binding.value !== null) {
    const engine = await engineDoctorCommand({ root: facts.value.root });
    if (!engine.ok) return engine;
    if (
      engine.value.mode !== 'local' ||
      engine.value.binding === null ||
      resolve(engine.value.binding.path) !== resolve(binding.value.path) ||
      engine.value.workspace === null
    )
      return {
        ok: false,
        error: {
          code: 'project-engine-binding-changed',
          expected: 'the same healthy local Engine binding to remain selected during doctor',
          hint: 'Recheck the project Engine binding and retry doctor.',
          detail: { binding: binding.value.path, mode: engine.value.mode },
        },
      };
    engineDigest = engine.value.workspace.digest;
  }
  if (binding.value !== null || localDependencies.length > 0) {
    try {
      await inspectRunDependencyClosure(facts.value.root, binding.value, engineDigest, pnpm);
    } catch (cause) {
      return { ok: false, error: commandError(cause, 'project-dependency-closure-invalid') };
    }
  }
  return {
    ok: true,
    value: {
      root: facts.value.root,
      projectId: facts.value.id,
      node: process.versions.node,
      pnpm,
      workspaceDependencies: localDependencies,
      uiAuthoringProfile: UI_AUTHORING_PROFILE,
    },
  };
}

export async function initCommand(options: InitOptions = {}): Promise<CommandResult<unknown>> {
  try {
    const sdk = await findSdkContext();
    const root = await canonicalProspectivePath(options.root ?? process.cwd());
    if (sdk !== undefined && root === (await canonicalProspectivePath(sdk.root))) {
      return sdkInitCommand(sdk, options);
    }
    const facts = await readProjectFacts(root);
    if (!facts.ok) return facts;
    const plan = createInitPlan(facts.value, sdk?.manifest);
    if (!plan.ok) return plan;
    if (sdk !== undefined && options.dryRun !== true) {
      const initialized = await requireSdkInitialization(sdk);
      if (!initialized.ok) return initialized;
    }
    const applied = await applyInitPlan(facts.value, plan.value, options);
    if (!applied.ok || options.dryRun === true) return applied;
    if (sdk !== undefined) {
      const template = sdk.templates.get('empty');
      if (template === undefined) throw new Error('sdk-bootstrap-template-missing');
      await copyFile(
        resolve(template, 'pnpm-lock.yaml'),
        resolve(facts.value.root, 'pnpm-lock.yaml'),
      );
      await copyFile(
        resolve(template, 'pnpm-workspace.yaml'),
        resolve(facts.value.root, 'pnpm-workspace.yaml'),
      );
      try {
        await readFile(resolve(facts.value.root, '.npmrc'), 'utf8');
      } catch (cause) {
        if (!isMissingPathError(cause)) throw cause;
        try {
          await copyFile(resolve(template, '.npmrc'), resolve(facts.value.root, '.npmrc'));
        } catch (templateCause) {
          if (!isMissingPathError(templateCause)) throw templateCause;
        }
      }
      await copySdkSkills(sdk, facts.value.root);
      await installProjectSkills(facts.value.root, sdk.manifest);
      await configureSdkStore(
        facts.value.root,
        sdk.store === undefined ? undefined : await canonicalProspectivePath(sdk.store),
      );
    }
    if (options.install === false) return applied;
    const store =
      sdk === undefined || sdk.store === undefined
        ? undefined
        : await canonicalProspectivePath(sdk.store);
    const installArgs =
      sdk === undefined ? ['install', '--frozen-lockfile=false'] : sdkProjectInstallArgs(store);
    await execFileCommand('pnpm', installArgs, {
      cwd: facts.value.root,
      env: { ...process.env, CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return applied;
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-init-failed') };
  }
}

export async function newCommand(options: NewOptions = {}): Promise<CommandResult<unknown>> {
  try {
    const sdk = await findSdkContext();
    if (sdk === undefined) {
      return {
        ok: false,
        error: {
          code: 'sdk-context-missing',
          expected: 'forgeax project new to run from an unpacked ForgeaX SDK',
          hint:
            'Install the matching SDK outside the game: forgeax sdk install --root <sdk-root>; ' +
            'then run node <sdk-root>/bin/forgeax.mjs project init --root <sdk-root> and ' +
            `node <sdk-root>/bin/forgeax.mjs project new <game-root> --template ${options.template ?? 'empty'}. ` +
            'For an existing SDK, run its bin/forgeax.mjs entry ' +
            'or set FORGEAX_SDK_ROOT to its root.',
          detail: {},
        },
      };
    }
    const root = resolve(options.root ?? process.cwd());
    if (
      isFilesystemPathWithin(
        await canonicalProspectivePath(sdk.root),
        await canonicalProspectivePath(root),
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'project-target-inside-sdk',
          expected: 'forgeax project new target to be outside the unpacked SDK root',
          hint: 'Choose a sibling directory or an absolute path outside the SDK.',
          detail: { root, sdkRoot: sdk.root },
        },
      };
    }
    if (options.template === undefined) {
      const available = [...sdk.templates.keys()].sort();
      return {
        ok: false,
        error: {
          code: 'sdk-template-required',
          expected: 'forgeax project new to select exactly one template with --template',
          hint: `Choose one of: ${available.join(', ')}.`,
          detail: { templates: available },
        },
      };
    }
    const templateId = options.template;
    const template = sdk.templates.get(templateId);
    if (template === undefined) {
      return {
        ok: false,
        error: {
          code: 'sdk-template-not-found',
          expected: 'a template id declared by sdk-manifest.json',
          hint: `Choose one of: ${[...sdk.templates.keys()].sort().join(', ')}.`,
          detail: { template: templateId },
        },
      };
    }
    const descriptor = await readTemplateDescriptor(template);
    if (!descriptor.ok) return descriptor;
    if (descriptor.value.id !== templateId) {
      return {
        ok: false,
        error: {
          code: 'template-invalid',
          expected: `template.json#id to match the selected template ${templateId}`,
          hint: 'Repair the descriptor identity or refresh the SDK before creating a project.',
          detail: { id: descriptor.value.id },
        },
      };
    }
    let targetExists = true;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
      targetExists = false;
      entries = [];
    }
    if (entries.length > 0) {
      return {
        ok: false,
        error: {
          code: 'project-target-not-empty',
          expected: 'forgeax project new target to be absent or empty',
          hint: 'Choose an empty directory so existing files cannot be overwritten.',
          detail: { root },
        },
      };
    }
    const identity = resolveProjectIdentity({
      targetBasename: basename(root),
      descriptor: descriptor.value,
      overrides: {
        ...(options.id === undefined ? {} : { id: options.id }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.packageName === undefined ? {} : { packageName: options.packageName }),
      },
    });
    if (!identity.ok) return identity;
    if (options.dryRun === true) {
      return {
        ok: true,
        value: {
          root,
          template: templateId,
          identity: identity.value,
          sdkVersion: sdk.manifest.sdkVersion,
        },
      };
    }
    const initialized = await requireSdkInitialization(sdk);
    if (!initialized.ok) return initialized;
    const parent = dirname(root);
    await mkdir(parent, { recursive: true });
    let staging: string | undefined = await mkdtemp(
      resolve(parent, `.${basename(root)}.forgeax-staging-`),
    );
    const committedNames: string[] = [];
    let committed = false;
    try {
      for (const name of await readdir(template)) {
        await cp(resolve(template, name), resolve(staging, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      await writeProjectIdentity(staging, identity.value);
      await copySdkSkills(sdk, staging);
      const store = sdk.store === undefined ? undefined : await canonicalProspectivePath(sdk.store);
      await configureSdkStore(staging, store);
      if (!targetExists) {
        await rename(staging, root);
        staging = undefined;
        committedNames.push(...(await readdir(root)));
      } else {
        for (const name of await readdir(staging)) {
          await rename(resolve(staging, name), resolve(root, name));
          committedNames.push(name);
        }
        await rm(staging, { recursive: true, force: true });
        staging = undefined;
      }
      committed = true;
      // Create Windows junctions after the final rename. A junction made in
      // staging would keep pointing at the temporary path after commit.
      await installProjectSkills(root, sdk.manifest);
      // Install after the final rename so pnpm's virtual-store metadata keeps
      // the real project path. Installing inside staging would force a second
      // registry resolution when `pnpm exec` runs from the committed project.
      await execFileCommand('pnpm', sdkProjectInstallArgs(store), {
        cwd: root,
        env: { ...process.env, CI: 'true' },
        maxBuffer: 16 * 1024 * 1024,
      });
      const sdkUpdate = await checkSdkUpdate(sdk.manifest.sdkVersion);
      return {
        ok: true,
        value: {
          root,
          template: templateId,
          identity: identity.value,
          sdkVersion: sdk.manifest.sdkVersion,
          onboarding: agentOnboarding(sdk, root),
          sdkUpdate,
        },
      };
    } catch (cause) {
      if (staging !== undefined) await rm(staging, { recursive: true, force: true });
      if (committed) {
        if (!targetExists) {
          await rm(root, { recursive: true, force: true });
          return { ok: false, error: commandError(cause, 'project-create-failed') };
        }
        const cleanupNames = new Set([
          ...committedNames,
          ...PROJECT_SKILL_MOUNT_ROOTS.map((mountRoot) => mountRoot.split('/')[0] ?? mountRoot),
          'node_modules',
        ]);
        await Promise.all(
          [...cleanupNames].map((name) =>
            rm(resolve(root, name), { recursive: true, force: true }),
          ),
        );
      } else {
        await Promise.all(
          committedNames.map((name) => rm(resolve(root, name), { recursive: true, force: true })),
        );
      }
      return { ok: false, error: commandError(cause, 'project-create-failed') };
    }
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-create-failed') };
  }
}
