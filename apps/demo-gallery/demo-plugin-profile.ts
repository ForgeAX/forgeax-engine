import type { ProducerReadiness } from '@forgeax/engine-import';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type { Importer, RuntimeAssetBinding } from '@forgeax/engine-types';
import type { ForgeAXShaderOptions } from '@forgeax/engine-vite-plugin-shader';
import type { Plugin } from 'vite';

export interface DemoPackProfile {
  runtimeBinding?: RuntimeAssetBinding;
  roots: readonly string[];
  importers: readonly Importer[];
  cookers: readonly NativeCooker[];
  producerReadiness?: ProducerReadiness;
  projectDdcRoot?: string;
}

export interface DemoPluginProfile {
  route: string;
  consumerRoot: string;
  pack?: DemoPackProfile;
  shader?: ForgeAXShaderOptions;
  extraPlugins: readonly Plugin[];
}

export function packProfileKey(profile: DemoPackProfile | undefined): string {
  if (profile === undefined) return '__none__';
  const scope = profile.runtimeBinding?.scopeId ?? 'unbound';
  return `${scope}:${profile.roots.join('|')}:${profile.projectDdcRoot ?? ''}`;
}
