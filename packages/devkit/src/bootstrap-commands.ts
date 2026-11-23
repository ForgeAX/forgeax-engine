import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { UI_AUTHORING_PROFILE, type UiAuthoringProfile } from '@forgeax/engine-ui/authoring';
import { parseDocument } from 'yaml';
import { execFileCommand } from './child-process.js';
import { engineDoctorCommand, readEngineBinding } from './engine-binding.js';
import {
  directoryOccupancy,
  isFilesystemPathWithin,
  isMissingPathError,
  publishPreparedDirectory,
} from './filesystem-path.js';
import { applyInitPlan, createInitPlan } from './init.js';
import { registerKnownProject } from './known-projects.js';
import { commandError, readProjectFacts } from './project.js';
import {
  hasLocalEngineDependencyOverride,
  inspectRunDependencyClosure,
  localDependencyProtocol,
} from './run-snapshot.js';
import { checkSdkUpdate, findSdkContext } from './sdk.js';
import {
  agentOnboarding,
  MINIMUM_SUPPORTED_PNPM,
  pnpmVersionAtLeast,
  readPnpmVersion,
  requireSdkInitialization,
  sdkInitCommand,
  sdkPnpmRequirement,
  sdkProjectInstallArgs,
} from './sdk-bootstrap.js';
import { copySdkSkills, installProjectSkills, PROJECT_SKILL_MOUNT_ROOTS } from './skill-install.js';
import {
  readTemplateDescriptor,
  resolveProjectIdentity,
  writeProjectIdentity,
} from './templates/materialize.js';
import type { CommandResult, InitOptions, NewOptions, ProjectCommandOptions } from './types.js';
import { completeCommand, failCommand } from './types.js';

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
  /** Authored Pack sources loaded with the same admission rules as `project play`. */
  readonly packSources: number;
  readonly uiAuthoringProfile: UiAuthoringProfile;
  /** Offline dry cook of authored material and particle-effect rows. */
  readonly assets: { readonly checked: number; readonly skipped: readonly string[] };
}

function nodeSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

async function finishDoctor(
  facts: Extract<Awaited<ReturnType<typeof readProjectFacts>>, { ok: true }>['value'],
  pnpm: string,
  workspaceDependencies: DoctorReport['workspaceDependencies'],
): Promise<CommandResult<DoctorReport>> {
  const sources = await (await import('./assets.js')).checkProjectSources(facts);
  if (!sources.ok) return sources;
  return completeCommand({
    root: facts.root,
    projectId: facts.id,
    node: process.versions.node,
    pnpm,
    workspaceDependencies,
    ...sources.value,
    uiAuthoringProfile: UI_AUTHORING_PROFILE,
  });
}

function projectLocalDependencies(packageJson: Record<string, unknown>): string[] {
  const dependencies = new Set<string>();
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const entries = packageJson[section];
    if (entries === null || typeof entries !== 'object') continue;
    for (const [name, specifier] of Object.entries(entries)) {
      if (typeof specifier === 'string' && localDependencyProtocol(specifier) !== undefined) {
        dependencies.add(name);
      }
    }
  }
  return [...dependencies].sort();
}

export async function doctorCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<DoctorReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  let pnpm: string;
  try {
    pnpm = await readPnpmVersion(facts.value.root, facts.value.packageJson.packageManager);
  } catch (cause) {
    return failCommand(
      'pnpm-unavailable',
      'pnpm to be available on PATH',
      'Install the SDK-supported pnpm version and retry.',
      { reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (!nodeSupported()) {
    return failCommand(
      'node-version-unsupported',
      'Node.js >=22.13.0',
      'Select a supported Node.js installation and retry.',
      { actual: process.versions.node },
    );
  }
  if (!pnpmVersionAtLeast(pnpm, MINIMUM_SUPPORTED_PNPM)) {
    return failCommand(
      'pnpm-version-unsupported',
      `pnpm ${sdkPnpmRequirement(MINIMUM_SUPPORTED_PNPM)}`,
      'Enable the packageManager-declared pnpm version with Corepack and retry.',
      { actual: pnpm },
    );
  }
  const localDependencies = projectLocalDependencies(facts.value.packageJson);
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
      return failCommand(
        'project-engine-binding-changed',
        'the same healthy local Engine binding to remain selected during doctor',
        'Recheck the project Engine binding and retry doctor.',
        { binding: binding.value.path, mode: engine.value.mode },
      );
    engineDigest = engine.value.workspace.digest;
  }
  try {
    if (
      binding.value !== null ||
      localDependencies.length > 0 ||
      (await hasLocalEngineDependencyOverride(facts.value.root))
    )
      await inspectRunDependencyClosure(facts.value.root, binding.value, engineDigest, pnpm);
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-dependency-closure-invalid') };
  }
  return finishDoctor(facts.value, pnpm, localDependencies);
}

async function registerInitializedProject(
  root: string,
  result: CommandResult<unknown>,
): Promise<CommandResult<unknown>> {
  const registered = await registerKnownProject(root);
  return registered.ok ? result : registered;
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
    if (options.install === false) {
      return await registerInitializedProject(facts.value.root, applied);
    }
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
    return await registerInitializedProject(facts.value.root, applied);
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-init-failed') };
  }
}

