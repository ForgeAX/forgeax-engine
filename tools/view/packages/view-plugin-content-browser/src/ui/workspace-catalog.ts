import { fileFamilyOfWithAssets, isPackSourceFileName, isResourceGroup } from './format';
import type { CBAsset, CBFile, CBFolder } from './types';

export interface CatalogAsset {
  guid: string;
  kind: string;
  name?: string;
  label?: string;
  sourceKey?: string | number;
  sourcePath?: string;
  path?: string;
  publicationId?: string;
  lifecycle?: CBAsset['lifecycle'];
}
export interface PackSourceRow {
  sourcePath: string;
  revision?: string;
  diagnostic?: { code: string; hint: string };
}

/** A source belongs to the browser only when it is inside an authored asset directory. */
export function assetSourcePath(root: string, assetRoots: readonly string[], source: string) {
  const prefix = `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
  const normalized = source.replaceAll('\\', '/').replace(/^\.\//, '');
  const path = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
  if (path.startsWith('/') || /^[a-z]:\//i.test(path) || path.split('/').some(part => part === '..' || part === '.' || part === '')) return undefined;
  return assetRoots.some(directory => path.startsWith(`${directory}/`)) ? path : undefined;
}

/** Presentation of configured authoring sources, never a filesystem inventory. */
export function projectCatalog({ root, assetRoots, assets, sources = [], htmlFiles = [] }: {
  root: string; assetRoots: readonly string[]; assets: readonly CatalogAsset[];
  sources?: readonly PackSourceRow[]; htmlFiles?: readonly string[];
}) {
  const files = new Map<string, CBFile>();
  for (const asset of assets) {
    const source = asset.sourcePath ?? asset.path;
    if (!source) continue;
    const path = assetSourcePath(root, assetRoots, source);
    if (!path) continue;
    let file = files.get(path);
    if (!file) {
      file = { type: 'file', path, diskPath: source, name: path.split('/').at(-1)!,
        family: 'pack', assets: [], isAssetPackage: false, kindLabel: '' };
      files.set(path, file);
    }
    const item: CBAsset = { type: 'asset', guid: asset.guid, kind: asset.kind,
      name: String((source.toLowerCase().endsWith('.pack.ts') ? asset.sourceKey : undefined)
        ?? asset.name ?? asset.label ?? asset.guid), packPath: path, publicationId: asset.publicationId, lifecycle: asset.lifecycle };
    file.assets.push(item);
    file.family = fileFamilyOfWithAssets(file.name, file.assets);
    file.isAssetPackage = isPackSourceFileName(file.name) || isResourceGroup(file.assets.length);
  }
  for (const source of sources) {
    const path = assetSourcePath(root, assetRoots, source.sourcePath);
    if (!path || !isPackSourceFileName(path)) continue;
    let file = files.get(path);
    if (!file) {
      file = { type: 'file', path, diskPath: path, name: path.split('/').at(-1)!, family: 'pack', assets: [], isAssetPackage: true, kindLabel: '' };
      files.set(path, file);
    }
    file.isAssetPackage = true;
    if (source.diagnostic) file.diagnostic = source.diagnostic;
  }
  for (const source of htmlFiles) {
    const path = assetSourcePath(root, assetRoots, source);
    if (!path || !path.toLowerCase().endsWith('.html')) continue;
    const existing = files.get(path);
    if (existing) {
      existing.diskPath = path;
      existing.family = 'ui';
      existing.isAssetPackage = false;
      existing.kindLabel = 'HTML';
      continue;
    }
    files.set(path, { type: 'file', path, diskPath: path, name: path.split('/').at(-1)!, family: 'ui', assets: [], isAssetPackage: false, kindLabel: 'HTML' });
  }
  const folders = new Map<string, CBFolder>();
  for (const source of [...assetRoots.map(path => `${path}/`), ...files.keys()]) {
    const parts = source.split('/').slice(0, -1);
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join('/');
      if (!folders.has(path)) folders.set(path, { type: 'folder', path, name: parts[index]!, childCount: 0 });
    }
  }
  for (const folder of folders.values()) {
    folder.childCount = [...folders.values(), ...files.values()].filter((item) =>
      item.path.slice(0, item.path.lastIndexOf('/')) === folder.path).length;
  }
  return { files: [...files.values()], folders: [...folders.values()] };
}

export function visibleCatalogFolders(folders: readonly CBFolder[], collapsed: ReadonlySet<string>) {
  return folders.filter((folder) => {
    const parts = folder.path.split('/');
    return parts.every((_, index) => index === 0 || !collapsed.has(parts.slice(0, index).join('/')));
  }).sort((left, right) => {
    const a = left.path.split('/');
    const b = right.path.split('/');
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const order = a[index]!.localeCompare(b[index]!);
      if (order !== 0) return order;
    }
    return a.length - b.length;
  });
}
