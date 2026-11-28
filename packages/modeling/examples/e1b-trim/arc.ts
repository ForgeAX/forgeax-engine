import type { RGB, Scene, SceneLine, SceneMarker } from '../brep-kit/index.ts';
import { curvePoint } from '../../src/brep/curves.ts';
import { classifyOnFace, faceTrim } from '../../src/brep/trim-face.ts';
import type { P3 } from '../../src/brep/vec.ts';
import type { Shape } from '../../src/brep/types.ts';
import type { IntersectionBranch } from '../../src/brep/intersect.ts';

export const IN_COLOUR: RGB = [70, 170, 90];
export const OUT_COLOUR: RGB = [210, 80, 70];
export const ON_COLOUR: RGB = [240, 200, 40];

/** Coloured in/out/on runs of an intersection arc, classified against `face` of `shape`. */
export function classifiedArc(shape: Shape, face: number, branch: IntersectionBranch, samples = 360): Scene {
  const trim = faceTrim(shape, face);
  const lines: SceneLine[] = [];
  const markers: SceneMarker[] = [];
  let run: P3[] = [];
  let runClass = '';
  const flush = () => {
    if (run.length > 1) {
      const colour = runClass === 'in' ? IN_COLOUR : runClass === 'out' ? OUT_COLOUR : ON_COLOUR;
      lines.push({ points: run, color: colour, width: 4, bias: 2 });
    }
    run = [];
  };
  for (let i = 0; i <= samples; i++) {
    const t = branch.t0 + ((branch.t1 - branch.t0) * i) / samples;
    const p = curvePoint(branch.curve, t);
    const c = classifyOnFace(trim, p);
    if (c !== runClass && run.length > 0) {
      const last = run[run.length - 1] as P3;
      flush();
      run.push(last);
    }
    runClass = c;
    run.push(p);
  }
  flush();
  return { tris: [], lines, markers };
}
