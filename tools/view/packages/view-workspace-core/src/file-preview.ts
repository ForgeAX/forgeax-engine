import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import type { WorkspaceProject } from './contract.ts';
import { workspaceError } from './contract.ts';

/**
 * Editor `/api/files` classify() equivalent. Unknown extensions are text so
 * `.pack.json` / `.pack.ts` / `.ts` / `.js` decode as UTF-8. Binary kinds skip
 * decode and leave `content` unset — the preview then shows the no-text note.
 */
const EXT_KIND: Readonly<Record<string, { kind: string; mime: string }>> = Object.freeze({
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.ico': { kind: 'image', mime: 'image/x-icon' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.glb': { kind: 'model', mime: 'model/gltf-binary' },
  '.gltf': { kind: 'model', mime: 'model/gltf+json' },
  '.fbx': { kind: 'model', mime: 'application/octet-stream' },
  '.ttf': { kind: 'binary', mime: 'font/ttf' },
  '.otf': { kind: 'binary', mime: 'font/otf' },
  '.woff': { kind: 'binary', mime: 'font/woff' },
  '.woff2': { kind: 'binary', mime: 'font/woff2' },
});

/** Inline data URLs for browser media preview in the content browser. */
export const MAX_BINARY_PREVIEW_BYTES = 10 * 1024 * 1024;

const BINARY_PREVIEW_KINDS = new Set(['image', 'audio', 'video', 'binary']);

export function classifyFile(path: string) {
  const ext = extname(path).toLowerCase();
  return EXT_KIND[ext] ?? { kind: 'text', mime: 'text/plain; charset=utf-8' };
}

export function resolveProjectFilePath(root: unknown, input: unknown) {
  if (typeof root !== 'string' || root.trim() === '') return null;
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) return null;
  const rootAbs = resolve(root);
  const abs = isAbsolute(input) ? resolve(input) : resolve(rootAbs, input);
  const rel = relative(rootAbs, abs);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const normalized = rel.split(/[/\\]/).join('/');
  if (normalized === '.forgeax/ddc' || normalized.startsWith('.forgeax/ddc/')) return null;
  return { abs, rel: normalized };
}

export async function readFilePreview(absPath: string, rel: string) {
  let info;
  try {
    info = await stat(absPath);
  } catch {
    throw new Error('not found');
  }
  if (info.isDirectory()) throw new Error('is a directory');
  const ext = extname(rel).toLowerCase();
  const { kind, mime } = classifyFile(rel);
  const base = { path: rel, kind, mime, size: info.size, mtime: info.mtimeMs };
  if (kind === 'text') {
    const content = await readFile(absPath, 'utf8');
    return { ...base, content };
  }
  if (kind === 'image' && ext === '.svg') {
    const content = await readFile(absPath, 'utf8');
    return { ...base, content };
  }
  if (BINARY_PREVIEW_KINDS.has(kind)) {
    if (info.size > MAX_BINARY_PREVIEW_BYTES) return base;
    const buffer = await readFile(absPath);
    return { ...base, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  }
  return base;
}

export async function readWorkspaceFilePreview(workspace: { project?: WorkspaceProject | null } | undefined, payload: { path?: unknown } = {}) {
  const root = workspace?.project?.root;
  if (typeof root !== 'string' || root.trim() === '') {
    throw workspaceError(
      'view-workspace-project-closed',
      'an open project',
      'Open a project before previewing source files.',
    );
  }
  const resolved = resolveProjectFilePath(root, payload?.path);
  if (!resolved) {
    throw workspaceError(
      'view-workspace-invalid-args',
      'path to be a file inside the open project',
      'Provide a project-relative or in-project absolute path.',
      { field: 'path' },
    );
  }
  try {
    const actualRoot = await realpath(root);
    const actualFile = await realpath(resolved.abs);
    const inside = relative(actualRoot, actualFile);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('outside project');
    return await readFilePreview(resolved.abs, resolved.rel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('is a directory')) {
      throw workspaceError(
        'view-workspace-invalid-args',
        'a file path',
        message,
        { path: resolved.rel },
      );
    }
    if (message === 'outside project') throw workspaceError('view-workspace-invalid-args', 'path to remain inside the open project', 'Use a file inside this project.', { path: resolved.rel });
    throw workspaceError(
      'view-workspace-file-not-found',
      'the file to exist in the open project',
      'Refresh the content browser and retry.',
      { path: resolved.rel },
    );
  }
}

/** Bounded inventory of standalone HTML documents for Content Browser. */
export async function listWorkspaceHtmlFiles(workspace: { project?: WorkspaceProject | null } | undefined) {
  const root = workspace?.project?.root;
  if (typeof root !== 'string' || !root) throw workspaceError('view-workspace-project-closed', 'an open project', 'Open a project before listing HTML files.');
  const files: string[] = [];
  const queue = [...(workspace?.project?.assetRoots ?? [])];
  let visited = 0;
  const directories = new Set<string>();
  while (queue.length && visited < 5000 && files.length < 500) {
    const directory = queue.shift()!;
    if (directories.has(directory)) continue;
    directories.add(directory);
    let entries;
    try {
      const path = resolve(root, directory);
      if (await realpath(path) !== path) continue;
      entries = await readdir(path, { withFileTypes: true });
    }
    catch { continue; }
    for (const entry of entries) {
      if (++visited > 5000) break;
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) files.push(path);
      if (files.length >= 500) break;
    }
  }
  return { files, hasMore: queue.length > 0 || visited >= 5000 || files.length >= 500 };
}
