import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { commandError, readProjectFacts } from './project.js';
import type { SdkContext, SdkSkill } from './sdk.js';
import type { CommandResult, ProjectCommandOptions } from './types.js';

export const PROJECT_SKILL_MOUNT_ROOTS = Object.freeze([
  '.codebuddy/skills',
  '.cursor/skills',
  '.agents/skills',
  '.claude/skills',
  '.workbuddy/skills',
  '.forgeax/skills',
]);
const RETIRED_PROJECT_SKILL_MOUNT_ROOTS = new Set(['.claude-internal/skills']);

const MANIFEST_PATH = '.forgeax/skill-install-manifest.json';
const GITIGNORE_BEGIN = '# BEGIN FORGEAX MANAGED SKILLS';
const GITIGNORE_END = '# END FORGEAX MANAGED SKILLS';

interface InstalledSkill extends SdkSkill {}

interface SkillInstallManifest {
  readonly schemaVersion: '1.0.0';
  readonly sourceRoot: 'skills';
  readonly sdkVersion?: string;
  readonly engineCommit?: string;
  readonly skills: readonly InstalledSkill[];
  readonly mounts: readonly {
    readonly root: string;
    readonly skills: readonly string[];
  }[];
}

export interface SkillInstallReport {
  readonly root: string;
  readonly sourceRoot: string;
  readonly manifest: string;
  readonly skills: readonly string[];
  readonly mountRoots: readonly string[];
}

function slash(path: string): string {
  return path.split(sep).join('/');
}

function contained(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep);
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'file' | 'symlink'> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    return 'file';
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return 'missing';
    }
    throw cause;
  }
}

async function filesUnder(root: string, directory = root): Promise<readonly string[]> {
  const files: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`skill-source-symlink: ${path}`);
    if (info.isDirectory()) files.push(...(await filesUnder(root, path)));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

async function skillRow(sourceRoot: string, id: string): Promise<InstalledSkill> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`skill-id-invalid: ${id}`);
  const root = resolve(sourceRoot, id);
  if ((await pathKind(root)) !== 'directory') throw new Error(`skill-source-invalid: ${id}`);
  if ((await pathKind(resolve(root, 'SKILL.md'))) !== 'file') {
    throw new Error(`skill-entry-missing: ${id}/SKILL.md`);
  }
  const files = await filesUnder(root);
  return {
    id,
    root: `skills/${id}`,
    fileCount: files.length,
    byteCount: (
      await Promise.all(files.map(async (path) => (await readFile(path)).byteLength))
    ).reduce((sum, bytes) => sum + bytes, 0),
  };
}

async function discoverProjectSkills(root: string): Promise<readonly InstalledSkill[]> {
  const sourceRoot = resolve(root, 'skills');
  if ((await pathKind(sourceRoot)) !== 'directory') throw new Error('project-skills-missing');
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (ids.length === 0) throw new Error('project-skills-empty');
  return Promise.all(ids.map((id) => skillRow(sourceRoot, id)));
}

async function sameFiles(leftRoot: string, rightRoot: string): Promise<boolean> {
  const left = await filesUnder(leftRoot);
  const right = await filesUnder(rightRoot);
  const leftNames = left.map((path) => slash(relative(leftRoot, path)));
  const rightNames = right.map((path) => slash(relative(rightRoot, path)));
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftPath = left[index];
    const rightPath = right[index];
    if (leftPath === undefined || rightPath === undefined) return false;
    if (!(await readFile(leftPath)).equals(await readFile(rightPath))) return false;
  }
  return true;
}

