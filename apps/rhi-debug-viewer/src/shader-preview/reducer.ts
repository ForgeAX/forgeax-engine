import type { PreviewError } from './errors';

export interface ShaderPreviewArtifact {
  readonly provenance: 'preview';
  readonly generation: number;
  readonly key: string;
  readonly source: string;
  readonly pixels?: Uint8Array;
}

export interface ShaderPreviewState {
  readonly status: 'idle' | 'applying' | 'success' | 'error';
  readonly generation: number;
  readonly preview: ShaderPreviewArtifact | null;
  readonly error: PreviewError | null;
}

export type ShaderPreviewAction =
  | { readonly type: 'apply-start'; readonly generation: number }
  | {
      readonly type: 'apply-success';
      readonly generation: number;
      readonly provenance: 'preview';
      readonly pixels?: Uint8Array;
      readonly key?: string;
      readonly source?: string;
    }
  | {
      readonly type: 'apply-error';
      readonly generation: number;
      readonly error: PreviewError;
    }
  | { readonly type: 'reset'; readonly generation: number }
  | { readonly type: 'dispose'; readonly generation: number };

export function initialShaderPreviewState(): ShaderPreviewState {
  return { status: 'idle', generation: 0, preview: null, error: null };
}

export function reduceShaderPreview(
  state: ShaderPreviewState,
  action: ShaderPreviewAction,
): ShaderPreviewState {
  if (action.generation < state.generation) return state;
  switch (action.type) {
    case 'apply-start':
      return { status: 'applying', generation: action.generation, preview: null, error: null };
    case 'apply-success':
      if (action.generation !== state.generation) return state;
      return {
        status: 'success',
        generation: action.generation,
        error: null,
        preview: {
          provenance: action.provenance,
          generation: action.generation,
          key: action.key ?? '',
          source: action.source ?? '',
          ...(action.pixels === undefined ? {} : { pixels: action.pixels }),
        },
      };
    case 'apply-error':
      if (action.generation !== state.generation) return state;
      return { status: 'error', generation: action.generation, preview: null, error: action.error };
    case 'reset':
    case 'dispose':
      return { status: 'idle', generation: action.generation, preview: null, error: null };
  }
}
