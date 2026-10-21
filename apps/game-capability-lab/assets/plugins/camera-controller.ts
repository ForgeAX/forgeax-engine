import { defineAssetKind } from '@forgeax/engine-assets-runtime';
import { AudioListener } from '@forgeax/engine-audio';
import type { GameHost } from '@forgeax/engine-app';
import { type EntityHandle, type World } from '@forgeax/engine-ecs';
import type { Context } from '@forgeax/engine-plugin';
import { ANTIALIAS_FXAA, BLOOM_ENABLED, Camera, perspective, TONEMAP_REINHARD_EXTENDED } from '@forgeax/engine-render';
import { quat } from '@forgeax/engine-runtime';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Transform } from '@forgeax/engine-scene';
import type { UiAsset, UiResult } from '@forgeax/engine-ui';
import { installHud, HUD_UI_GUID, type HudHandle, type ViewMode } from './hud';
import { createGameSettingsState, mountSettings, SETTINGS_UI_GUID, type GameSettingsState, type SettingsHandle } from './settings';
import { GameplayInput, CameraRig, PlayerBodyPart } from './components/gameplay';
import { installDepthOfField, type DepthOfFieldHandle } from './depth-of-field';
import { installChromaticAberration, type ChromaticAberrationHandle } from './chromatic-aberration';
import { installRenderSettingsSystems } from './systems/render-settings';
import type { LoadedScene } from './scene-runtime';
import { PERSPECTIVE_FOV_INITIAL } from './camera-zoom';

export const TOP_DOWN_Y = 13;
export const TOP_DOWN_OFFSET_Z = 9;
export const CAMERA_FOLLOW = 8;
export const PAN_HALF_HEIGHT_INITIAL = 8;
export const PAN_HALF_HEIGHT_MIN = 3;
export const PAN_HALF_HEIGHT_MAX = 14;
export const PAN_SPEED = 8;
export const EYE_HEIGHT = 0.55;

export type CameraController = {
  readonly camera: EntityHandle;
  readonly topQuaternion: readonly [number, number, number, number];
  readonly hud: HudHandle;
  readonly settingsState: GameSettingsState;
  readonly settings: SettingsHandle;
  readonly depthOfField: DepthOfFieldHandle;
  readonly chromaticAberration: ChromaticAberrationHandle;
  readonly getMode: () => ViewMode;
  readonly setMode: (mode: ViewMode) => void;
  readonly applyPanCamera: () => void;
};

type CameraControllerArgs = {
  readonly context: Context;
  readonly world: World;
  readonly canvas: HTMLCanvasElement;
  readonly host: GameHost | undefined;
  readonly loaded: LoadedScene | null;
  readonly player: EntityHandle | undefined;
  readonly initX: number;
  readonly initZ: number;
};

async function loadUiAsset(host: GameHost | undefined, guidText: string): Promise<UiResult<UiAsset>> {
  const fail = (message: string): UiResult<UiAsset> => ({
    ok: false,
    error: {
      code: 'invalid-asset',
      expected: 'a loadable UiAsset from the configured pack',
      hint: 'Check the UI GUID and dev pack transport.',
      detail: { message, asset: guidText },
    },
  });
  if (host?.assets === undefined) return fail('Asset registry is unavailable');
  const guid = AssetGuid.parse(guidText);
  if (!guid.ok) return fail(`Invalid UI GUID: ${guidText}`);
  const loaded = await host.assets.load(guid.value, defineAssetKind<UiAsset, 'ui'>('ui'));
  if (loaded.ok) {
    const read = host.assets.read(loaded.value);
    host.assets.release(loaded.value).unwrap();
    return read.ok ? { ok: true, value: read.value } : fail(`${read.error.code}: ${read.error.hint}`);
  }
  return fail(`${loaded.error.code}: ${loaded.error.hint}`);
}

function cameraModeIndex(value: ViewMode): number {
  return value === 'topdown' ? 0 : value === 'orbit' ? 1 : value === 'fps' ? 2 : 3;
}