export async function copySdkSkills(sdk: SdkContext, projectRoot: string): Promise<void> {
  const targetSourceRoot = resolve(projectRoot, 'skills');
  const copies: { source: string; destination: string }[] = [];
  for (const skill of sdk.manifest.skills) {
    const source = resolve(sdk.root, skill.root);
    const destination = resolve(projectRoot, skill.root);
    if (!contained(sdk.root, source) || !contained(projectRoot, destination)) {
      throw new Error(`sdk-skill-path-invalid: ${skill.id}`);
    }
    const actual = await skillRow(resolve(sdk.root, 'skills'), skill.id);
    if (
      actual.root !== skill.root ||
      actual.fileCount !== skill.fileCount ||
      actual.byteCount !== skill.byteCount
    ) {
      throw new Error(`sdk-skill-manifest-drift: ${skill.id}`);
    }
    const kind = await pathKind(destination);
    if (kind === 'missing') {
      copies.push({ source, destination });
    } else if (kind !== 'directory' || !(await sameFiles(source, destination))) {
      throw new Error(`project-skill-source-conflict: ${skill.id}`);
    }
  }
  const created: string[] = [];
  try {
    await mkdir(targetSourceRoot, { recursive: true });
    for (const { source, destination } of copies) {
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
      created.push(destination);
    }
  } catch (cause) {
    await Promise.all(created.map((path) => rm(path, { recursive: true, force: true })));
    throw cause;
  }
}

function expectedLinkTarget(projectRoot: string, mountRoot: string, id: string): string {
  const mountParent = resolve(projectRoot, mountRoot);
  const target = resolve(projectRoot, 'skills', id);
  return process.platform === 'win32' ? target : relative(mountParent, target);
}

async function linkMatches(path: string, target: string): Promise<boolean> {
  if ((await pathKind(path)) !== 'symlink') return false;
  const actual = await readlink(path);
  return resolve(dirname(path), actual) === resolve(dirname(path), target);
}

function updateManagedGitignore(previous: string, skillIds: readonly string[]): string {
  const block = `${GITIGNORE_BEGIN}\n${skillIds.map((id) => `/${id}`).join('\n')}\n${GITIGNORE_END}`;
  const begin = previous.indexOf(GITIGNORE_BEGIN);
  const end = previous.indexOf(GITIGNORE_END);
  if (begin >= 0 && end >= begin) {
    const after = end + GITIGNORE_END.length;
    return `${previous.slice(0, begin)}${block}${previous.slice(after)}`.replace(/^\n+/, '');
  }
  return previous.length === 0 ? `${block}\n` : `${previous.replace(/\s*$/, '')}\n\n${block}\n`;
}

function removeManagedGitignore(previous: string): string {
  const begin = previous.indexOf(GITIGNORE_BEGIN);
  const end = previous.indexOf(GITIGNORE_END);
  if (begin < 0 || end < begin) return previous;
  const before = previous.slice(0, begin).trimEnd();
  const after = previous.slice(end + GITIGNORE_END.length).trimStart();
  const retained = [before, after].filter((part) => part.length > 0).join('\n');
  return retained.length === 0 ? '' : `${retained}\n`;
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (cause) {
    if (
      cause !== null &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause.code === 'ENOENT' || cause.code === 'ENOTEMPTY' || cause.code === 'EEXIST')
    ) {
      return;
    }
    throw cause;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return undefined;
    }
    throw cause;
  }
}

async function readInstallManifest(root: string): Promise<SkillInstallManifest | undefined> {
  const value = await readOptional(resolve(root, MANIFEST_PATH));
  return value === undefined ? undefined : (JSON.parse(value) as SkillInstallManifest);
}

export async function installedProjectSkillDirectories(root: string): Promise<readonly string[]> {
  const manifest = await readInstallManifest(root);
  if (manifest === undefined) return [];
  if (
    manifest.schemaVersion !== '1.0.0' ||
    manifest.sourceRoot !== 'skills' ||
    !Array.isArray(manifest.skills)
  ) {
    throw new Error('skill-install-manifest-drift');
  }
  const directories: string[] = [];
  for (const skill of manifest.skills) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill.id) || skill.root !== `skills/${skill.id}`) {
      throw new Error('skill-install-manifest-drift');
    }
    if ((await pathKind(resolve(root, skill.root))) !== 'directory') continue;
    directories.push(skill.root);
    for (const mountRoot of PROJECT_SKILL_MOUNT_ROOTS) {
      const path = `${mountRoot}/${skill.id}`;
      if (await linkMatches(resolve(root, path), expectedLinkTarget(root, mountRoot, skill.id))) {
        directories.push(path);
      }
    }
  }
  return directories;
}

