import {
  createRhiDebugError,
  type InspectField,
  openReplay,
  type ReadbackSubresource,
  type ReplayReadbackResult,
  type ReplaySession,
  type RhiDebugError,
  replayDeviceRequest,
  type V7Tape,
} from '@forgeax/engine-rhi-debug';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createContext, useContext } from 'react';
import type { InspectWork, ViewerArtifactRef, ViewerModel } from './viewer-model';

export interface ViewerReplay {
  readonly session: ReplaySession | null;
  readonly inspectWork: InspectWork;
  readonly readResource: ReadResource;
  readonly capability: ViewerShellCapability;
  readonly error: RhiDebugError | null;
  readonly dispose: () => Promise<void>;
}

export type ViewerShellCapability =
  | { readonly kind: 'no-webgpu'; readonly message: string }
  | { readonly kind: 'backend-unavailable'; readonly message: string }
  | { readonly kind: 'webgpu'; readonly message: string }
  | { readonly kind: 'core-error'; readonly error: RhiDebugError };

export type ReadResource = (
  resourceId: string,
  subresource?: ReadbackSubresource,
  signal?: AbortSignal,
) => Promise<Result<ReplayReadbackResult, RhiDebugError>>;

export interface ViewerContextValue {
  readonly model: ViewerModel;
  readonly tape: V7Tape | null;
  readonly inspectWork: InspectWork;
  readonly readResource: ReadResource;
  readonly capability?: ViewerShellCapability;
}

export interface ViewerSelectionSnapshot {
  readonly selectedWorkIndex: number;
  readonly selectedCommandIndex: number;
  readonly selectedEventIndex: number;
  readonly selectedPassIndex: number;
  readonly selectedResourceId: string | null;
  readonly selectedSubresource: ReadbackSubresource | null;
}

/** Stable, read-only browser handoff; replay and layout owners stay private. */
export interface RhiDebugViewerGlobal {
  readonly model: ViewerModel;
  readonly artifactRef: ViewerArtifactRef | null;
  readonly inspectWork: InspectWork;
  readonly readResource: ReadResource;
  readonly capability: ViewerShellCapability;
  readonly selection: ViewerSelectionSnapshot;
}

export const ViewerContext = createContext<ViewerContextValue | null>(null);
export const ViewModelContext = createContext<ViewerModel | null>(null);
export const TapeContext = createContext<V7Tape | null>(null);

export function viewerShellCapability(error?: RhiDebugError | null): ViewerShellCapability {
  if (error !== undefined && error !== null) return { kind: 'core-error', error };
  if (typeof navigator === 'undefined' || navigator.gpu === undefined)
    return {
      kind: 'no-webgpu',
      message: 'WebGPU is unavailable; structural tape inspection remains available',
    };
  return { kind: 'backend-unavailable', message: 'A WebGPU backend is not connected' };
}

export function viewerNoWebGpuError(): RhiDebugError {
  return {
    ...createRhiDebugError('readback-unsupported', {
      stage: 'readback',
      reason: 'WebGPU is unavailable in this host; viewer structure remains available',
    }),
    hint: 'open the tape in a WebGPU-capable host to inspect pixels',
  };
}

function backendError(error: { readonly code: string; readonly hint: string }): RhiDebugError {
  if (error.code === 'adapter-unavailable' || error.code === 'rhi-not-available') {
    return viewerNoWebGpuError();
  }
  return createRhiDebugError('readback-failed', {
    stage: 'readback',
    cause: `${error.code}: ${error.hint}`,
  });
}

function unavailableReplay(error: RhiDebugError): ViewerReplay {
  // Keep an unavailable backend as a shell capability while retaining the
  // structured core error on the replay for readback/inspection recovery.
  // This prevents no-WebGPU from being flattened into a generic core-error
  // branch and keeps the structural viewer usable.
  const capability =
    error.code === 'readback-unsupported' ? viewerShellCapability() : viewerShellCapability(error);
  return {
    session: null,
    error,
    capability,
    inspectWork: async () => err(error),
    readResource: async () => err(error),
    dispose: async () => {},
  };
}

function activeReplay(session: ReplaySession): ViewerReplay {
  return {
    session,
    error: null,
    capability: { kind: 'webgpu', message: 'WebGPU fresh replay backend ready' },
    inspectWork: async (
      workIndex: number,
      fields?: readonly InspectField[],
      signal?: AbortSignal,
    ) => {
      const result = await session.inspectWork(workIndex, fields, signal);
      if (!result.ok) return result;
      return ok(result.value);
    },
    readResource: (resourceId, subresource, signal) =>
      session.readResource(resourceId, subresource, signal),
    dispose: async () => {
      await session.dispose();
    },
  };
}

export async function openViewerReplay(tape: V7Tape): Promise<ViewerReplay> {
  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return unavailableReplay(viewerNoWebGpuError());
  }

  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) return unavailableReplay(backendError(adapter.error));

  const device = await adapter.value.requestDevice(
    replayDeviceRequest(tape, adapter.value.features, adapter.value.limits),
  );
  if (!device.ok) return unavailableReplay(backendError(device.error));

  const session = await openReplay(tape, {
    device: device.value,
    createShaderModule,
  });
  if (!session.ok) return unavailableReplay(session.error);
  return activeReplay(session.value);
}

export function useViewerContext(): ViewerContextValue | null {
  return useContext(ViewerContext);
}

export function useViewModel(): ViewerModel | null {
  const viewerContext = useContext(ViewerContext);
  const viewModel = useContext(ViewModelContext);
  return viewerContext?.model ?? viewModel;
}

export function useTape(): V7Tape | null {
  const viewerContext = useContext(ViewerContext);
  const tapeContext = useContext(TapeContext);
  const tape = viewerContext?.tape ?? tapeContext;
  return tape !== null && 'header' in tape ? tape : null;
}

export function useInspectWork(): InspectWork | null {
  return useContext(ViewerContext)?.inspectWork ?? null;
}

export function useReadResource(): ReadResource | null {
  return useContext(ViewerContext)?.readResource ?? null;
}

export function useViewerCapability(): ViewerShellCapability {
  const value = useContext(ViewerContext);
  return value?.capability ?? viewerShellCapability();
}
