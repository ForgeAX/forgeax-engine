import { nativeGradeOverlaysLinearImage } from '../pipeline/standard-output/layout';
import { STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { RenderPipelineTopology } from '../render-pipeline';
import { type AmbientOcclusionSettings, ssaoUsesLighting } from '../ssao-config';
import type { DisplayPorts } from './display-ports';

/** Normalize the fields in physical order even when an optional control first appears. */
function nativeGradeCamera(camera: RenderPipelineTopology['camera'], observeLinear: boolean) {
  const {
    bloomIntensity: _intensity,
    tonemap,
    chromaticAberration: _fringe,
    lensEffects: _lens,
    ...stages
  } = camera;
  return {
    ...stages,
    tonemap: tonemap === 'none' ? 'none' : 'linear',
    lensEffects: nativeGradeOverlaysLinearImage(camera, observeLinear),
  };
}

function aoGraphStructure(config: AmbientOcclusionSettings | undefined) {
  if (!ssaoUsesLighting(config)) return { enabled: false };
  if (config?.method === 'gtao') return config;
  return {
    enabled: true,
    quality: config?.quality,
    maxQuality: config?.maxQuality,
    levels: config?.levels,
  };
}

/** Stock recorders read these parameters from the current frame. */
export function frameGraphTopologyIdentity(
  topology: RenderPipelineTopology,
  stockRecorder: boolean,
  localShadows?: import('../typed-shadow-passes').CurrentShadowViews,
  currentMaterialDepth = false,
  currentTransparency = false,
  currentTransmission = false,
  nativeGrade = false,
  observeLinear = false,
) {
  const camera =
    stockRecorder && nativeGrade
      ? nativeGradeCamera(topology.camera, observeLinear)
      : { ...topology.camera, bloomIntensity: undefined };
  if (!stockRecorder) return { ...topology, camera };
  const standard = topology.pipelineId === STANDARD_PIPELINE_ID;
  return {
    ...topology,
    // Coverage diagnostics belong to the issuing view. Stock passes consume the already-authorized
    // schema and owners in sceneDataBindings. Emitting the complete contributor roster here would
    // couple graph lifetime to entities even when the only requested output is temporal velocity.
    sceneDataAdmission: undefined,
    // A scene with no eligible draws omits the property. A separate policy field
    // keeps the serialized identity independent of its authored insertion order.
    transparency: currentTransparency ? undefined : topology.transparency,
    weightedTransparencyCommands: currentTransparency || undefined,
    // Transmission without a medium places the sorted prefix before its scene copy.
    // Only this ordering transition changes the surrounding graph.
    sortedTransmissionPrefix:
      (!currentTransmission &&
        currentTransparency &&
        (topology.transmissionDemand?.activeCount ?? 0) > 0 &&
        topology.singleLayerMedium !== true &&
        topology.transparency === undefined) ||
      undefined,
    materialSceneDepth: currentMaterialDepth ? undefined : topology.materialSceneDepth,
    ...(localShadows === undefined
      ? {}
      : {
          shadow: {
            ...topology.shadow,
            ...(localShadows.directional !== true || topology.shadow.directional === 'disabled'
              ? {}
              : {
                  directional: {
                    ...topology.shadow.directional,
                    mapSize: 'current',
                    cascadeCount: 'current',
                  },
                }),
            pointCount: localShadows.point ? 'current-atlas-layers' : topology.shadow.pointCount,
            spotCount: localShadows.spot ? 'current-atlas-layers' : topology.shadow.spotCount,
          },
        }),
    output:
      topology.output === undefined
        ? undefined
        : {
            autoExposure: topology.output.autoExposure,
            autoExposureHalfRes: topology.output.autoExposureHalfRes === true,
            whiteBalance: nativeGrade ? undefined : topology.output.whiteBalance,
            colorLut: topology.output.colorLut,
            lutSize: topology.output.lutSize,
          },
    volumetricFog:
      topology.volumetricFog === undefined
        ? undefined
        : {
            ...topology.volumetricFog,
            lightEntity: undefined,
            pointLightEntity: undefined,
            spotLightEntity: topology.volumetricFog.spotLightEntity !== undefined,
            projector: topology.volumetricFog.projector !== undefined,
          },
    camera,
    ...(!standard || topology.config === undefined
      ? {}
      : {
          config: {
            ...topology.config,
            ambientOcclusion: aoGraphStructure(topology.config.ambientOcclusion),
          },
        }),
    ...(!standard || topology.standardProfile === undefined
      ? {}
      : {
          standardProfile: {
            ...topology.standardProfile,
            configurationRevision: undefined,
            // Baked probe storage and the full/half gather belong to the issuing
            // volume. The parent only provides the G-buffer and lighting ports.
            diffuseGi:
              topology.standardProfile.diffuseGi?.gather === 'baked'
                ? 'baked'
                : topology.standardProfile.diffuseGi,
            ambientOcclusion: aoGraphStructure(topology.standardProfile.ambientOcclusion),
          },
        }),
    // Stock translucency selects and orders the current view's actual material groups during recording.
    transmissionDemand:
      currentTransmission || topology.transmissionDemand === undefined
        ? undefined
        : {
            ...topology.transmissionDemand,
            activeCount: topology.transmissionDemand.activeCount === 0 ? 0 : 1,
          },
    ...(topology.ssr === undefined || topology.ssr.status === 'admitted'
      ? {}
      : { ssr: { ...topology.ssr, viewRange: undefined } }),
  };
}

/** Diagnostic facts may retain only values, never a graph, texture owner, scene, or frame. */
interface DisplayGraphFields {
  readonly [name: string]: string | number | boolean | undefined | DisplayGraphFields;
}

export type FrameGraphIdentity = string | DisplayGraphFields;

export function displayGraphIdentity(
  ports: DisplayPorts,
  topology: RenderPipelineTopology,
): DisplayGraphFields {
  const fields = {
    ...ports,
    clusterTextureExtent:
      ports.clusterTextureExtent === undefined ? undefined : { ...ports.clusterTextureExtent },
    deferred: ports.deferred === undefined ? undefined : { ...ports.deferred },
    standardPost: ports.standardPost === undefined ? undefined : { ...ports.standardPost },
  } satisfies DisplayGraphFields;
  return ports.lane === 'forward'
    ? { forwardDisplay: fields }
    : {
        deferredDisplay: fields,
        topology: {
          compactGbuffer: topology.compactGbuffer,
          compactReceiver: topology.compactReceiver,
          deferredPcfLighting: topology.deferredPcfLighting,
        },
      };
}

/** Materialize a public inspection or a legacy wire identity on explicit demand. */
export function frameGraphKeyText(key: FrameGraphIdentity): string {
  return typeof key === 'string' ? key : JSON.stringify(key);
}

function sameDisplayValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = left as DisplayGraphFields;
  const b = right as DisplayGraphFields;
  for (const name in a) if (!sameDisplayValue(a[name], b[name])) return false;
  for (const name in b) if (b[name] !== undefined && !Object.hasOwn(a, name)) return false;
  return true;
}