export async function installProjectSkills(
  root: string,
  provenance?: Pick<SdkContext['manifest'], 'sdkVersion' | 'engineCommit'>,
): Promise<SkillInstallReport> {
  const projectRoot = resolve(root);
  const skills = await discoverProjectSkills(projectRoot);
  const ids = skills.map((skill) => skill.id);
  const priorManifest = await readInstallManifest(projectRoot);
  const desiredLinks = PROJECT_SKILL_MOUNT_ROOTS.flatMap((mountRoot) =>
    ids.map((id) => ({
      path: resolve(projectRoot, mountRoot, id),
      target: expectedLinkTarget(projectRoot, mountRoot, id),
    })),
  );
  const desiredPaths = new Set(desiredLinks.map((entry) => entry.path));
  const desiredMountRoots = new Set<string>(PROJECT_SKILL_MOUNT_ROOTS);
  const retiredMountRoots = (priorManifest?.mounts ?? [])
    .map((mount) => mount.root)
    .filter(
      (mountRoot) =>
        !desiredMountRoots.has(mountRoot) && RETIRED_PROJECT_SKILL_MOUNT_ROOTS.has(mountRoot),
    );
  const staleLinks = (priorManifest?.mounts ?? [])
    .flatMap((mount) =>
      mount.skills.map((id) => ({
        path: resolve(projectRoot, mount.root, id),
        target: expectedLinkTarget(projectRoot, mount.root, id),
      })),
    )
    .filter((entry) => !desiredPaths.has(entry.path));

  for (const entry of desiredLinks) {
    const kind = await pathKind(entry.path);
    if (kind !== 'missing' && !(await linkMatches(entry.path, entry.target))) {
      throw new Error(`skill-mount-conflict: ${slash(relative(projectRoot, entry.path))}`);
    }
  }
  for (const entry of staleLinks) {
    const kind = await pathKind(entry.path);
    if (kind !== 'missing' && !(await linkMatches(entry.path, entry.target))) {
      throw new Error(`skill-stale-mount-conflict: ${slash(relative(projectRoot, entry.path))}`);
    }
  }

  const ignoreSnapshots = new Map<string, string | undefined>();
  const createdLinks: string[] = [];
  const removedLinks: { path: string; target: string }[] = [];
  const manifestPath = resolve(projectRoot, MANIFEST_PATH);
  const priorManifestText = await readOptional(manifestPath);
  try {
    for (const entry of staleLinks) {
      if ((await pathKind(entry.path)) === 'symlink') {
        await rm(entry.path);
        removedLinks.push(entry);
      }
    }
    for (const mountRoot of retiredMountRoots) {
      const mountParent = resolve(projectRoot, mountRoot);
      const ignorePath = resolve(mountParent, '.gitignore');
      const previous = await readOptional(ignorePath);
      ignoreSnapshots.set(ignorePath, previous);
      if (previous !== undefined) {
        const retained = removeManagedGitignore(previous);
        if (retained.length === 0) await rm(ignorePath);
        else await writeFile(ignorePath, retained);
      }
      await removeEmptyDirectory(mountParent);
      await removeEmptyDirectory(dirname(mountParent));
    }
    for (const mountRoot of PROJECT_SKILL_MOUNT_ROOTS) {
      const mountParent = resolve(projectRoot, mountRoot);
      await mkdir(mountParent, { recursive: true });
      const ignorePath = resolve(mountParent, '.gitignore');
      const previous = await readOptional(ignorePath);
      ignoreSnapshots.set(ignorePath, previous);
      await writeFile(ignorePath, updateManagedGitignore(previous ?? '', ids));
      for (const id of ids) {
        const path = resolve(mountParent, id);
        if ((await pathKind(path)) === 'missing') {
          const target = expectedLinkTarget(projectRoot, mountRoot, id);
          await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
          createdLinks.push(path);
        }
      }
    }
    const sdkVersion = provenance?.sdkVersion ?? priorManifest?.sdkVersion;
    const engineCommit = provenance?.engineCommit ?? priorManifest?.engineCommit;
    const manifest: SkillInstallManifest = {
      schemaVersion: '1.0.0',
      sourceRoot: 'skills',
      ...(sdkVersion === undefined ? {} : { sdkVersion }),
      ...(engineCommit === undefined ? {} : { engineCommit }),
      skills,
      mounts: PROJECT_SKILL_MOUNT_ROOTS.map((mountRoot) => ({ root: mountRoot, skills: ids })),
    };
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (cause) {
    await Promise.all(createdLinks.map((path) => rm(path, { force: true })));
    await Promise.all(
      removedLinks.map(async ({ path, target }) => {
        await mkdir(dirname(path), { recursive: true });
        await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
      }),
    );
    await Promise.all(
      [...ignoreSnapshots].map(async ([path, value]) => {
        if (value === undefined) await rm(path, { force: true });
        else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, value);
        }
      }),
    );
    if (priorManifestText === undefined) await rm(manifestPath, { force: true });
    else await writeFile(manifestPath, priorManifestText);
    throw cause;
  }
  return {
    root: projectRoot,
    sourceRoot: resolve(projectRoot, 'skills'),
    manifest: manifestPath,
    skills: ids,
    mountRoots: PROJECT_SKILL_MOUNT_ROOTS,
  };
}

