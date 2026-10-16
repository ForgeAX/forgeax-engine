import {
  Box,
  Clapperboard,
  File,
  FileCode2,
  FileText,
  Image,
  Music,
  Package,
  Puzzle,
  Settings2,
  Type,
  type LucideIcon,
} from 'lucide-react';

export type PageKind =
  | 'scene'
  | 'model'
  | 'image'
  | 'audio'
  | 'font'
  | 'pack'
  | 'code'
  | 'doc'
  | 'config'
  | 'plugin';

const ICON_BY_KIND: Record<PageKind, LucideIcon> = {
  scene: Clapperboard,
  model: Box,
  image: Image,
  audio: Music,
  font: Type,
  pack: Package,
  code: FileCode2,
  doc: FileText,
  config: Settings2,
  plugin: Puzzle,
};

const EXT_KIND: ReadonlyArray<readonly [readonly string[], PageKind]> = [
  [['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py'], 'code'],
  [['md', 'markdown', 'txt'], 'doc'],
  [['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'hdr'], 'image'],
  [['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'], 'audio'],
  [['glb', 'gltf', 'fbx'], 'model'],
  [['ttf', 'otf', 'woff2'], 'font'],
];

export function pageKindOf(input: { typeId: string; resourcePath?: string }): PageKind {
  const path = (input.resourcePath ?? '').toLowerCase();
  if (path) {
    if (path.endsWith('.scene.json')) return 'scene';
    if (path.endsWith('.pack.json')) return path.includes('scene') ? 'scene' : 'pack';
    const ext = path.split(/[?#]/u, 1)[0]?.split('.').pop() ?? '';
    for (const [exts, kind] of EXT_KIND) if (exts.includes(ext)) return kind;
    if (path.endsWith('forge.json') || path.endsWith('package.json')) return 'config';
  }
  const id = input.typeId.toLowerCase();
  for (const kind of Object.keys(ICON_BY_KIND) as PageKind[]) {
    if (id.includes(kind)) return kind;
  }
  if (id.includes('scene') || id.includes('level')) return 'scene';
  if (id.includes('workbench') || id.includes('wb-') || id.includes('plugin')) return 'plugin';
  return 'config';
}

export function iconForPage(input: { typeId: string; resourcePath?: string }): LucideIcon {
  const path = (input.resourcePath ?? '').toLowerCase();
  const kind = pageKindOf(input);
  if (!path && kind === 'config' && !input.typeId.toLowerCase().includes('config')) return File;
  return ICON_BY_KIND[kind];
}
