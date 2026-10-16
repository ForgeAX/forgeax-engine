export interface SpotShadowRoi {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type SpotShadowFalsifierId =
  | 'no-caster'
  | 'no-shadow-allocation'
  | 'wrong-tile'
  | 'reverse-occlusion';

export type SpotShadowReceiverVariant = 'base' | 'clearcoat';

export interface SpotShadowFalsifier {
  readonly id: SpotShadowFalsifierId;
  readonly mutation: string;
  readonly expected: 'shadow-delta-collapse' | 'tile-mismatch';
}

export interface SpotShadowScene {
  readonly caseId: 'direct-spot-urp' | 'direct-spot-hdrp';
  readonly scene: {
    readonly width: 400;
    readonly height: 300;
    readonly background: readonly [0, 0, 0, 1];
  };
  readonly camera: {
    readonly position: readonly [-9, 6, -0.5];
    readonly rotation: readonly [number, number, number, number];
    readonly target: readonly [-9, -2, -3];
    readonly fovDeg: 60;
  };
  readonly floor: {
    readonly size: readonly [30, 30];
    readonly position: readonly [0, -2, -3];
    readonly rotation: readonly [number, number, number, number];
  };
  readonly occluder: {
    readonly size: readonly [1, 1, 1];
    readonly position: readonly [-9, -0.6, -3];
  };
  readonly light: {
    readonly kind: 'spot';
    readonly position: readonly [-6.8, 4, -3];
    readonly direction: readonly [-0.514495755, -0.857492926, 0];
    readonly color: readonly [1, 1, 1];
    readonly intensity: 40;
    readonly range: 50;
    readonly innerConeDeg: 22;
    readonly outerConeDeg: 32;
    readonly castShadow: true;
    readonly mapSize: 1024;
  };
  readonly roi: {
    readonly lit: SpotShadowRoi;
    readonly shadow: SpotShadowRoi;
  };
  readonly threshold: {
    readonly shadowDelta: 0.05;
    readonly pipelineEpsilon: 0.2;
  };
  readonly falsifiers: readonly SpotShadowFalsifier[];
}

const commonScene = {
  scene: { width: 400, height: 300, background: [0, 0, 0, 1] as const },
  camera: {
    position: [-9, 6, -0.5] as const,
    rotation: [Math.sin(-Math.PI / 4.6), 0, 0, Math.cos(-Math.PI / 4.6)] as const,
    target: [-9, -2, -3] as const,
    fovDeg: 60 as const,
  },
  floor: {
    size: [30, 30] as const,
    position: [0, -2, -3] as const,
    rotation: [Math.sin(-Math.PI / 4), 0, 0, Math.cos(-Math.PI / 4)] as const,
  },
  occluder: { size: [1, 1, 1] as const, position: [-9, -0.6, -3] as const },
  light: {
    kind: 'spot' as const,
    position: [-6.8, 4, -3] as const,
    direction: [-0.514495755, -0.857492926, 0] as const,
    color: [1, 1, 1] as const,
    intensity: 40 as const,
    range: 50 as const,
    innerConeDeg: 22 as const,
    outerConeDeg: 32 as const,
    castShadow: true as const,
    mapSize: 1024 as const,
  },
  roi: {
    lit: { x: 228, y: 120, width: 12, height: 12 },
    shadow: { x: 180, y: 132, width: 12, height: 12 },
  },
  threshold: { shadowDelta: 0.05, pipelineEpsilon: 0.2 },
  falsifiers: [
    { id: 'no-caster', mutation: 'remove the cube occluder draw', expected: 'shadow-delta-collapse' },
    { id: 'no-shadow-allocation', mutation: 'set SpotLight.castShadow=false', expected: 'shadow-delta-collapse' },
    { id: 'wrong-tile', mutation: 'force the HDRP payload tile away from the producer tile', expected: 'tile-mismatch' },
    { id: 'reverse-occlusion', mutation: 'move the occluder behind the receiver', expected: 'shadow-delta-collapse' },
  ],
} as const;

export const SPOT_SHADOW_SCENES: Readonly<Record<'urp' | 'hdrp', SpotShadowScene>> = {
  urp: Object.freeze({ ...commonScene, caseId: 'direct-spot-urp' }),
  hdrp: Object.freeze({ ...commonScene, caseId: 'direct-spot-hdrp' }),
};
