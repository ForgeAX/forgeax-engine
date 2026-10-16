import { defineTool, type ToolContribution } from '@forgeax/engine-tool-runtime';
import { previewOfflineAnalysisDescriptor, previewRunDescriptor } from './catalog.js';
import {
  analyzePreviewArtifacts,
  type OfflineAnalysisRequest,
  type OfflineAnalysisResult,
} from './offline-analysis.js';
import type { PreviewHostRequest, PreviewHostResult } from './preview-host.js';
import { retiredPreviewOperationFailure } from './preview-migration.js';

export function createPreviewContribution(): ToolContribution<
  PreviewHostRequest,
  PreviewHostResult
> {
  return defineTool(previewRunDescriptor, async () => ({
    ok: false as const,
    error: retiredPreviewOperationFailure,
  }));
}

export function createOfflineAnalysisContribution(): ToolContribution<
  OfflineAnalysisRequest,
  OfflineAnalysisResult
> {
  return defineTool(
    {
      ...previewOfflineAnalysisDescriptor,
    },
    (request) => analyzePreviewArtifacts(request),
  );
}

export function createPreviewContributions(): readonly ToolContribution<unknown, unknown>[] {
  return [
    createPreviewContribution() as ToolContribution<unknown, unknown>,
    createOfflineAnalysisContribution() as ToolContribution<unknown, unknown>,
  ];
}
