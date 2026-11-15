import { pmremLevelCount } from '../../ibl/pmrem';
import type { GpuPassTimingEntry, GpuPassTimingFrame } from './contract';
import { summarizeGpuPassTimingIntervals } from './parser';
import {
  ATMOSPHERE_PREFILTER_SIZE,
  ATMOSPHERE_SKY_FACES,
  AtmosphereLutPass,
  AtmosphereRasterLutPass,
  atmosphereIrradiancePass,
  atmospherePrefilterCopyPass,
  atmospherePrefilterPass,
  atmosphereSkyCubePass,
  SkyPass,
} from './sky-pass-names';

export type SkyGpuPassTimingGroup =
  | { readonly status: 'ready'; readonly milliseconds: number; readonly passCount: number }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface SkyGpuPassTimingSummary {
  readonly completeSky: SkyGpuPassTimingGroup;
  readonly cloud: SkyGpuPassTimingGroup;
}

const cloudPasses: ReadonlySet<string> = new Set([
  SkyPass.cloudShadow,
  SkyPass.cloudShadowFilter,
  SkyPass.cloudAnalyticTrace,
  SkyPass.cloudSampledTrace,
  SkyPass.cloudHistoryClear,
  SkyPass.cloudReconstruction,
  SkyPass.cloudResolve,
]);

const atmosphereAndFogPasses: ReadonlySet<string> = new Set([
  ...Object.values(AtmosphereLutPass),
  ...Object.values(AtmosphereRasterLutPass),
  SkyPass.atmosphereBackground,
  SkyPass.atmosphereComposition,
  SkyPass.analyticFog,
  SkyPass.volumeInject,
  SkyPass.volumeIntegrate,
  SkyPass.volumeTemporal,
  SkyPass.volumeComposite,
  ...Array.from({ length: ATMOSPHERE_SKY_FACES }, (_, face) => [
    atmosphereSkyCubePass(face),
    atmosphereIrradiancePass(face),
  ]).flat(),
  ...Array.from({ length: pmremLevelCount(ATMOSPHERE_PREFILTER_SIZE) }, (_, level) => [
    atmospherePrefilterPass(level),
    atmospherePrefilterCopyPass(level),
  ]).flat(),
]);

function unavailable(reason: string): SkyGpuPassTimingGroup {
  return { status: 'unavailable', reason };
}

function summarize(
  passes: readonly GpuPassTimingEntry[],
  timestampPeriodNanoseconds: number,
): SkyGpuPassTimingGroup {
  if (passes.length === 0) return unavailable('no-selected-passes');
  const unmeasured = passes.find((pass) => pass.status === 'unmeasured');
  if (unmeasured !== undefined) return unavailable(unmeasured.reason.code);
  const summary = summarizeGpuPassTimingIntervals(passes, timestampPeriodNanoseconds);
  if (!summary.ok) return unavailable(summary.error.code);
  const milliseconds = summary.value.unionNanoseconds / 1_000_000;
  if (milliseconds === 0) return unavailable('timestamp-resolution');
  return { status: 'ready', milliseconds, passCount: summary.value.measuredPassCount };
}

/**
 * Union the recorded Standard view intervals for physical sky, clouds and enabled fog
 * in this receipt. Independent captures have no view ID. Shared sky LUTs and
 * atmosphere-owned lighting filters are included when they execute in a view.
 * The cloud group counts cloud producers only, including shadow and reconstruction.
 */
export function summarizeSkyGpuPassTiming(frame: GpuPassTimingFrame): SkyGpuPassTimingSummary {
  if (frame.droppedPassCount !== 0 || frame.passes.length !== frame.executedPassCount) {
    const dropped = unavailable('query-budget-exceeded');
    return { completeSky: dropped, cloud: dropped };
  }
  const sky: GpuPassTimingEntry[] = [];
  const cloud: GpuPassTimingEntry[] = [];
  for (const pass of frame.passes) {
    if (pass.viewId === undefined) continue;
    if (cloudPasses.has(pass.passName)) {
      sky.push(pass);
      cloud.push(pass);
    } else if (atmosphereAndFogPasses.has(pass.passName)) {
      sky.push(pass);
    }
  }
  return {
    completeSky: summarize(sky, frame.timestampPeriodNanoseconds),
    cloud: summarize(cloud, frame.timestampPeriodNanoseconds),
  };
}
