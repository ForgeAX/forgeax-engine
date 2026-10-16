import { describe, expect, it } from 'vitest';

type Vec3 = readonly [number, number, number];

const THREE_R184_SOURCE = 'three.js@r184/examples/jsm/objects/Sky.js';
const RAYLEIGH = 1.1;
const MIE_COEFFICIENT = 0.006;
const MIE_DIRECTIONAL_G = 0.78;
const TOTAL_RAYLEIGH: Vec3 = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST: Vec3 = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

const PROFILES = {
  morning: { sun: [-0.45, 0.22, -0.865] as Vec3, turbidity: 3.2 },
  noon: { sun: [0.1, 0.97, -0.22] as Vec3, turbidity: 2.1 },
  evening: { sun: [0.5, 0.15, -0.85] as Vec3, turbidity: 4.2 },
} as const;

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(...value);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function threeR184Sky(
  directionInput: Vec3,
  sunInput: Vec3,
  turbidity: number,
  showSunDisc: boolean,
): Vec3 {
  const direction = normalize(directionInput);
  const sun = normalize(sunInput);
  const sunZenithCos = Math.max(-1, Math.min(1, sun[1]));
  const sunEnergy =
    1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(sunZenithCos)) / 1.5)));
  const sunFade = 1 - Math.max(0, Math.min(1, 1 - Math.exp(sun[1] / 450_000)));
  const rayleighCoefficient = RAYLEIGH - (1 - sunFade);
  const betaR = TOTAL_RAYLEIGH.map((value) => value * rayleighCoefficient) as unknown as Vec3;
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: Three r184 pins 0.434 exactly.
  const mieScale = 0.434 * (0.2 * turbidity * 1e-17) * MIE_COEFFICIENT;
  const betaM = MIE_CONST.map((value) => value * mieScale) as unknown as Vec3;
  const zenithAngle = Math.acos(Math.max(0, direction[1]));
  const inverse =
    1 / (Math.cos(zenithAngle) + 0.15 * (93.885 - (zenithAngle * 180) / Math.PI) ** -1.253);
  const sR = 8_400 * inverse;
  const sM = 1_250 * inverse;
  const cosTheta = dot(direction, sun);
  const rayleighPhase = 0.05968310365946075 * (1 + (cosTheta * 0.5 + 0.5) ** 2);
  const g2 = MIE_DIRECTIONAL_G ** 2;
  const miePhase =
    0.07957747154594767 * ((1 - g2) / (1 - 2 * MIE_DIRECTIONAL_G * cosTheta + g2) ** 1.5);
  const lowSunMix = Math.max(0, Math.min(1, (1 - sun[1]) ** 5));
  const colorOffset: Vec3 = [0, 0.0003, 0.00075];

  return ([0, 1, 2] as const).map((channel) => {
    const extinction = Math.exp(-(betaR[channel] * sR + betaM[channel] * sM));
    const scatter =
      sunEnergy *
      ((betaR[channel] * rayleighPhase + betaM[channel] * miePhase) /
        (betaR[channel] + betaM[channel]));
    let lin = Math.max(scatter * (1 - extinction), 0) ** 1.5;
    lin *= 1 - lowSunMix + lowSunMix * Math.max(scatter * extinction, 0) ** 0.5;
    const disc =
      showSunDisc && cosTheta >= 0.9999566769464484 ? sunEnergy * 19_000 * extinction : 0;
    return (lin + 0.1 * extinction + disc) * 0.04 + colorOffset[channel];
  }) as unknown as Vec3;
}

describe('Three.js r184 same-parameter model reference', () => {
  it('pins natural daylight probes independently from the ForgeaX evaluator', () => {
    const probes = Object.entries(PROFILES).map(([time, profile]) => {
      const horizon = normalize([profile.sun[0], 0.08, profile.sun[2]]);
      return {
        time,
        zenith: threeR184Sky([0, 1, 0], profile.sun, profile.turbidity, false),
        horizon: threeR184Sky(horizon, profile.sun, profile.turbidity, false),
      };
    });
    const expected = [
      {
        time: 'morning',
        zenith: [0.030492, 0.102424, 0.308226],
        horizon: [45.588088, 44.78799, 25.700271],
      },
      {
        time: 'noon',
        zenith: [1.520243, 3.631492, 7.981302],
        horizon: [0.917458, 2.878871, 7.094558],
      },
      {
        time: 'evening',
        zenith: [0.019634, 0.063679, 0.19124],
        horizon: [81.28711, 73.286304, 34.37594],
      },
    ] as const;
    expect(THREE_R184_SOURCE).toBe('three.js@r184/examples/jsm/objects/Sky.js');
    for (const [index, probe] of probes.entries()) {
      const fixture = expected[index];
      expect(probe.time).toBe(fixture?.time);
      for (const channel of [0, 1, 2] as const) {
        expect(probe.zenith[channel]).toBeCloseTo(fixture?.zenith[channel] ?? Number.NaN, 5);
        expect(probe.horizon[channel]).toBeCloseTo(fixture?.horizon[channel] ?? Number.NaN, 5);
      }
    }
    expect(probes[0]?.horizon[0]).toBeGreaterThan(
      probes[0]?.horizon[2] ?? Number.POSITIVE_INFINITY,
    );
    expect(probes[1]?.zenith[2]).toBeGreaterThan(probes[1]?.zenith[0] ?? Number.POSITIVE_INFINITY);
    expect(probes[2]?.horizon[0]).toBeGreaterThan(
      probes[2]?.horizon[2] ?? Number.POSITIVE_INFINITY,
    );
  });

  it('keeps the display Sun separable from the environment reference', () => {
    const profile = PROFILES.morning;
    const hidden = threeR184Sky(profile.sun, profile.sun, profile.turbidity, false);
    const visible = threeR184Sky(profile.sun, profile.sun, profile.turbidity, true);
    expect(visible[0]).toBeGreaterThan(hidden[0] * 100);
  });
});
