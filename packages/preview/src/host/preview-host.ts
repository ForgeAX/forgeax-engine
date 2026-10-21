import type { Plugin } from '@forgeax/engine-plugin';
import {
  type ArtifactRef,
  defineToolCapability,
  type SnapshotRef,
} from '@forgeax/engine-tool-runtime';

export interface PreviewRenderRuntime {
  readonly rendererReady: boolean;
  readonly worldReady: boolean;
  readonly drawCalls: number;
  readonly nonBlackPixels: number;
  /**
   * Facts read back from the real render/asset owner path. Domain executors
   * must not manufacture observed identity from the requested subject.
   */
  readonly observation?: Readonly<Record<string, string | number | boolean | readonly number[]>>;
  readonly vfx?: {
    readonly dispatches: number;
    readonly indirectDraws: number;
    readonly subjectOutputs: number;
  };
  readonly texture?: {
    readonly drawCalls: number;
  };
}

export interface PreviewHostMechanisms {
  readonly runId: string;
  readonly snapshot: SnapshotRef;
  readonly projectRoot: string;
  readonly backend: 'webgpu';
  readonly signal: AbortSignal;
  /** Fixed source facts admitted by the Host before this bounded preview session. */
  readonly subject?: {
    readonly guid: string;
    readonly asset: Readonly<Record<string, unknown>>;
    readonly digest?: string;
    readonly ownerFacts?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly renderer?: PreviewRenderRuntime;
  readonly artifacts?: readonly ArtifactRef[];
}

export interface PreviewHost {
  readonly withSession: <T>(
    execute: (mechanisms: PreviewHostMechanisms) => Promise<T>,
  ) => Promise<T>;
}

export const previewHostCapability = defineToolCapability<PreviewHost>('preview.host');

export function previewHostPlugin(host: PreviewHost): Plugin {
  return {
    name: 'forgeax-preview-host',
    provide: previewHostCapability.id,
    apply(ctx) {
      ctx.provide(previewHostCapability.id, host);
    },
  };
}

export function bindPreviewHost(plugin: Plugin, host: PreviewHost): Plugin {
  return {
    name: 'forgeax:preview-session',
    apply(ctx) {
      ctx.plugin(previewHostPlugin(host));
      ctx.plugin(plugin);
    },
  };
}

export function createPreviewHost(input: PreviewHostMechanisms): PreviewHost {
  let active = true;
  return {
    async withSession(execute) {
      if (!active || input.signal.aborted) throw new Error('preview-host-session-terminal');
      try {
        return await execute(input);
      } finally {
        active = false;
      }
    },
  };
}
