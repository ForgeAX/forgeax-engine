// Low-frequency topology & resize cache for CompiledKernelGraph.
// Recompiles only when surface dimensions, pipeline identity, or topology/feature key changes;
// steady-state frames reuse the cached immutable graph with zero recompilation.

import type { KernelError, Result } from '../errors.js';
import { ok } from '../errors.js';
import { compileKernelRenderPipeline } from './builder.js';
import type { CompiledKernelGraph } from './compiled.js';
import type { KernelRenderFeature, KernelRenderPipeline } from './types.js';

export interface KernelGraphCacheStats {
  readonly compilations: number;
  readonly cacheHits: number;
  readonly activeKey: string | undefined;
}

export class KernelGraphCache<Frame> {
  private activeKey: string | undefined;
  private cached: CompiledKernelGraph<Frame> | undefined;
  private compilations = 0;
  private cacheHits = 0;

  getOrCompile(
    pipeline: KernelRenderPipeline<Frame>,
    features: readonly KernelRenderFeature<Frame>[],
    width: number,
    height: number,
    topologyKey: string,
  ): Result<CompiledKernelGraph<Frame>, KernelError> {
    const w = Math.max(1, width | 0);
    const h = Math.max(1, height | 0);
    const key = `${pipeline.name}|${w}x${h}|${topologyKey}`;
    if (this.cached !== undefined && this.activeKey === key) {
      this.cacheHits += 1;
      return ok(this.cached);
    }
    const res = compileKernelRenderPipeline(pipeline, features, {
      surfaceSize: { width: w, height: h },
    });
    if (!res.ok) return res;
    this.activeKey = key;
    this.cached = res.value;
    this.compilations += 1;
    return res;
  }

  get current(): CompiledKernelGraph<Frame> | undefined {
    return this.cached;
  }

  stats(): KernelGraphCacheStats {
    return {
      compilations: this.compilations,
      cacheHits: this.cacheHits,
      activeKey: this.activeKey,
    };
  }

  invalidate(): void {
    this.activeKey = undefined;
    this.cached = undefined;
  }
}
