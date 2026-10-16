import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { err, ok, type Result } from '@forgeax/engine-types';
import {
  type TemplateDescriptor,
  type TemplateValidation,
  validateTemplateDescriptor,
} from './descriptor.js';

export interface ProjectIdentity {
  readonly id: string;
  readonly name: string;
  readonly packageName: string;
}

export interface ProjectIdentityOverrides {
  readonly id?: string;
  readonly name?: string;
  readonly packageName?: string;
}

export interface ProjectIdentityInput {
  readonly targetBasename: string;
  readonly descriptor: Pick<TemplateDescriptor, 'defaultIdentity'>;
  readonly overrides?: ProjectIdentityOverrides;
}

export type ProjectIdentityError = {
  readonly code: 'project-identity-invalid';
  readonly expected: string;
  readonly hint: string;
  readonly detail: {
    readonly field: 'target' | 'id' | 'name' | 'packageName' | 'templateDefault';
    readonly received?: string;
  };
};

function identityError(
  field: ProjectIdentityError['detail']['field'],
  received: string | undefined,
): ProjectIdentityError {
  const expected =
    field === 'name'
      ? 'the project name to be a non-empty string without surrounding whitespace'
      : field === 'packageName'
        ? 'the package name to be a valid lowercase npm package name'
        : 'the project id and target directory name to be a lowercase path-safe identifier';
  return {
    code: 'project-identity-invalid',
    expected,
    hint:
      field === 'target'
        ? 'Rename the target directory to a lowercase identifier or pass an explicit --id.'
        : field === 'packageName'
          ? 'Pass --package-name with a lowercase npm package name, for example @local/my-game.'
          : field === 'name'
            ? 'Pass --name with a non-empty display name.'
            : 'Pass --id with a lowercase identifier such as my-game.',
    detail: { field, ...(received === undefined ? {} : { received }) },
  };
}

function isProjectId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

function isPackageSegment(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(value);
}

function isPackageName(value: string): boolean {
  if (value.startsWith('@')) {
    const parts = value.split('/');
    const scope = parts[0];
    const name = parts[1];
    return (
      parts.length === 2 &&
      scope !== undefined &&
      name !== undefined &&
      isPackageSegment(scope.slice(1)) &&
      isPackageSegment(name)
    );
  }
  return !value.includes('/') && isPackageSegment(value);
}

function packageNameFor(id: string, templateDefault: string): string {
  const slash = templateDefault.startsWith('@') ? templateDefault.indexOf('/') : -1;
  const scope = slash > 1 ? templateDefault.slice(0, slash) : '';
  return scope.length > 0 ? `${scope}/${id}` : id;
}

/**
 * Resolve the generated project identity before any target-side effects.
 *
 * Template defaults provide the package namespace, while the target basename
 * is the default project identity. Explicit values win field-by-field.
 */
export function resolveProjectIdentity(
  input: ProjectIdentityInput,
): Result<ProjectIdentity, ProjectIdentityError> {
  const overrides = input.overrides ?? {};
  const targetBasename = input.targetBasename;
  if (!isProjectId(targetBasename)) return err(identityError('target', targetBasename));

  const templateDefault = input.descriptor.defaultIdentity;
  if (
    templateDefault.name.trim().length === 0 ||
    templateDefault.name !== templateDefault.name.trim() ||
    !isPackageName(templateDefault.packageName)
  ) {
    return err(identityError('templateDefault', templateDefault.packageName));
  }

  const id = overrides.id ?? targetBasename;
  if (!isProjectId(id)) return err(identityError('id', id));
  const name = overrides.name ?? id;
  if (name.trim().length === 0 || name !== name.trim()) {
    return err(identityError('name', name));
  }
  const packageName = overrides.packageName ?? packageNameFor(id, templateDefault.packageName);
  if (!isPackageName(packageName)) {
    return err(identityError('packageName', packageName));
  }
  return ok({ id, name, packageName });
}

/** Read and validate the descriptor copied with one SDK template. */
export async function readTemplateDescriptor(templateRoot: string): Promise<TemplateValidation> {
  try {
    const parsed = JSON.parse(
      await readFile(resolve(templateRoot, 'template.json'), 'utf8'),
    ) as unknown;
    return validateTemplateDescriptor(parsed);
  } catch {
    return {
      ok: false,
      error: {
        code: 'template-invalid',
        expected: 'template.json to contain valid JSON and a complete descriptor',
        hint: 'Repair the selected template descriptor before creating a project.',
        detail: {},
      },
    };
  }
}

export type TemplateMaterializeError = {
  readonly code: 'template-materialize-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly stage: string; readonly reason: string };
};

function materializeError(stage: string, reason: unknown): Error & TemplateMaterializeError {
  return Object.assign(new Error('template materialization failed'), {
    code: 'template-materialize-failed' as const,
    expected: 'project identity to be written in the staging directory before commit',
    hint: 'repair the template manifests and retry project creation; the target was not committed',
    detail: { stage, reason: reason instanceof Error ? reason.message : String(reason) },
  });
}

/** Rewrite the authoritative top-level project identities in a staged copy. */
export async function writeProjectIdentity(root: string, identity: ProjectIdentity): Promise<void> {
  const manifestPath = resolve(root, 'forge.json');
  const packagePath = resolve(root, 'package.json');
  let manifest: unknown;
  let packageJson: unknown;
  try {
    [manifest, packageJson] = await Promise.all([
      JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
      JSON.parse(await readFile(packagePath, 'utf8')) as unknown,
    ]);
  } catch (cause) {
    throw materializeError('read-manifests', cause);
  }
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    packageJson === null ||
    typeof packageJson !== 'object' ||
    Array.isArray(packageJson)
  ) {
    throw materializeError(
      'validate-manifests',
      'forge.json and package.json must contain objects',
    );
  }
  const nextManifest = manifest as Record<string, unknown>;
  const nextPackage = packageJson as Record<string, unknown>;
  nextManifest.id = identity.id;
  nextManifest.name = identity.name;
  // A previous candidate writer used a nested identity object. It is not part
  // of GameProjectSchema and must never survive into a generated project.
  delete nextManifest.identity;
  nextPackage.name = identity.packageName;
  try {
    await Promise.all([
      writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`),
      writeFile(packagePath, `${JSON.stringify(nextPackage, null, 2)}\n`),
    ]);
  } catch (cause) {
    throw materializeError('write-manifests', cause);
  }
}
