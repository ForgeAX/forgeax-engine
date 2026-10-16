import type { CBFile, CBFileFamily, CBViewItem } from './types';

export const ALL_FILTER_FAMILIES = [
  'dir', 'scene', 'pack', 'meta', 'model', 'image', 'audio', 'font', 'ui', 'code', 'config', 'doc', 'data',
] as const;

/** Sub-asset kinds for the filter menu. `scene` is omitted — use file type Scene instead. */
export const FILTERABLE_ASSET_KINDS = [
  'plugin',
  'mesh',
  'material',
  'texture',
  'equirect',
  'cube-texture',
  'animation-clip',
  'skeleton',
  'audio',
  'font',
  'ui',
] as const;

const ASSET_FILE_FAMILIES: Readonly<Record<string, CBFileFamily>> = {
  scene: 'scene',
  mesh: 'model',
  texture: 'image',
  equirect: 'image',
  'cube-texture': 'image',
  audio: 'audio',
  font: 'font',
  ui: 'ui',
  plugin: 'code',
};

export function assetFileFamilyOf(kind: string): CBFileFamily | undefined {
  return ASSET_FILE_FAMILIES[kind];
}

const SOURCE_TEXT_FAMILIES: ReadonlySet<CBFileFamily> = new Set([
  'code', 'config', 'doc', 'data', 'pack', 'meta', 'scene',
]);
const SOURCE_VIEW_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json']);

export function dirOfPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Sanitise a typed address into a project-relative path (`''` = root). */
export function normalizePathInput(raw: string): string {
  return raw.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

export function viewItemKey(item: CBViewItem): string {
  return item.type === 'asset' ? item.guid : item.path;
}

export function isResourceGroup(assetCount: number): boolean {
  return assetCount > 1;
}

export function isPackSourceFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.pack.ts') || lower.endsWith('.pack.json');
}

export function fileFamilyOf(name: string): CBFileFamily {
  const lower = name.toLowerCase();
  if (lower.endsWith('.meta.json')) return 'meta';
  if (lower.endsWith('.pack.ts')) return 'pack';
  if (lower.endsWith('.pack.json')) return lower.includes('scene') ? 'scene' : 'pack';
  if (lower.endsWith('.scene.json') || lower === 'scene.json') return 'scene';
  if (lower.endsWith('.colliders.json')) return 'data';
  const ext = lower.split('.').pop() ?? '';
  if (['html', 'css', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'].includes(ext)) return 'code';
  if (['json', 'lock'].includes(ext)) return 'config';
  if (['md', 'markdown', 'txt'].includes(ext)) return 'doc';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'hdr'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'].includes(ext)) return 'audio';
  if (['glb', 'gltf', 'fbx'].includes(ext)) return 'model';
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return 'font';
  return 'other';
}

export function fileFamilyOfWithAssets(
  name: string,
  assets: readonly { kind: string }[],
): CBFileFamily {
  if (name.toLowerCase().endsWith('.pack.ts')) return 'pack';
  const byName = fileFamilyOf(name);
  if (byName === 'pack' && assets.some((asset) => asset.kind === 'scene')) return 'scene';
  return byName;
}

export function isSourceViewableFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pack.json') || lower.endsWith('.pack.ts')) return true;
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : lower;
  return SOURCE_VIEW_EXTENSIONS.has(ext);
}

export function fileSupportsDualPreview(
  file: Pick<CBFile, 'family' | 'assets' | 'name'>,
): boolean {
  if (file.assets.length === 0) return false;
  return SOURCE_TEXT_FAMILIES.has(file.family) || isSourceViewableFileName(file.name);
}

export function resolveDualPreviewFile(
  item: CBViewItem,
  diskFiles: readonly CBFile[],
): CBFile | undefined {
  if (item.type === 'file') return item;
  if (item.type === 'asset') return diskFiles.find((file) => file.path === item.packPath);
  return undefined;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(ms: number | undefined): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export function compareItems(
  a: CBViewItem,
  b: CBViewItem,
  key: 'name' | 'kind' | 'packModifiedAt' | 'estimatedSize',
  dir: 'asc' | 'desc',
): number {
  const sign = dir === 'desc' ? -1 : 1;
  if (key === 'kind') {
    return sign * itemKind(a).localeCompare(itemKind(b)) || sign * a.name.localeCompare(b.name);
  }
  if (key === 'packModifiedAt') {
    return sign * ((itemModified(a) - itemModified(b)) || a.name.localeCompare(b.name));
  }
  if (key === 'estimatedSize') {
    return sign * ((itemSize(a) - itemSize(b)) || a.name.localeCompare(b.name));
  }
  return sign * a.name.localeCompare(b.name);
}

function itemKind(item: CBViewItem): string {
  if (item.type === 'folder') return 'folder';
  if (item.type === 'file') return item.kindLabel || item.family;
  return item.kind;
}

function itemModified(item: CBViewItem): number {
  if (item.type === 'asset') return item.packModifiedAt ?? 0;
  if (item.type === 'file') return item.packModifiedAt ?? 0;
  return 0;
}

function itemSize(item: CBViewItem): number {
  if (item.type === 'asset') return item.estimatedSize ?? 0;
  if (item.type === 'file') return item.estimatedSize ?? 0;
  return 0;
}

export function matchesSearch(item: CBViewItem, query: string): boolean {
  if (!query) return true;
  if (item.type === 'folder') {
    return item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query);
  }
  if (item.type === 'file') {
    return item.name.toLowerCase().includes(query)
      || item.path.toLowerCase().includes(query)
      || item.assets.some((asset) => asset.name.toLowerCase().includes(query) || asset.kind.toLowerCase().includes(query));
  }
  return item.name.toLowerCase().includes(query)
    || item.guid.toLowerCase().startsWith(query)
    || item.kind.toLowerCase().includes(query);
}
