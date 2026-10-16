import { Update, type EntityHandle, type World } from '@forgeax/engine-ecs';
import {
  BLOOM_ENABLED,
  Camera,
  DirectionalLight,
  Skylight,
  SkyboxBackground,
  TONEMAP_ACES_FILMIC,
  TONEMAP_REINHARD_EXTENDED,
} from '@forgeax/engine-render';
import type { LoadedScene } from './scene-runtime';
import type { HudHandle } from './hud';
import {
  LIGHTING_MODE_DAY,
  LIGHTING_MODE_NIGHT,
  LightingMode,
  type LightingModeName,
} from './components/gameplay';

export type LightingTable = {
  readonly name: LightingModeName;
  readonly sun: {
    readonly direction: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    readonly intensity: number;
  };
  readonly skylight: {
    readonly color: readonly [number, number, number];
    readonly intensity: number;
    readonly rotation: readonly [number, number, number, number];
  };
  readonly skybox: {
    readonly rotation: readonly [number, number, number, number];
  };
  readonly camera: {
    readonly exposure: number;
    readonly tonemap: number;
    readonly bloom: number;
    readonly bloomThreshold: number;
    readonly bloomIntensity: number;
    readonly bloomSoftKnee: number;
    readonly bloomScatter: number;
  };
};

/** One SSOT for the two authored lighting projections. */
export const GAME_DEFAULT_LIGHTING_TABLES: Readonly<Record<LightingModeName, LightingTable>> = Object.freeze({
  Day: Object.freeze({
    name: 'Day',
    sun: Object.freeze({
      direction: [-0.4, -1, -0.3] as const,
      color: [1, 0.9607843137254902, 0.8784313725490196] as const,
      intensity: 3.2,
    }),
    skylight: Object.freeze({
      color: [1, 1, 1] as const,
      intensity: 0.2,
      rotation: [0, 0, 0, 1] as const,
    }),
    skybox: Object.freeze({ rotation: [0, 0, 0, 1] as const }),
    camera: Object.freeze({
      exposure: 1,
      tonemap: TONEMAP_REINHARD_EXTENDED,
      bloom: BLOOM_ENABLED,
      bloomThreshold: 1,
      bloomIntensity: 1,
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
    }),
  }),
  Night: Object.freeze({
    name: 'Night',
    sun: Object.freeze({
      direction: [0.18, -0.82, 0.32] as const,
      color: [0.3, 0.4, 0.78] as const,
      intensity: 0.7,
    }),
    skylight: Object.freeze({
      color: [0.18, 0.26, 0.52] as const,
      intensity: 0.45,
      rotation: [0, 0.38268343, 0, 0.92387953] as const,
    }),
    skybox: Object.freeze({ rotation: [0, 0.38268343, 0, 0.92387953] as const }),
    camera: Object.freeze({
      exposure: 0.72,
      tonemap: TONEMAP_ACES_FILMIC,
      bloom: BLOOM_ENABLED,
      bloomThreshold: 0.82,
      bloomIntensity: 1.25,
      bloomSoftKnee: 0.5,
      bloomScatter: 0.7,
    }),
  }),
});

export type LightingModeSnapshot = {
  readonly available: boolean;
  readonly mode: LightingModeName;
  readonly sourceLocalIds: { readonly sun: 1; readonly skylight: 21; readonly skybox: 22 };
  readonly sun: {
    readonly entity: EntityHandle | null;
    readonly direction: readonly number[];
    readonly color: readonly number[];
    readonly intensity: number;
  };
  readonly skylight: {
    readonly entity: EntityHandle | null;
    readonly color: readonly number[];
    readonly intensity: number;
    readonly rotation: readonly number[];
  };
  readonly skybox: {
    readonly entity: EntityHandle | null;
    readonly rotation: readonly number[];
  };
  readonly camera: {
    readonly exposure: number;
    readonly tonemap: number;
    readonly bloom: number;
    readonly bloomThreshold: number;
    readonly bloomIntensity: number;
    readonly bloomSoftKnee: number;
    readonly bloomScatter: number;
  };
};

export type LightingModeHandle = {
  readonly toggle: () => LightingModeName;
  readonly set: (mode: LightingModeName) => void;
  readonly reset: () => void;
  readonly snapshot: () => LightingModeSnapshot;
};

const SOURCE_LOCAL_IDS = Object.freeze({ sun: 1 as const, skylight: 21 as const, skybox: 22 as const });

function modeName(value: number): LightingModeName {
  return value === LIGHTING_MODE_NIGHT ? 'Night' : 'Day';
}

