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
import { isFilesystemPathWithin, isMissingPathError } from './filesystem-path.js';
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

interface SkillInstallManifest {
  readonly schemaVersion: '1.0.0';
  readonly sourceRoot: 'skills';
  readonly sdkVersion?: string;
  readonly engineCommit?: string;
  readonly skills: readonly SdkSkill[];
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

async function pathKind(path: string): Promise<'missing' | 'directory' | 'file' | 'symlink'> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'symlink';
    if (info.isDirectory()) return 'directory';
    return 'file';
  } catch (cause) {
    if (isMissingPathError(cause)) return 'missing';
    throw cause;
  }
}

async function filesUnder(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`skill-source-symlink: ${path}`);
    if (info.isDirectory()) files.push(...(await filesUnder(path)));
    else if (info.isFile()) files.push(path);
  }
  return files;
}

async function skillRow(sourceRoot: string, id: string): Promise<SdkSkill> {
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

async function discoverProjectSkills(root: string): Promise<readonly SdkSkill[]> {
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
    if (
      !isFilesystemPathWithin(sdk.root, source, false) ||
      !isFilesystemPathWithin(projectRoot, destination, false)
    ) {
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

function skillLink(project: string, mount: string, id: string) {
  const parent = resolve(project, mount);
  const source = resolve(project, 'skills', id);
  return {
    path: resolve(parent, id),
    target: process.platform === 'win32' ? source : relative(parent, source),
  };
}

type SkillLink = ReturnType<typeof skillLink>;

function skillMounts(project: string, ids: readonly string[]) {
  return PROJECT_SKILL_MOUNT_ROOTS.map((root) => {
    const directory = resolve(project, root);
    return {
      root,
      directory,
      ignorePath: resolve(directory, '.gitignore'),
      links: ids.map((id) => skillLink(project, root, id)),
    };
  });
}

async function linkStatus({ path, target }: SkillLink): Promise<'missing' | 'owned' | 'foreign'> {
  const kind = await pathKind(path);
  if (kind === 'missing') return kind;
  if (kind !== 'symlink') return 'foreign';
  const parent = dirname(path);
  return resolve(parent, await readlink(path)) === resolve(parent, target) ? 'owned' : 'foreign';
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
    if (isMissingPathError(cause)) return undefined;
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
      if ((await linkStatus(skillLink(root, mountRoot, skill.id))) === 'owned')
        directories.push(`${mountRoot}/${skill.id}`);
    }
  }
  return directories;
}

function installedSkillsReport(root: string, skills: readonly string[]): SkillInstallReport {
  return {
    root,
    sourceRoot: resolve(root, 'skills'),
    manifest: resolve(root, MANIFEST_PATH),
    skills,
    mountRoots: PROJECT_SKILL_MOUNT_ROOTS,
  };
}

export async function installProjectSkills(
  root: string,
  provenance?: Pick<SdkContext['manifest'], 'sdkVersion' | 'engineCommit'>,
): Promise<SkillInstallReport> {
  const projectRoot = resolve(root);
  const skills = await discoverProjectSkills(projectRoot);
  const ids = skills.map((skill) => skill.id);
  const priorManifest = await readInstallManifest(projectRoot);
  const mounts = skillMounts(projectRoot, ids);
  const desiredLinks = mounts.flatMap(({ links }) => links);
  const desiredPaths = new Set(desiredLinks.map(({ path }) => path));
  const desiredMountRoots = new Set(mounts.map(({ root }) => root));
  const retiredMountRoots = (priorManifest?.mounts ?? [])
    .map((mount) => mount.root)
    .filter(
      (mountRoot) =>
        !desiredMountRoots.has(mountRoot) && RETIRED_PROJECT_SKILL_MOUNT_ROOTS.has(mountRoot),
    );
  const staleLinks = (priorManifest?.mounts ?? [])
    .flatMap(({ root, skills }) => skills.map((id) => skillLink(projectRoot, root, id)))
    .filter(({ path }) => !desiredPaths.has(path));
  for (const [links, code] of [
    [desiredLinks, 'skill-mount-conflict'],
    [staleLinks, 'skill-stale-mount-conflict'],
  ] as const) {
    for (const link of links) {
      if ((await linkStatus(link)) === 'foreign')
        throw new Error(`${code}: ${slash(relative(projectRoot, link.path))}`);
    }
  }

  const ignoreSnapshots = new Map<string, string | undefined>();
  const createdLinks: string[] = [];
  const removedLinks: SkillLink[] = [];
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
    for (const { directory, ignorePath, links } of mounts) {
      await mkdir(directory, { recursive: true });
      const previous = await readOptional(ignorePath);
      ignoreSnapshots.set(ignorePath, previous);
      await writeFile(ignorePath, updateManagedGitignore(previous ?? '', ids));
      for (const { path, target } of links) {
        if ((await pathKind(path)) === 'missing') {
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
      mounts: mounts.map(({ root }) => ({ root, skills: ids })),
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
  return installedSkillsReport(projectRoot, ids);
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
  for (const [index, mount] of skillMounts(projectRoot, ids).entries()) {
    const declared = manifest.mounts[index];
    if (declared === undefined || JSON.stringify(declared.skills) !== JSON.stringify(ids))
      throw new Error(`skill-install-manifest-mount-drift: ${mount.root}`);
    const ignore = await readOptional(mount.ignorePath);
    if (ignore === undefined || updateManagedGitignore(ignore, ids) !== ignore)
      throw new Error(`skill-mount-gitignore-drift: ${mount.root}`);
    for (const link of mount.links)
      if ((await linkStatus(link)) !== 'owned')
        throw new Error(`skill-mount-drift: ${slash(relative(projectRoot, link.path))}`);
  }
  return installedSkillsReport(projectRoot, ids);
}

async function runSkillCommand(
  operation: 'install' | 'verify',
  options: ProjectCommandOptions,
): Promise<CommandResult<SkillInstallReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const run = operation === 'install' ? installProjectSkills : verifyProjectSkills;
  try {
    return { ok: true, value: await run(facts.value.root) };
  } catch (cause) {
    return { ok: false, error: commandError(cause, `skill-${operation}-failed`) };
  }
}

export function skillInstallCommand(options: ProjectCommandOptions = {}) {
  return runSkillCommand('install', options);
}

export function skillVerifyCommand(options: ProjectCommandOptions = {}) {
  return runSkillCommand('verify', options);
}
