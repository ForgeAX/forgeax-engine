import { readFileSync } from 'node:fs';
import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import {
  RENDER_PHASE_CATALOG,
  RENDER_RECORD_PHASE_CATALOG,
  RENDER_SCENE_STATE_PHASE_CATALOG,
} from '../render-contract';

describe('Render profiler phase catalog ownership', () => {
  it('matches the profiler receiver set and includes nested record owners', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG).ok).toBe(true);
    expect(RENDER_PHASE_CATALOG).toHaveLength(8 + RENDER_RECORD_PHASE_CATALOG.length);
    expect(new Set(RENDER_PHASE_CATALOG).size).toBe(RENDER_PHASE_CATALOG.length);
    expect(new Set(RENDER_PHASE_CATALOG)).toEqual(new Set(profiler.phaseCatalog.render));
    expect(RENDER_RECORD_PHASE_CATALOG).toEqual(
      expect.arrayContaining([
        'record/gpu-driven-prepare',
        'record/gpu-driven-prepare/plan',
        'record/gpu-driven-prepare/filter',
        'record/gpu-driven-prepare/shadow-views',
        'record/graph-execute/g-buffer/material-bind-groups',
        'record/graph-execute/g-buffer/pipeline-selection',
        'record/graph-execute/g-buffer/draw-submit',
        'record/graph-execute/g-buffer/geometry-loop',
        'record/graph-execute/forward/material-bind-groups',
        'record/graph-execute/forward/pipeline-selection',
        'record/graph-execute/forward/draw-submit',
        'record/graph-execute/forward/geometry-loop',
        'record/graph-execute/depth-pyramid',
        'record/graph-execute/ssr-trace',
        'record/graph-execute/ssr-temporal',
        'record/graph-execute/ssr-reflection-mip',
        'record/graph-execute/ssr-compose',
      ]),
    );
    expect(RENDER_SCENE_STATE_PHASE_CATALOG).toEqual(
      expect.arrayContaining([
        'record/scene-state/fold-buckets',
        'record/scene-state/lighting-prep',
        'record/scene-state/ambient-resolution',
        'record/scene-state/hdrp-cluster',
        'record/scene-state/hdrp-cluster/binner',
        'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy',
        'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy/light-aabb',
        'record/scene-state/hdrp-cluster/binner/light-bounds-and-occupancy/cluster-occupancy',
        'record/scene-state/hdrp-cluster/binner/cluster-reserve',
        'record/scene-state/hdrp-cluster/binner/input-preparation',
        'record/scene-state/hdrp-cluster/binner/bin-core',
        'record/scene-state/hdrp-cluster/binner/light-index-write',
        'record/scene-state/hdrp-cluster/binner/light-index-write/bounds-read',
        'record/scene-state/hdrp-cluster/binner/light-index-write/cluster-write',
        'record/scene-state/hdrp-cluster/buffer-upload',
      ]),
    );
  });

  it('rejects a second Render catalog definition', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG).ok).toBe(true);
    const duplicate = profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('phase-catalog-conflict');
  });

  it('keeps the phase declaration in the Render owner module', () => {
    const source = readFileSync(new URL('../render-contract.ts', import.meta.url), 'utf8');
    expect(source).toContain('RENDER_PHASE_CATALOG');
    expect(source).not.toContain('RenderPhaseObserver');
    expect(source).not.toContain('renderFrameSeq');
  });
});