function cameraModeValue(value: number): ViewMode {
  return value === 1 ? 'orbit' : value === 2 ? 'fps' : value === 3 ? 'pan' : 'topdown';
}

/** Assemble the camera owner and its screen-space presentation boundary. */
export async function createCameraController(args: CameraControllerArgs): Promise<CameraController> {
  const { context, world, canvas, host, loaded, player, initX, initZ } = args;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  const aspect = canvas.width / canvas.height || 1;
  const topPitch = -Math.atan2(TOP_DOWN_Y, TOP_DOWN_OFFSET_Z);
  const topQ = quat.create();
  quat.fromAxisAngle(topQ, [1, 0, 0], topPitch);
  const topQuaternion: readonly [number, number, number, number] = [topQ[0]!, topQ[1]!, topQ[2]!, topQ[3]!];
  const camera = world.spawn(
    { component: Transform, data: { pos: [initX, TOP_DOWN_Y, initZ + TOP_DOWN_OFFSET_Z], quat: topQuaternion } },
    { component: Camera, data: { ...perspective({ fov: PERSPECTIVE_FOV_INITIAL, aspect, near: 0.1, far: 200 }), tonemap: TONEMAP_REINHARD_EXTENDED, bloom: BLOOM_ENABLED, antialias: ANTIALIAS_FXAA, clearColor: [0.4, 0.6, 1.0, 1] } },
    { component: CameraRig, data: { followX: initX, followZ: initZ + TOP_DOWN_OFFSET_Z, panX: initX, panZ: initZ + TOP_DOWN_OFFSET_Z, panHalfHeight: PAN_HALF_HEIGHT_INITIAL, perspectiveFov: PERSPECTIVE_FOV_INITIAL } },
    { component: AudioListener, data: {} },
  ).unwrap();

  const bodyPartQuery = world.query({ read: [PlayerBodyPart], with: [Transform] }).unwrap();
  if (loaded) {
    for (const node of loaded.nodes) {
      const name = (node.components.Name as { value?: string } | undefined)?.value;
      if (name === undefined || !name.startsWith('Player') || name === 'Player') continue;
      const entity = loaded.mapping.get(node.localId);
      if (entity === undefined) continue;
      const transform = world.get(entity, Transform);
      world.addComponent(entity, {
        component: PlayerBodyPart,
        data: {
          baseScaleX: transform.ok ? (transform.value.scale[0] ?? 1) : 1,
          baseScaleY: transform.ok ? (transform.value.scale[1] ?? 1) : 1,
          baseScaleZ: transform.ok ? (transform.value.scale[2] ?? 1) : 1,
        },
      });
    }
  }
  const setPlayerVisible = (visible: boolean): void => {
    for (const row of bodyPartQuery) {
      const part = row.get(PlayerBodyPart);
      const scale: [number, number, number] = visible
        ? [part.baseScaleX, part.baseScaleY, part.baseScaleZ]
        : [0, 0, 0];
      world.set(row.entity, Transform, { scale });
    }
  };

  const [hudLoad, settingsLoad] = await Promise.all([
    loadUiAsset(host, HUD_UI_GUID),
    loadUiAsset(host, SETTINGS_UI_GUID),
  ]);
  const hudAsset = hudLoad.ok ? hudLoad.value : null;
  const settingsAsset = settingsLoad.ok ? settingsLoad.value : null;
  if (!hudLoad.ok) console.error(`[game] HUD UI load failed (${hudLoad.error.code}): ${hudLoad.error.detail.message}`);
  if (!settingsLoad.ok) console.error(`[game] settings UI load failed (${settingsLoad.error.code}): ${settingsLoad.error.detail.message}`);
  const uiHost = host?.uiRoot ?? canvas.parentElement ?? undefined;
  const settingsState = createGameSettingsState();
  let settings: SettingsHandle = {
    instance: null,
    state: settingsState,
    open() {},
    close() {},
    dispose() {},
  };
  let setMode: (mode: ViewMode) => void = () => {};
  const nextMode = (): ViewMode => {
    const rig = world.get(camera, CameraRig);
    const current = rig.ok ? cameraModeValue(rig.value.mode) : 'topdown';
    return cameraModeValue((cameraModeIndex(current) + 1) % 4);
  };
  const hud = installHud({
    asset: hudAsset,
    initialMode: 'topdown',
    onToggle: () => setMode(nextMode()),
    onSettings: () => settings.open(),
    ...(uiHost ? { host: uiHost } : {}),
    ...(hudLoad.ok ? {} : { error: hudLoad.error }),
  });
  context.effect(() => () => hud.dispose(), 'game-default/hud');
  if (hud.error) throw hud.error;

  world.insertResource('gameDefaultSettings', settingsState);
  if (uiHost) {
    settings = mountSettings(settingsAsset, uiHost, settingsState, canvas, settingsLoad.ok ? undefined : settingsLoad.error);
    if (settings.error) throw settings.error;
  }
  const depthOfField = installDepthOfField(world, camera, settingsState.depthOfField);
  if (!depthOfField.installed && depthOfField.error) console.warn(`[game] depth-of-field unavailable: ${depthOfField.error}`);
  const chromaticAberration = await installChromaticAberration(context, world, host, host?.renderer);
  if (!chromaticAberration.installed && chromaticAberration.error) console.warn(`[game] chromatic aberration unavailable: ${chromaticAberration.error}`);
  installRenderSettingsSystems({ world, camera, settings: settingsState, depthOfField });
  context.effect(() => () => settings.dispose(), 'game-default/settings');
  context.effect(() => () => depthOfField.dispose(), 'game-default/depth-of-field');
  context.effect(() => () => chromaticAberration.dispose(), 'game-default/chromatic-aberration');

  const cameraState = {
    get mode(): ViewMode {
      const rig = world.get(camera, CameraRig);
      return rig.ok ? cameraModeValue(rig.value.mode) : 'topdown';
    },
    set mode(value: ViewMode) {
      world.set(camera, CameraRig, { mode: cameraModeIndex(value) });
    },
  };
  const applyPanCamera = (): void => {
    const rig = world.get(camera, CameraRig);
    if (!rig.ok) return;
    const halfWidth = rig.value.panHalfHeight * aspect;
    world.set(camera, Camera, { projection: 1, left: -halfWidth, right: halfWidth, bottom: -rig.value.panHalfHeight, top: rig.value.panHalfHeight, near: 0.1, far: 200 });
    world.set(camera, Transform, { pos: [rig.value.panX, TOP_DOWN_Y, rig.value.panZ], quat: topQuaternion });
  };
  const restorePerspectiveCamera = (): void => {
    const rig = world.get(camera, CameraRig);
    world.set(camera, Camera, { projection: 0, fov: rig.ok ? rig.value.perspectiveFov : PERSPECTIVE_FOV_INITIAL, aspect, near: 0.1, far: 200 });
  };
  setMode = (mode: ViewMode): void => {
    if (mode !== cameraState.mode && player !== undefined) world.set(player, GameplayInput, { lookYaw: 0, lookPitch: 0 });
    cameraState.mode = mode;
    if (mode === 'pan') {
      world.set(camera, CameraRig, { panX: initX, panZ: initZ + TOP_DOWN_OFFSET_Z, panHalfHeight: PAN_HALF_HEIGHT_INITIAL });
      applyPanCamera();
      depthOfField.refresh();
    } else {
      restorePerspectiveCamera();
      depthOfField.refresh();
    }
    hud.setMode(mode);
    setPlayerVisible(mode !== 'fps');
    canvas.style.cursor = mode === 'fps' ? 'crosshair' : '';
    host?.setPointerLockAllowed?.(mode === 'fps' || mode === 'orbit');
  };
  setMode(cameraState.mode);

  hud.setMode(cameraState.mode);

  return { camera, topQuaternion, hud, settingsState, settings, depthOfField, chromaticAberration, getMode: () => cameraState.mode, setMode, applyPanCamera };
}