function displaySample(value: unknown): string {
  return (JSON.stringify(value) ?? 'undefined').slice(0, 400);
}

export interface FrameGraphCompileAttribution {
  readonly dependencies: readonly string[];
  readonly changes: readonly {
    readonly dependency: string;
    readonly before: string;
    readonly after: string;
  }[];
}

/** Attribute a compile from detached wire keys, retaining only its first four value samples. */
export function frameGraphCompileAttribution(
  previousKey: FrameGraphIdentity | undefined,
  nextKey: FrameGraphIdentity,
): FrameGraphCompileAttribution {
  if (previousKey === undefined) return { dependencies: ['cold'], changes: [] };
  let previous: Record<string, unknown>;
  let next: Record<string, unknown>;
  try {
    previous = typeof previousKey === 'string' ? JSON.parse(previousKey) : previousKey;
    next = typeof nextKey === 'string' ? JSON.parse(nextKey) : nextKey;
    if (
      previous === null ||
      next === null ||
      typeof previous !== 'object' ||
      typeof next !== 'object'
    )
      return { dependencies: ['invalid-key'], changes: [] };
  } catch {
    return { dependencies: ['invalid-key'], changes: [] };
  }
  const displayOnly = typeof previousKey === 'object' && typeof nextKey === 'object';
  const dependencies: string[] = [];
  const changes: { dependency: string; before: string; after: string }[] = [];
  const compare = (
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    prefix: string,
  ) => {
    function attribute(name: string): void {
      if (prefix === '' && name === 'topology') return;
      const dependency = prefix + name;
      if (displayOnly) {
        const oldValue = left[name],
          newValue = right[name];
        if (sameDisplayValue(oldValue, newValue)) return;
        dependencies.push(dependency);
        if (changes.length < 4)
          changes.push({
            dependency,
            get before() {
              return displaySample(oldValue);
            },
            get after() {
              return displaySample(newValue);
            },
          });
        return;
      }
      const before = JSON.stringify(left[name]);
      const after = JSON.stringify(right[name]);
      if (before === after) return;
      dependencies.push(dependency);
      if (changes.length < 4)
        changes.push({
          dependency,
          before: (before ?? 'undefined').slice(0, 400),
          after: (after ?? 'undefined').slice(0, 400),
        });
    }
    for (const name of Object.keys(left)) attribute(name);
    for (const name of Object.keys(right)) if (!Object.hasOwn(left, name)) attribute(name);
  };
  compare(
    (previous.topology as Record<string, unknown>) ?? {},
    (next.topology as Record<string, unknown>) ?? {},
    'topology.',
  );
  compare(previous, next, '');
  if (dependencies.length === 0) {
    dependencies.push('serialization');
    changes.push({ dependency: 'serialization', before: 'undefined', after: 'undefined' });
  }
  return { dependencies, changes };
}
