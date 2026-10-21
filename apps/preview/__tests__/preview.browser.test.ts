// Browser contract for the capability-lab root asset: real Pack transport,
// native activation, scene ownership, UI/audio, and rendered frames.
// Vitest compiles the single known program through its normal module graph;
// the runtime definition/configuration comes from the published Pack.

import { SUT_ATTRIBUTABLE_CODES } from '@forgeax/apps-shared/onerror-gate';
import { activateExecutionRoot, gameHostPlugin, type App } from '@forgeax/engine-app';
import { createApp } from '@forgeax/engine-app/browser';
import type { GameHost } from '@forgeax/engine-app';
import { AudioSource, audioPlugin } from '@forgeax/engine-audio';
import { webAudioPlugin } from '@forgeax/engine-audio-webaudio';
import type { PluginProgramEntry, PluginPrograms } from '@forgeax/engine-plugin';
import { defineToolCommandContract, type ToolCommandContract } from '@forgeax/engine-tool-runtime';
import type { EntityHandle } from '@forgeax/engine-ecs';
import type { PluginAssetDefinition } from '@forgeax/engine-types';
import type { InputBackend, InputSnapshot } from '@forgeax/engine-input';
import { Camera, MeshRenderer, SceneInstance } from '@forgeax/engine-render';
import { sceneEntity, Transform, worldResolveSceneEntity } from '@forgeax/engine-scene';
import { skinningPlugin } from '@forgeax/engine-skinning';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import gameplay from '../../../apps/game-capability-lab/main';
import project from '../../../apps/game-capability-lab/forge.json';
import { HUD_UI_GUID } from '../../../apps/game-capability-lab/assets/plugins/hud';
import { SETTINGS_UI_GUID } from '../../../apps/game-capability-lab/assets/plugins/settings';

const runtimeBinding = createStandaloneRuntimeAssetBinding(
  import.meta.env.FORGEAX_RUNTIME_SCOPE_ID ?? 'preview',
);

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

