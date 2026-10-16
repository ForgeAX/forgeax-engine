import {
  domainFailureError,
  type ToolDomainFailure,
  type ToolTerminal,
} from '@forgeax/engine-tool-runtime';

export const retiredPreviewOperationFailure: ToolDomainFailure = {
  code: 'preview-operation-migrated',
  expected: 'a domain-specific preview contribution selected from the project catalog',
  hint: 'Use material.preview, mesh.preview, vfx.preview, or texture.preview with a Project GUID.',
  detail: {
    operation: 'preview.run',
    replacements: [
      'asset.material.preview',
      'asset.mesh.preview',
      'asset.vfx.preview',
      'asset.texture.preview',
    ],
  },
};

export function retiredPreviewTool(): ToolTerminal<never> {
  return {
    outcome: 'failed',
    failure: domainFailureError(
      retiredPreviewOperationFailure.code,
      retiredPreviewOperationFailure.expected,
      retiredPreviewOperationFailure.hint,
      retiredPreviewOperationFailure.detail,
    ),
    artifacts: [],
  };
}
