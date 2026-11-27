import materialPreviewPlugin, { materialPreview } from '@forgeax/engine-preview/material';
import meshPreviewPlugin, { meshPreview } from '@forgeax/engine-preview/mesh';
import texturePreviewPlugin, { texturePreview } from '@forgeax/engine-preview/texture';
import vfxPreviewPlugin, { vfxPreview } from '@forgeax/engine-preview/vfx';
import {
  domainFailureError,
  type ToolContribution,
  type ToolDomainFailure,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';
import { failToolRun } from '../types.js';

const nativePreviewPlugins = [
  ['material', materialPreviewPlugin, materialPreview],
  ['mesh', meshPreviewPlugin, meshPreview],
  ['vfx', vfxPreviewPlugin, vfxPreview],
  ['texture', texturePreviewPlugin, texturePreview],
] as const;
export const nativePreviewTools = nativePreviewPlugins.map(
  ([, , tool]) => tool as ToolContribution,
);
export const nativePreviewDescriptors = nativePreviewTools.map(({ descriptor }) => descriptor);

const previewByOperation = new Map(
  nativePreviewPlugins.map((entry) => [entry[2].descriptor.id, entry]),
);

export function nativePreviewOwner(operation: string) {
  return previewByOperation.get(operation);
}

export const retiredPreviewOperationFailure: ToolDomainFailure = {
  code: 'preview-operation-migrated',
  expected: 'a domain-specific preview contribution selected from the project catalog',
  hint: 'Use material.preview, mesh.preview, vfx.preview, or texture.preview with a Project GUID.',
  detail: {
    operation: 'preview.run',
    replacements: nativePreviewDescriptors.map(({ id }) => id),
  },
};

export function retiredPreviewTool(): ToolTerminal<never> {
  return failToolRun(
    domainFailureError(
      retiredPreviewOperationFailure.code,
      retiredPreviewOperationFailure.expected,
      retiredPreviewOperationFailure.hint,
      retiredPreviewOperationFailure.detail,
    ),
    [],
  );
}
