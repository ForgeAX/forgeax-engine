import { err, type Result } from '@forgeax/engine-types';
import { type ModelingError, modelingError } from '../errors';
import { type Model, model } from '../model';
import type { Point2 } from '../primitives';
import {
  checkAll,
  finishPart,
  inRange,
  type Range,
  type RecipeNaming,
  type RecipePart,
} from './common';

export type JuzheKind = 'pavilion' | 'hall';

export interface JuzheRoofOptions extends RecipeNaming {
  /** `pavilion` (dian ge, pavilion; ridge rise 1/3 of the full span) or `hall` (ting tang, hall; 1/4). Default `pavilion`. */
  readonly kind?: JuzheKind;
  /** Horizontal run from the ridge purlin to the eave purlin, in meters (default 0.9). */
  readonly run?: number;
  /** Number of jia (purlin spans) on each side, integer (default 3). */
  readonly spans?: number;
  /** Ridge length along Z, in meters (default 1.2). The roof is extruded from z = 0 to length. */
  readonly length?: number;
}

/** Declared ranges of the numeric options; `kind` is a closed union checked on entry. */
export const JUZHE_ROOF_RANGES = {
  run: [0.2, 6],
  spans: [1, 8],
  length: [0.2, 30],
} as const satisfies Record<string, Range>;

/**
 * Ridge rise as a ratio of the full span (twice the run), ju gao (ridge rise). Dian ge is one third and ting tang one
 * quarter of the full span: building.md juan 4 (verified) quotes "fen wei san fen, cong liao yan fang bei zhi ji lu bei ju qi yi fen" (divide into three parts; raise one part from the eave purlin to the ridge purlin)
 * and "ji si fen zhong ju qi yi fen" (that is, raise one of four parts). Both values are verified; the eave upturn is not sourced.
 */
export const JUZHE_RATIO: Readonly<Record<JuzheKind, number>> = {
  pavilion: 1 / 3,
  hall: 1 / 4,
};

/**
 * First fold drop as a fraction of the ridge height (building.md juan 5 "mei chi zhe yi cun", each chi folds one cun, read as one
 * tenth of the height); each later drop halves. building.md (verified) gives the rule
 * "mei jia zi shang di jian ban wei fa" (each jia halves going up) for the drops after the first.
 */
export const JUZHE_FOLD_DROP = 1 / 10;

export interface JuzhePurlin {
  /** Horizontal distance from the ridge purlin, meters. */
  readonly run: number;
  /** Height above the eave line, meters. */
  readonly height: number;
}

/**
 * Purlin points of a juzhe roof with `spans` equal horizontal runs, from the ridge (run 0) to the
 * eave (run `run`, height 0). The fold starts on the chord from the ridge to the eave: the first
 * interior purlin drops below that chord by `JUZHE_FOLD_DROP * ridgeHeight`. Each later purlin
 * is set on a new chord from the previous lowered point to the eave and drops by half the
 * previous drop. The eave point never moves. The result is a sag: each interior purlin lies
 * strictly below the chord of its neighbours, and the slope steepness decreases toward the eave.
 */
export function juzhePurlins(ridgeHeight: number, run: number, spans: number): JuzhePurlin[] {
  const out: JuzhePurlin[] = [{ run: 0, height: ridgeHeight }];
  let prev = out[0] as JuzhePurlin;
  let drop = JUZHE_FOLD_DROP * ridgeHeight;
  for (let k = 1; k < spans; k++) {
    const x = (k * run) / spans;
    const chord = (prev.height * (run - x)) / (run - prev.run);
    prev = { run: x, height: chord - drop };
    out.push(prev);
    drop /= 2;
  }
  out.push({ run, height: 0 });
  return out;
}

/**
 * A straight-ridged juzhe roof: a prism over the purlin polyline, extruded along the ridge.
 * Every facet is a planar ruled band between two parallel ridge-direction lines. The profile
 * is concave from the eave to the ridge (the fold of `juzhePurlins`): the upper jia are
 * steeper than the lower ones. Gable ends are flat, hip (xie shan) ends are not
 * modeled, and eave upturn (qi qiao) is not located in the checked sources, so it is not modeled
 * and `eaveUpturn` is recorded as 0. Anchors are the ridge and every purlin at z = 0.
 */
export function juzheRoof(options: JuzheRoofOptions = {}): Result<RecipePart, ModelingError> {
  const name = options.name ?? 'juzhe-roof';
  const kind = options.kind ?? 'pavilion';
  const run = options.run ?? 0.9;
  const spans = options.spans ?? 3;
  const length = options.length ?? 1.2;
  if (kind !== 'pavilion' && kind !== 'hall') {
    return err(
      modelingError(
        'model-invalid-argument',
        'kind is pavilion or hall',
        { kind: String(kind) },
        'pass pavilion or hall',
      ),
    );
  }
  const checked = checkAll([
    () => inRange('run', run, JUZHE_ROOF_RANGES.run),
    () => inRange('spans', spans, JUZHE_ROOF_RANGES.spans, true),
    () => inRange('length', length, JUZHE_ROOF_RANGES.length),
  ]);
  if (!checked.ok) return checked;

  const ratio = JUZHE_RATIO[kind];
  const ridgeHeight = ratio * 2 * run;
  const purlins = juzhePurlins(ridgeHeight, run, spans);

  // Cross-section in XY (x across, y up), extruded along +Z: eave-left, purlins up to the
  // ridge, then mirrored down to the eave-right purlin.
  const outline: Point2[] = [];
  for (let p = spans; p >= 1; p--) {
    const q = purlins[p] as JuzhePurlin;
    outline.push([-q.run, q.height]);
  }
  outline.push([0, ridgeHeight]);
  for (let p = 1; p <= spans; p++) {
    const q = purlins[p] as JuzhePurlin;
    outline.push([q.run, q.height]);
  }
  const m: Model = model();
  m.extrudePolygon({ points: outline, depth: length, label: name });
  if (m.poisoned !== undefined) return err(m.poisoned);

  const anchors: Record<string, [number, number, number]> = {
    ridge: [0, ridgeHeight, 0],
    'ridge-end': [0, ridgeHeight, length],
  };
  purlins.forEach((q, p) => {
    anchors[`purlin-${p}-right`] = [q.run, q.height, 0];
    if (p > 0) anchors[`purlin-${p}-left`] = [-q.run, q.height, 0];
  });

  return finishPart(m, name, anchors, {
    run,
    spans,
    length,
    ratio,
    ridgeHeight,
    spanRun: run / spans,
    firstDrop: JUZHE_FOLD_DROP * ridgeHeight,
    eaveUpturn: 0,
  });
}