export async function verifyProjectSkills(root: string): Promise<SkillInstallReport> {
  const projectRoot = resolve(root);
  const skills = await discoverProjectSkills(projectRoot);
  const ids = skills.map((skill) => skill.id);
  const manifest = await readInstallManifest(projectRoot);
  if (manifest === undefined) throw new Error('skill-install-manifest-missing');
  if (
    manifest.schemaVersion !== '1.0.0' ||
    manifest.sourceRoot !== 'skills' ||
    JSON.stringify(manifest.skills) !== JSON.stringify(skills) ||
    JSON.stringify(manifest.mounts.map((mount) => mount.root)) !==
      JSON.stringify(PROJECT_SKILL_MOUNT_ROOTS)
  ) {
    throw new Error('skill-install-manifest-drift');
  }
  for (const mountRoot of PROJECT_SKILL_MOUNT_ROOTS) {
    const declared = manifest.mounts.find((mount) => mount.root === mountRoot);
    if (declared === undefined || JSON.stringify(declared.skills) !== JSON.stringify(ids)) {
      throw new Error(`skill-install-manifest-mount-drift: ${mountRoot}`);
    }
    const ignore = await readOptional(resolve(projectRoot, mountRoot, '.gitignore'));
    if (ignore === undefined || updateManagedGitignore(ignore, ids) !== ignore) {
      throw new Error(`skill-mount-gitignore-drift: ${mountRoot}`);
    }
    for (const id of ids) {
      const path = resolve(projectRoot, mountRoot, id);
      const target = expectedLinkTarget(projectRoot, mountRoot, id);
      if (!(await linkMatches(path, target))) {
        throw new Error(`skill-mount-drift: ${mountRoot}/${id}`);
      }
    }
  }
  return {
    root: projectRoot,
    sourceRoot: resolve(projectRoot, 'skills'),
    manifest: resolve(projectRoot, MANIFEST_PATH),
    skills: ids,
    mountRoots: PROJECT_SKILL_MOUNT_ROOTS,
  };
}

export async function skillInstallCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<SkillInstallReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  try {
    return { ok: true, value: await installProjectSkills(facts.value.root) };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'skill-install-failed') };
  }
}

export async function skillVerifyCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<SkillInstallReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  try {
    return { ok: true, value: await verifyProjectSkills(facts.value.root) };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'skill-verify-failed') };
  }
}
