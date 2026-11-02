import { type Model, sel } from '@forgeax/engine-modeling';

/**
 * Dimension checks on the finished (subdivided) body, read from its vertices:
 * leg column width and spacing (y 0.10-0.17), hand width and depth, chin and face
 * front depth, toe reach.
 */
export function bodyMetrics(m: Model) {
  const verts = (tag: string) =>
    [...new Set(sel.tag(tag).evaluate(m.editMesh).flatMap((f) => m.editMesh.faceVertices(f)))].map((v) => m.editMesh.position(v));
  const span = (pts: readonly (readonly number[])[], k: number) => {
    const xs = pts.map((p) => p[k] as number);
    return [Math.min(...xs), Math.max(...xs)] as const;
  };
  const band = (pts: readonly (readonly number[])[], y0: number, y1: number) => pts.filter((p) => (p[1] as number) >= y0 && (p[1] as number) <= y1);
  const legL = span(band(verts('leg-l'), 0.1, 0.17), 0);
  const legR = span(band(verts('leg-r'), 0.1, 0.17), 0);
  const handL = verts('hand-l');
  const head = verts('head');
  const chinBand = band(head, 0.615, 0.625);
  const faceBand = band(head, 0.69, 0.74);
  const foot = verts('leg-l').filter((p) => (p[1] as number) < 0.06);
  const widthAt = (y: number) => {
    const b = band(head, y - 0.004, y + 0.004);
    return b.length > 0 ? span(b, 0)[1] - span(b, 0)[0] : Number.NaN;
  };
  const handR = verts('hand-r');
  return {
    jaw063: widthAt(0.63),
    jaw064: widthAt(0.64),
    jaw065: widthAt(0.65),
    handBottomL: span(handL, 1)[0],
    handBottomR: span(handR, 1)[0],
    handXL: (span(handL, 0)[0] + span(handL, 0)[1]) / 2,
    handXR: (span(handR, 0)[0] + span(handR, 0)[1]) / 2,
    legWidth: legL[1] - legL[0],
    legSpacing: (legL[0] + legL[1]) / 2 - (legR[0] + legR[1]) / 2,
    handWidth: span(handL, 0)[1] - span(handL, 0)[0],
    handDepth: span(handL, 2)[1] - span(handL, 2)[0],
    chinZ: chinBand.length > 0 ? span(chinBand, 2)[1] : Number.NaN,
    faceFront: span(faceBand, 2)[1],
    chinY: span(head, 1)[0],
    toeZ: span(foot, 2)[1],
  };
}
