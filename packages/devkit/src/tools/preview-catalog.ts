import { bindPreviewHost, type NativePreviewHost } from '@forgeax/engine-preview';
import materialPreviewPlugin, { materialPreview } from '@forgeax/engine-preview/material';
import meshPreviewPlugin, { meshPreview } from '@forgeax/engine-preview/mesh';
import texturePreviewPlugin, { texturePreview } from '@forgeax/engine-preview/texture';
import vfxPreviewPlugin, { vfxPreview } from '@forgeax/engine-preview/vfx';
import type { ToolContribution, ToolDescriptor } from '@forgeax/engine-tool-runtime';

export const nativePreviewPlugins = [
  ['@forgeax/engine-preview/material', materialPreviewPlugin, materialPreview],
  ['@forgeax/engine-preview/mesh', meshPreviewPlugin, meshPreview],
  ['@forgeax/engine-preview/vfx', vfxPreviewPlugin, vfxPreview],
  ['@forgeax/engine-preview/texture', texturePreviewPlugin, texturePreview],
] as const;
export const nativePreviewTools = nativePreviewPlugins.map(
  ([, , tool]) => tool as ToolContribution,
);
export const nativePreviewDescriptors: readonly ToolDescriptor[] = nativePreviewTools.map(
  ({ descriptor }) => descriptor,
);
export function createNativePreviewPlugin(host: NativePreviewHost, name: string) {
  const selected = nativePreviewPlugins.find(([candidate]) => candidate === name);
  if (!selected) throw new TypeError(`unknown preview plugin ${name}`);
  return bindPreviewHost(selected[1], host);
}
