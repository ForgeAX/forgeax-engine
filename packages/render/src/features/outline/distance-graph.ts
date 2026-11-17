import { mat4, vec3 } from '@forgeax/engine-math';
import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import { cameraLensProjection } from '../../camera-projection';
import {
  createRenderPipelineTarget,
  type RenderPipelineFrame,
  type RenderPipelineTarget,
} from '../../render-pipeline';
import { COLOR_PASS_SELECTOR } from '../../systems/pass-selector';
import { addTypedFullscreenPass, addTypedScenePass } from '../../typed-render-graph-primitives';

const selection = (frame: RenderPipelineFrame) => {
  const outline =
    frame.editorAssistance === undefined
      ? frame.camera.outline
      : frame.editorAssistance.authoredOutline;
  return outline?.distanceField ? outline : undefined;
};
function coordinate(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing projection coordinate ${index}`);
  return value;
}
type Rect = [number, number, number, number];
function readBounds(
  values: readonly number[],
  offset: number,
): [number, number, number, number, number, number] {
  const x0 = values[offset],
    y0 = values[offset + 1],
    z0 = values[offset + 2],
    x1 = values[offset + 3],
    y1 = values[offset + 4],
    z1 = values[offset + 5];
  if (
    x0 === undefined ||
    y0 === undefined ||
    z0 === undefined ||
    x1 === undefined ||
    y1 === undefined ||
    z1 === undefined
  )
    throw new RangeError('Outline bounds require six admitted coordinates');
  return [x0, y0, z0, x1, y1, z1];
}
/** Native independent coverage/depth channels followed by lossless JFA+1.
 * Selection reuses actual deformation and cutouts; no material overlay owner. */
export function addDistanceOutlinePasses(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  depth: RenderPipelineTarget,
): Result<RenderPipelineTarget, RenderGraphError> {
  const make = (label: string, format: 'rgba16float' | 'depth32float-stencil8' = 'rgba16float') =>
    createRenderPipelineTarget(graph, `outline-distance-${label}`, {
      format,
      size: 'surface',
      ...(label === 'color' ? { domain: 'linear-hdr' as const } : {}),
    });
  const packed: RenderPipelineTarget[] = [];
  for (const [index, key] of (
    [
      'camera-outline-distance',
      'camera-outline-focus',
      'camera-outline-accent',
      'camera-outline-large',
    ] as const
  ).entries()) {
    const coverage = make(`coverage-${index}`);
    if (!coverage.ok) return coverage;
    const selectedDepth = make(`depth-${index}`, 'depth32float-stencil8');
    if (!selectedDepth.ok) return selectedDepth;
    const selected = addTypedScenePass(graph, {
      name: `outline-distance-selection-${index}`,
      color: coverage.value,
      depth: selectedDepth.value,
      selector: COLOR_PASS_SELECTOR,
      passKind: 'temporal',
      coverageOnly: true,
      clearColor: [0, 0, 0, 0],
      selection: key,
    });
    if (!selected.ok) return selected;
    const output = make(`packed-${index}`);
    if (!output.ok) return output;
    const copy = addTypedFullscreenPass(graph, {
      name: `outline-distance-depth-copy-${index}`,
      shader: 'forgeax.outline.depth',
      input: coverage.value,
      outputs: [output.value],
      depth: selectedDepth.value,
    });
    if (!copy.ok) return copy;
    packed.push(output.value);
  }
  const seed = make('seed');
  if (!seed.ok) return seed;
  const [base, focus, accent, large] = packed;
  if (base === undefined || focus === undefined || accent === undefined || large === undefined)
    throw new Error('Outline distance channel production is incomplete');
  const initialize = addTypedFullscreenPass(graph, {
    name: 'outline-distance-seed',
    shader: `forgeax.outline.distance.seed${depth.sampleCount === 4 ? '.msaa' : ''}`,
    input: base,
    outputs: [seed.value],
    additionalReads: [
      { key: 'outline-focus', target: focus },
      { key: 'outline-accent', target: accent },
      { key: 'outline-large', target: large },
    ],
    depth,
    paramsTransform: (_previous, frame) => distanceParams(frame),
  });
  if (!initialize.ok) return initialize;
  let current = seed.value;
  // Fifteen stages cover the complete signed-i16 coordinate/authoring range.
  // source reach settings; unused stages copy without another JFA iteration.
  for (let index = 0; index < 15; index++) {
    const output = make(`flood-${index}`);
    if (!output.ok) return output;
    const flood = addTypedFullscreenPass(graph, {
      name: `outline-distance-flood-${index}`,
      shader: 'forgeax.outline.distance.flood',
      input: current,
      outputs: [output.value],
      paramsTransform: (_previous, frame) => distanceParams(frame, index),
    });
    if (!flood.ok) return flood;
    current = output.value;
  }
  const output = make('color');
  if (!output.ok) return output;
  const composite = addTypedFullscreenPass(graph, {
    name: 'outline-distance-composite',
    shader: `forgeax.outline.distance.composite${depth.sampleCount === 4 ? '.msaa' : ''}`,
    input,
    outputs: [output.value],
    additionalReads: [{ key: 'outline-seeds', target: current }],
    depth,
    paramsTransform: (_previous, frame) => distanceParams(frame),
  });
  return composite.ok ? ok(output.value) : composite;
}
function distanceParams(frame: RenderPipelineFrame, stage?: number): Uint8Array {
  const data = new Float32Array(168),
    outline = selection(frame),
    style = outline?.distanceStyle;
  if (!outline || !style) return new Uint8Array(data.buffer);
  const width = frame.targetW,
    height = frame.targetH,
    px = height / 1080;
  if (width > 32767 || height > 32767)
    throw new RangeError('Distance-field outline seed coordinates require dimensions <=32767');
  const reach =
    (Math.max(outline.width, style.accentWidth) +
      Math.max(style.glowRadius, style.accentGlowRadius) * 1.6) *
      style.focusScale *
      style.largeScale *
      px +
    2;
  const projection =
    frame.camera.captureProjection ?? cameraLensProjection(frame.camera, mat4.create());
  const inverse = mat4.invert(mat4.create(), projection),
    view = mat4.invert(mat4.create(), frame.camera.world),
    vp = mat4.multiply(mat4.create(), projection, view);
  data.set([...outline.visibleColor, style.coreIntensity], 0);
  data.set([...style.accentColor, style.accentIntensity], 4);
  data.set([outline.width * px, style.glowRadius * px, style.glowStrength, reach], 8);
  data.set(
    [
      style.accentWidth * px,
      style.accentGlowRadius * px,
      style.accentGlowStrength,
      style.accentBreathe,
    ],
    12,
  );
  data.set(
    [outline.time ?? 0, coordinate(inverse, 10), coordinate(inverse, 14), coordinate(inverse, 11)],
    16,
  );
  data.set(
    [coordinate(inverse, 15), style.occlusionBias, style.focusScale, style.focusBrightness],
    20,
  );
  data.set([style.coreOpacity, style.accentOpacity, style.focusOpacity, style.largeScale], 24);
  data.set([0, style.distanceNear, style.distanceFar, style.distanceMinScale], 28);
  const project = (box: readonly number[], offset: number): Rect | undefined => {
    const [x0, y0, z0, x1, y1, z1] = readBounds(box, offset);
    let loX = Infinity,
      loY = Infinity,
      hiX = -Infinity,
      hiY = -Infinity,
      behind = false;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? x1 : x0,
        y = corner & 2 ? y1 : y0,
        z = corner & 4 ? z1 : z0;
      const w =
        coordinate(vp, 3) * x + coordinate(vp, 7) * y + coordinate(vp, 11) * z + coordinate(vp, 15);
      if (w <= 0.001) {
        behind = true;
        continue;
      }
      const sx =
          (((coordinate(vp, 0) * x +
            coordinate(vp, 4) * y +
            coordinate(vp, 8) * z +
            coordinate(vp, 12)) /
            w) *
            0.5 +
            0.5) *
          width,
        sy =
          (0.5 -
            ((coordinate(vp, 1) * x +
              coordinate(vp, 5) * y +
              coordinate(vp, 9) * z +
              coordinate(vp, 13)) /
              w) *
              0.5) *
          height;
      loX = Math.min(loX, sx);
      loY = Math.min(loY, sy);
      hiX = Math.max(hiX, sx);
      hiY = Math.max(hiY, sy);
    }
    if (behind) {
      const center = vec3.create((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
      const eye = mat4.transformPoint(vec3.create(), view, center);
      const diagonal = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
      if (coordinate(eye, 2) >= diagonal) return undefined;
      return [0, 0, width, height];
    }
    if (!Number.isFinite(loX)) return undefined;
    return [loX, loY, hiX, hiY];
  };
  let region: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  const boxes = outline.objectBounds ?? [];
  for (let offset = 0; offset < boxes.length; offset += 6) {
    const rect = project(boxes, offset);
    if (!rect) continue;
    region = [
      Math.min(region[0], rect[0] - reach - 2),
      Math.min(region[1], rect[1] - reach - 2),
      Math.max(region[2], rect[2] + reach + 2),
      Math.max(region[3], rect[3] + reach + 2),
    ];
  }
  if (!boxes.length) region = [0, 0, width, height];
  if (
    region[0] >= width ||
    region[1] >= height ||
    region[2] <= 0 ||
    region[3] <= 0 ||
    !Number.isFinite(region[0])
  )
    region = [0, 0, 0, 0];
  data.set(
    [
      Math.max(0, Math.floor(region[0])),
      Math.max(0, Math.floor(region[1])),
      Math.min(width, Math.ceil(region[2])),
      Math.min(height, Math.ceil(region[3])),
    ],
    32,
  );
  let fades = 0;
  for (const [i, value] of (outline.fadeValues ?? []).entries()) {
    const rect = project(outline.fadeBounds ?? [], i * 6);
    if (!rect) continue;
    data.set([rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1], 40 + fades * 8);
    data[44 + fades * 8] = value;
    fades++;
  }
  data[28] = fades;
  data[36] = distanceFloodStep(reach, stage);
  return new Uint8Array(data.buffer);
}

function distanceFloodStep(reach: number, stage: number | undefined): number {
  if (stage !== undefined) {
    let first = 1;
    while (first * 2 < Math.ceil(reach)) first *= 2;
    const steps: number[] = [];
    for (let step = first; step >= 1; step = Math.floor(step / 2)) steps.push(step);
    steps.push(1);
    return steps[stage] ?? 0;
  }
  return 0;
}
