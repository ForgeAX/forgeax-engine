import type { SceneCase } from '../contracts/types';
import type { Rgb, ThreeR184ToneMode } from '../analytic/three-r184-tonemap';
import manifest from '../../cases/tone/required.json' with { type: 'json' };

export interface ToneRampCase extends SceneCase {
  readonly tone: {
    readonly mode: ThreeR184ToneMode;
    readonly color: Rgb;
    readonly exposure: number;
  };
}

const toneCases = manifest.modes.flatMap((mode) =>
  manifest.samples.map((color, index) => ({
    caseId: `tone-${mode}-${index}`,
    required: manifest.required,
    colorDomain: manifest.colorDomain,
    scene: manifest.scene,
    budget: manifest.budget,
    tone: {
      mode,
      color,
      exposure: manifest.exposure,
    },
  })),
);

export const TONE_REQUIRED_CASES = toneCases as unknown as readonly ToneRampCase[];

export const TONE_CASES_BY_ID = new Map(TONE_REQUIRED_CASES.map((entry) => [entry.caseId, entry]));

export const TONE_REQUIRED_MODES = [...manifest.modes] as readonly ThreeR184ToneMode[];

export const TONE_REQUIRED_SAMPLE_COUNT = manifest.samples.length;