describe('apps/preview e2e -- apps/game-capability-lab loads + renders error-free', () => {
  let canvas: HTMLCanvasElement;
  let viewport: HTMLDivElement;
  let activeApp: App | undefined;

  // Production of the complete browser fixture catalog is build preparation.
  // Keep it outside the unchanged 120 s gameplay budget, within the 420 s group budget.
  beforeAll(async () => {
    const response = await fetch(runtimeBinding.catalogUrl, {
      cache: 'no-store',
      signal: AbortSignal.timeout(320_000),
    });
    if (!response.ok)
      throw new Error(`preview Pack preparation failed: ${response.status} ${await response.text()}`);
    await response.arrayBuffer();
  }, 330_000);

  beforeEach(() => {
    // The template reads `document.querySelector('#app')` and its
    // clientWidth/Height, so the canvas must be connected with a layout box.
    viewport = document.createElement('div');
    viewport.style.position = 'relative';
    viewport.style.width = '320px';
    viewport.style.height = '240px';
    canvas = document.createElement('canvas');
    canvas.id = 'app';
    canvas.style.width = '320px';
    canvas.style.height = '240px';
    viewport.appendChild(canvas);
    document.body.appendChild(viewport);
  });

  afterEach(async () => {
    try {
      await activeApp?.dispose();
    } finally {
      activeApp = undefined;
      viewport.remove();
      vi.restoreAllMocks();
    }
  });

  it('createApp + bootstrap + 10 frames instantiates the scene, a Camera, and zero renderer errors', async () => {
    // Browser workers may reuse a page across files; clear any backend left by
    // a neighboring fixture before attaching this test's input backend.
    window.dispatchEvent(new Event('blur'));
    const heldKeys = new Set<string>();
    const inputBackend: InputBackend = {
      sample: () => ({
        downKeys: new Set(heldKeys),
        upKeys: new Set<string>(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      detach: () => {},
    };
    const definitions = new Map<string, PluginAssetDefinition['evidence']>();
    const programEntries = new Map<string, PluginProgramEntry>();
    const tools = new Map<string, ToolCommandContract>();
    const pluginPrograms: PluginPrograms = {
      sessionId: 'preview-browser', contextId: 'preview-engine', sessionGeneration: 1,
      target: 'engine', definitions, programs: programEntries, tools,
    };
    const appRes = await createApp(
      canvas,
      {
        input: inputBackend,
        pluginPrograms,
        plugins: [webAudioPlugin(), audioPlugin(), skinningPlugin()],
      },
      { importTransport: createDevImportTransport(runtimeBinding) },
    );
    if (!appRes.ok) throw appRes.error;
    const app = appRes.value;
    activeApp = app;
    expect(app.world.components.resolve('SceneInstance')).toBe(SceneInstance);

    const errors: string[] = [];
    const uiFailures: string[] = [];
    const materialFailures: string[] = [];
    const originalError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const text = args.map(String).join(' ');
      if (text.includes('UI load failed')) uiFailures.push(text);
      if (text.includes('material-specialization-not-cooked')) materialFailures.push(text);
      originalError(...args);
    });
    app.onError((e: { code?: string }) => {
      errors.push(e.code ?? '<unknown>');
    });

    const assets = app.assets;
    if (assets === undefined) throw new Error('preview App did not expose its asset registry');
    assets.configureRuntimeBinding(runtimeBinding);

    const catalog = await assets.catalogSource?.enumerate();
    if (catalog === undefined) throw new Error('preview App did not configure a Catalog source');
    expect(catalog.ok, 'prepared Pack catalog must be authoritative').toBe(true);
    if (!catalog.ok) throw catalog.error;

    const uiRoot = document.createElement('div');
    uiRoot.dataset.testUiRoot = 'preview-bootstrap';
    viewport.appendChild(uiRoot);
    const ctx: GameHost = { assets, app, canvas, renderer: app.renderer, uiRoot };

    // The native plugin awaits scene load and owns its contributions as effects.
    try {
      await app.pluginContext.plugin(gameHostPlugin(ctx));
      expect(app.pluginContext.world).toBe(app.world);
      expect(app.pluginContext.world.components.resolve('SceneInstance')).toBe(SceneInstance);
      const definition = await assets.readPluginDefinition(project.roots.engine);
      if (!definition.ok) throw definition.error;
      definitions.set(project.roots.engine, definition.value.evidence);
      programEntries.set(definition.value.asset.program, { load: async () => gameplay });
      tools.set(project.roots.engine, defineToolCommandContract([]));
      expect(app.pluginContext.pluginPrograms).toBe(pluginPrograms);
      await activateExecutionRoot(app.pluginContext, { guid: project.roots.engine });
    } catch (error) {
      // Preserve nested domain diagnostics; Vitest truncates thrown POD causes.
      console.error(
        '[preview] startup failure',
        JSON.stringify(
          error,
          (_key, value) => {
            if (!(value instanceof Error)) return value;
            return Object.fromEntries(
              Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]),
            );
          },
          2,
        ),
      );
      throw error;
    }
    expect(uiFailures, `template UI load failures: ${uiFailures.join('; ')}`).toEqual([]);

    const hudHost = uiRoot.querySelector<HTMLElement>(`[data-ui-asset="${HUD_UI_GUID}"]`);
    const settingsHost = uiRoot.querySelector<HTMLElement>(`[data-ui-asset="${SETTINGS_UI_GUID}"]`);
    expect(hudHost, 'gameplay must mount the HUD UiAsset').not.toBeNull();
    expect(settingsHost, 'gameplay must mount the settings UiAsset').not.toBeNull();
    const hudShadow = hudHost?.shadowRoot;
    const settingsShadow = settingsHost?.shadowRoot;
    expect(hudShadow, 'HUD mount must expose an open ShadowRoot').not.toBeNull();
    expect(settingsShadow, 'settings mount must expose an open ShadowRoot').not.toBeNull();
    expect(hudShadow?.querySelector('[data-ui-slot="score"]')?.textContent).toContain('Score');
    expect(hudShadow?.querySelector('[data-ui-slot="hint"]')).not.toBeNull();
    expect(hudShadow?.querySelector('[data-ui-action="open-settings"]')?.textContent).toContain('Settings');
    const dialog = settingsShadow?.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('settings-title');
    expect(settingsShadow?.querySelector('[data-ui-setting="music"]')).not.toBeNull();
    expect(settingsShadow?.querySelector('[data-ui-setting="high-contrast"]')).not.toBeNull();
    expect(settingsShadow?.querySelector('[data-ui-setting="antialias"]')).not.toBeNull();
    const audioEntities: EntityHandle[] = [];
    for (const row of app.world.query({ with: [AudioSource] }).unwrap()) audioEntities.push(row.entity);
    expect(audioEntities.length, 'gameplay must attach a player-owned AudioSource').toBeGreaterThan(0);
    expect(app.renderer, 'runtime shader catalog must remain Host-owned').not.toHaveProperty('shader');
    expect(app.renderer.inspect().features).toEqual(expect.any(Array));
    const source = app.world.get(audioEntities[0]!, AudioSource);
    expect(source.ok).toBe(true);
    const openSettings = hudShadow?.querySelector<HTMLButtonElement>('[data-ui-action="open-settings"]');
    expect(openSettings).not.toBeNull();
    openSettings?.click();
    expect(dialog?.hidden).toBe(false);
    const closeSettings = settingsShadow?.querySelector<HTMLButtonElement>('[data-ui-action="close-settings"]');
    expect(closeSettings).not.toBeNull();
    closeSettings?.click();
    expect(dialog?.hidden).toBe(true);

    const readCameraX = (): number => {
      let x = 0;
      for (const row of app.world.query({ with: [Camera] }).unwrap()) {
          const entity = row.entity;
          const tr = app.world.get(entity, Transform);
          if (tr.ok) x = tr.value.pos[0] ?? 0;
      }
      return x;
    };
    const tickWorld = (): void => {
      const updateRes = app.world.update(1 / 60);
      expect(updateRes.ok).toBe(true);
    };
    const initialCameraX = readCameraX();
    // Drive the world directly so action edges are observed in the same tick
    // as the injected backend sample; a live RAF would make a one-frame edge
    // race the test callback.
    heldKeys.delete('d');
    heldKeys.delete('D');
    tickWorld();
    // Rapier 3D builds the authored Player body on the first physics sync;
    // warm a few host ticks before asserting movement so the KCC readiness
    // boundary is observed rather than racing async WASM setup.
    for (let i = 0; i < 5; i++) tickWorld();
    heldKeys.add('d');
    tickWorld();
    const movementSnapshot = app.world.getResource<InputSnapshot>('InputSnapshot');
    const movementInputSeen = movementSnapshot?.action('moveRight').isPressed() ?? false;
    const movedCameraX = readCameraX();
    heldKeys.delete('d');
    expect(movementInputSeen).toBe(true);
    expect(Math.abs(movedCameraX - initialCameraX)).toBeGreaterThan(0.00001);
    tickWorld();
    // Normalize the injected backend before proving the reset edge.
    heldKeys.delete('r');
    heldKeys.delete('R');
    tickWorld();
    heldKeys.add('r');
    tickWorld();
    const resetSnapshot = app.world.getResource<InputSnapshot>('InputSnapshot');
    expect(resetSnapshot?.action('reset').justPressed()).toBe(true);
    heldKeys.delete('r');
    heldKeys.delete('R');
    tickWorld();
    const resetCameraX = readCameraX();
    expect(Math.abs(resetCameraX - initialCameraX)).toBeLessThan(Math.abs(movedCameraX - initialCameraX));

    const startRes = app.start();
    expect(startRes.ok).toBe(true);
    for (let i = 0; i < 10; i++) {
      await nextFrame();
    }
    activeApp?.stop();

    // Camera => the dynamic layer (camera + gameplay) executed.
    let cameraCount = 0;
    for (const _row of app.world.query({ with: [Camera] }).unwrap()) cameraCount += 1;
    expect(cameraCount).toBeGreaterThan(0);

    // Entity count => the authored scene pack instantiated rather than the
    // template falling back to spawnFallbackScene (which spawns only a single
    // ground entity). The pack authors 21 nodes; with camera + skylight +
    // skybox + ground collider + showcase props the live world is ~27. A
    // count well above the fallback's handful is the "scene loaded + its
    // localId mapping survived" signal -- the #1 "scene loads but is dead"
    // failure mode the template AGENTS.md warns about. (Name is a UniqueRef
    // string component, not a queryable column, so we count entities rather
    // than query for the "Player" name.)
    const entityCount = app.world.inspect().entityCount;
    expect(
      entityCount,
      `only ${entityCount} entities -- scene pack failed to instantiate (fallback path)`,
    ).toBeGreaterThanOrEqual(21);

    // The authored scene also mounts the reusable NestedTarget prefab. Verify
    // the keyed nested address and its field override survived the public
    // loadByGuid -> instantiate path, rather than only counting entities.
    const sceneRoots: EntityHandle[] = [];
    for (const row of app.world.query({ with: [SceneInstance] }).unwrap()) sceneRoots.push(row.entity);
    expect(sceneRoots.length, 'default scene must expose a SceneInstance root').toBeGreaterThan(0);
    const sceneInstance = app.world.get(sceneRoots[0]!, SceneInstance);
    expect(sceneInstance.ok).toBe(true);
    if (sceneInstance.ok) {
      const nestedResult = worldResolveSceneEntity(
        app.world,
        sceneRoots[0]!,
        sceneEntity('scene/main', ['instance-23', 'nestedtarget']),
      );
      expect(nestedResult.ok, 'nested prefab member address must be live').toBe(true);
      if (nestedResult.ok) {
        const nestedEntity = nestedResult.value;
        expect(app.world.get(nestedEntity, MeshRenderer).ok).toBe(true);
        const nestedTransform = app.world.get(nestedEntity, Transform);
        expect(nestedTransform.ok).toBe(true);
        expect(nestedTransform.ok && nestedTransform.value.scale[0]).toBeCloseTo(0.7, 5);
      }
    }

    // The headline gate: a full createApp -> entry -> N-frame run with no
    // SUT-attributable renderer error. We filter to SUT_ATTRIBUTABLE_CODES
    // (the same allow-list apps/shared/onerror-gate.ts uses) so the gate fires
    // on real validation/render faults (shader-compile-failed, asset-not-*,
    // render-system-no-camera, ...) but NOT on `device-lost` -- which in the
    // batched vitest browser runner is an environmental teardown artifact: a
    // sibling test's renderer.dispose() destroys the shared WebGPU device and
    // that loss fans out to every live app's onError. (We also do NOT dispose
    // the renderer here, to avoid being that polluting sibling.)
    const sutErrors = errors.filter((c) => SUT_ATTRIBUTABLE_CODES.has(c));
    expect(sutErrors, `SUT renderer errors: ${sutErrors.join(', ')}`).toEqual([]);
    // Extraction failures can be logged by the ECS frame without reaching
    // App.onError. Observe the complete frame journey, including static materials.
    expect(materialFailures, `material extraction errors: ${materialFailures.join('; ')}`).toEqual([]);
    // A cold shared CI runner can compile Rapier and all nine Scriptable Pack
    // outputs while the rest of the browser DAG is active. Keep that real
    // production path bounded without treating runner contention as a failure.
  }, 120_000);

});