function modeValue(mode: LightingModeName): number {
  return mode === 'Night' ? LIGHTING_MODE_NIGHT : LIGHTING_MODE_DAY;
}

function numbers(value: ArrayLike<number>): readonly number[] {
  return Array.from(value);
}

/** Install the single ECS Update owner for authored Day/Night projection. */
export function installLightingModeProjection(args: {
  readonly world: World;
  readonly camera: EntityHandle;
  readonly loaded: LoadedScene | null;
  readonly hud: HudHandle;
}): LightingModeHandle {
  const sun = args.loaded?.mapping.get(SOURCE_LOCAL_IDS.sun);
  const skylight = args.loaded?.mapping.get(SOURCE_LOCAL_IDS.skylight);
  const skybox = args.loaded?.mapping.get(SOURCE_LOCAL_IDS.skybox);
  args.world.addComponent(args.camera, { component: LightingMode, data: { mode: LIGHTING_MODE_DAY } });

  let appliedMode: LightingModeName | undefined;
  const readMode = (): LightingModeName => {
    const data = args.world.get(args.camera, LightingMode);
    return modeName(data.ok ? data.value.mode : LIGHTING_MODE_DAY);
  };
  const project = (mode: LightingModeName): void => {
    const table = GAME_DEFAULT_LIGHTING_TABLES[mode];
    if (sun !== undefined) args.world.set(sun, DirectionalLight, {
      direction: [...table.sun.direction],
      color: [...table.sun.color],
      intensity: table.sun.intensity,
    });
    if (skylight !== undefined) args.world.set(skylight, Skylight, {
      color: [...table.skylight.color],
      intensity: table.skylight.intensity,
      rotation: [...table.skylight.rotation],
    });
    if (skybox !== undefined) args.world.set(skybox, SkyboxBackground, {
      rotation: [...table.skybox.rotation],
    });
    args.world.set(args.camera, Camera, table.camera);
    args.hud.setLightingMode(mode);
    appliedMode = mode;
  };

  args.world.addSystem(Update, {
    name: 'game-lighting-mode-projection',
    queries: [],
    fn: () => {
      const mode = readMode();
      if (mode !== appliedMode) project(mode);
    },
  }).unwrap();

  const set = (mode: LightingModeName): void => {
    args.world.set(args.camera, LightingMode, { mode: modeValue(mode) });
  };
  const snapshot = (): LightingModeSnapshot => {
    const modeData = args.world.get(args.camera, LightingMode);
    const cameraData = args.world.get(args.camera, Camera);
    const sunData = sun === undefined ? undefined : args.world.get(sun, DirectionalLight);
    const skylightData = skylight === undefined ? undefined : args.world.get(skylight, Skylight);
    const skyboxData = skybox === undefined ? undefined : args.world.get(skybox, SkyboxBackground);
    return {
      available: sun !== undefined && skylight !== undefined && skybox !== undefined,
      mode: modeName(modeData.ok ? modeData.value.mode : LIGHTING_MODE_DAY),
      sourceLocalIds: SOURCE_LOCAL_IDS,
      sun: {
        entity: sun ?? null,
        direction: sunData?.ok === true ? numbers(sunData.value.direction) : [],
        color: sunData?.ok === true ? numbers(sunData.value.color) : [],
        intensity: sunData?.ok === true ? sunData.value.intensity : 0,
      },
      skylight: {
        entity: skylight ?? null,
        color: skylightData?.ok === true ? numbers(skylightData.value.color) : [],
        intensity: skylightData?.ok === true ? skylightData.value.intensity : 0,
        rotation: skylightData?.ok === true ? numbers(skylightData.value.rotation) : [],
      },
      skybox: {
        entity: skybox ?? null,
        rotation: skyboxData?.ok === true ? numbers(skyboxData.value.rotation) : [],
      },
      camera: {
        exposure: cameraData?.ok === true ? cameraData.value.exposure : 0,
        tonemap: cameraData?.ok === true ? cameraData.value.tonemap : 0,
        bloom: cameraData?.ok === true ? cameraData.value.bloom : 0,
        bloomThreshold: cameraData?.ok === true ? cameraData.value.bloomThreshold : 0,
        bloomIntensity: cameraData?.ok === true ? cameraData.value.bloomIntensity : 0,
        bloomSoftKnee: cameraData?.ok === true ? cameraData.value.bloomSoftKnee : 0,
        bloomScatter: cameraData?.ok === true ? cameraData.value.bloomScatter : 0,
      },
    };
  };

  return {
    toggle: () => {
      const current = readMode();
      const next = current === 'Day' ? 'Night' : 'Day';
      set(next);
      return next;
    },
    set,
    reset: () => set('Day'),
    snapshot,
  };
}
