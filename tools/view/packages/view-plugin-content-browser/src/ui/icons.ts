import {
  Bone,
  Box,
  Braces,
  Clapperboard,
  Database,
  File,
  FileCode2,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Globe,
  Image,
  Layers,
  Music,
  Package,
  Paintbrush,
  Puzzle,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { CBFileFamily, CBFilterFamily, CBViewItem } from './types';

const FAMILY_ICONS: Record<CBFilterFamily, LucideIcon> = {
  dir: Folder,
  scene: Clapperboard,
  pack: Package,
  meta: Layers,
  model: Box,
  image: Image,
  audio: Music,
  font: Type,
  ui: Paintbrush,
  code: FileCode2,
  config: Braces,
  doc: FileText,
  data: Database,
  other: File,
};

const KIND_ICONS: Record<string, LucideIcon> = {
  plugin: Puzzle,
  mesh: Box,
  material: Paintbrush,
  texture: Image,
  image: Image,
  equirect: Globe,
  'cube-texture': Globe,
  sampler: Layers,
  'animation-clip': Film,
  'animation-graph': Film,
  skeleton: Bone,
  skin: Bone,
  scene: Clapperboard,
  ui: Paintbrush,
  audio: Music,
  font: Type,
  video: Film,
  tileset: Layers,
  'particle-effect': Layers,
  'render-pipeline': Layers,
};

export function familyIcon(family: CBFilterFamily | CBFileFamily): LucideIcon {
  return FAMILY_ICONS[family] ?? File;
}

export function kindIcon(kind: string): LucideIcon {
  return KIND_ICONS[kind] ?? Package;
}

export function itemIcon(item: CBViewItem, folderOpen = false): LucideIcon {
  if (item.type === 'folder') return folderOpen ? FolderOpen : Folder;
  if (item.type === 'file') return familyIcon(item.family);
  return kindIcon(item.kind);
}