export async function newCommand(options: NewOptions = {}): Promise<CommandResult<unknown>> {
  try {
    const sdk = await findSdkContext();
    if (sdk === undefined) {
      return failCommand(
        'sdk-context-missing',
        'forgeax project new to run from an unpacked ForgeAX SDK',
        'Install the matching SDK outside the game: forgeax sdk install --root <sdk-root>; ' +
          'then run node <sdk-root>/bin/forgeax.mjs project init --root <sdk-root> and ' +
          `node <sdk-root>/bin/forgeax.mjs project new <game-root> --template ${options.template ?? 'empty'}. ` +
          'For an existing SDK, run its bin/forgeax.mjs entry ' +
          'or set FORGEAX_SDK_ROOT to its root.',
        {},
      );
    }
    const root = resolve(options.root ?? process.cwd());
    if (
      isFilesystemPathWithin(
        await canonicalProspectivePath(sdk.root),
        await canonicalProspectivePath(root),
      )
    ) {
      return failCommand(
        'project-target-inside-sdk',
        'forgeax project new target to be outside the unpacked SDK root',
        'Choose a sibling directory or an absolute path outside the SDK.',
        { root, sdkRoot: sdk.root },
      );
    }
    if (options.template === undefined) {
      const available = [...sdk.templates.keys()].sort();
      return failCommand(
        'sdk-template-required',
        'forgeax project new to select exactly one template with --template',
        `Choose one of: ${available.join(', ')}.`,
        { templates: available },
      );
    }
    const templateId = options.template;
    const template = sdk.templates.get(templateId);
    if (template === undefined) {
      return failCommand(
        'sdk-template-not-found',
        'a template id declared by sdk-manifest.json',
        `Choose one of: ${[...sdk.templates.keys()].sort().join(', ')}.`,
        { template: templateId },
      );
    }
    const descriptor = await readTemplateDescriptor(template);
    if (!descriptor.ok) return descriptor;
    if (descriptor.value.id !== templateId) {
      return failCommand(
        'template-invalid',
        `template.json#id to match the selected template ${templateId}`,
        'Repair the descriptor identity or refresh the SDK before creating a project.',
        { id: descriptor.value.id },
      );
    }
    const occupancy = await directoryOccupancy(root);
    if (occupancy === 'occupied') {
      return failCommand(
        'project-target-not-empty',
        'forgeax project new target to be absent or empty',
        'Choose an empty directory so existing files cannot be overwritten.',
        { root },
      );
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
      return completeCommand({
        root,
        template: templateId,
        identity: identity.value,
        sdkVersion: sdk.manifest.sdkVersion,
      });
    }
    const initialized = await requireSdkInitialization(sdk);
    if (!initialized.ok) return initialized;
    const parent = dirname(root);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(resolve(parent, `.${basename(root)}.forgeax-staging-`));
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
      return await publishPreparedDirectory(
        staging,
        root,
        occupancy,
        async () => {
          // Create junctions and install packages only at the final project path.
          await installProjectSkills(root, sdk.manifest);
          await execFileCommand('pnpm', sdkProjectInstallArgs(store), {
            cwd: root,
            env: { ...process.env, CI: 'true' },
            maxBuffer: 16 * 1024 * 1024,
          });
          const sdkUpdate = await checkSdkUpdate(sdk.manifest.sdkVersion);
          return registerInitializedProject(
            root,
            completeCommand({
              root,
              template: templateId,
              identity: identity.value,
              sdkVersion: sdk.manifest.sdkVersion,
              onboarding: agentOnboarding(sdk, root),
              sdkUpdate,
            }),
          );
        },
        [...PROJECT_SKILL_MOUNT_ROOTS.map((path) => path.split('/')[0] ?? path), 'node_modules'],
      );
    } catch (cause) {
      await rm(staging, { recursive: true, force: true });
      throw cause;
    }
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-create-failed') };
  }
}
