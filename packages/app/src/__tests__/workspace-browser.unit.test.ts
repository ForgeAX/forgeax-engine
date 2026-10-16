import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { createWorldContext, Update, World } from '@forgeax/engine-ecs';
import { Camera, SceneInstance } from '@forgeax/engine-render';
import { ChildOf, Children, GlobalTransform, Name, Transform } from '@forgeax/engine-scene';
import { describe, expect, it, vi } from 'vitest';
import {
  publishBrowserFrameCompleted,
  publishBrowserFrameSubmitted,
} from '../browser-frame-signal';
import { createAppObservation } from '../observation';
import type { App } from '../types';
import { engineWorkspaceBrowserPlugin } from '../workspace-browser';

const guid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('workspace browser plugin lifecycle', () => {
  it('dispatches actual World tools and revokes its handler and borrowed preview through the Fiber', async () => {
    const world = new World();
    for (const component of [Camera, SceneInstance, ChildOf, Children, GlobalTransform, Transform])
      world.components.register(component).unwrap();
    const entity = world.spawn({ component: Name, data: { value: 'Persistent' } }).unwrap();
    const assets = new AssetRegistry({} as never);
    assets.catalog(guid, { kind: 'scene', entities: { root: { components: {} } } }).unwrap();
    const setInputAllowed = vi.fn();
    const app = {
      world,
      assets,
      renderer: {
        inspect: () => ({
          state: 'alive',
          frame: { frameId: 3 },
          environment: { status: 'candidate' },
        }),
      },
      execution: { report: () => ({ world: { identity: world.identity } }) },
      input: { setInputAllowed },
      observation: createAppObservation(world, {} as never, { report: () => ({}) }),
      start: vi.fn(() => ({ unwrap() {} })),
      resume: vi.fn(() => ({ unwrap() {} })),
      pause: vi.fn(() => ({ unwrap() {} })),
      onError: vi.fn(() => () => {}),
    } as unknown as App;
    const dataset: Record<string, string> = {};
    const canvasAttributes = new Map<string, string>();
    let canvasHidden = false;
    const frameEvents = new EventTarget();
    const capturePixels = vi.fn(() => 'data:image/png;base64,new-size');
    const canvas = {
      dataset,
      getAttribute: (name: string) => canvasAttributes.get(name) ?? null,
      removeAttribute() {},
      addEventListener: frameEvents.addEventListener.bind(frameEvents),
      removeEventListener: frameEvents.removeEventListener.bind(frameEvents),
      dispatchEvent: frameEvents.dispatchEvent.bind(frameEvents),
      toDataURL: capturePixels,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
      ownerDocument: {
        documentElement: {
          dataset,
          removeAttribute: () => {
            delete dataset.forgeaxWorkspaceReady;
          },
        },
        defaultView: { devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} },
      },
      style: {},
      width: 0,
      height: 0,
    } as unknown as HTMLCanvasElement;
    Object.defineProperties(canvas, {
      clientWidth: { get: () => (canvasHidden ? 0 : Number.parseFloat(canvas.style.width) || 0) },
      clientHeight: { get: () => (canvasHidden ? 0 : Number.parseFloat(canvas.style.height) || 0) },
    });
    vi.stubGlobal('devicePixelRatio', canvas.ownerDocument.defaultView?.devicePixelRatio);
    Object.assign(canvas.ownerDocument, {
      body: { append() {} },
      createElement: () => ({
        ownerDocument: canvas.ownerDocument,
        style: {},
        append() {},
        remove() {},
      }),
    });
    const context = await createWorldContext(world);
    const listeners = new Set<(value: unknown) => void>();
    let releaseFrame = () => {};
    let childCreation: { entered: () => void; resume: Promise<void> } | undefined;
    let draining = false;
    const destroyed: string[] = [];
    let childWorldIdentity: string | undefined;
    const unknownFailure: Record<string, unknown> = { opaqueCounter: 1n };
    unknownFailure.self = unknownFailure;
    const childInspection = {
      state: 'alive',
      surface: 'available',
      frame: {
        frameId: 17,
        deviceGeneration: 7,
        pendingCompletionCount: 1,
        pendingCompletions: [
          {
            frameId: 17,
            deviceGeneration: 7,
            presentation: 'ready',
            queue: 'pending',
            reflection: 'not-required',
          },
        ],
      },
      environment: {
        status: 'candidate',
        source: 'image',
        candidate: { signature: 'child-cubemap', generation: 7 },
      },
      recovery: { lastOutcome: 'none', candidateGeneration: 7 },
      iblBinding: {
        status: 'binding-chain-consistent',
        frameId: 17,
        deviceGeneration: 7,
        active: 'fallback',
        resources: { prefilter: { viewIdentity: 701, samplerIdentity: 702, deviceGeneration: 7 } },
      },
      meshMaterialBindings: [
        {
          worldId: 0,
          worldIdentity: 'child',
          entityKey: 42,
          bindings: [{ handle: 4, source: 'mesh-default' }],
          diagnostics: [
            {
              code: 'mesh-renderer-material-override-invalid',
              slotIndex: 0,
              handle: 4,
              detail: unknownFailure,
            },
          ],
          residency: [
            {
              readiness: 'pending',
              samplers: [],
              textures: [],
              preparationFailure: {
                code: 'pipeline-pending',
                expected: 'A prepared material',
                hint: 'Inspect material preparation',
                detail: unknownFailure,
                cause: unknownFailure,
              },
            },
          ],
        },
      ],
      featureGraph: { compileAttempts: 1, compileFailures: 1, accepted: 0 },
      featureDiagnostics: [
        {
          identity: 'child-feature',
          status: 'failed',
          latestError: {
            code: 'render-feature-preparation-failed',
            expected: 'A prepared graphics pipeline',
            hint: 'Inspect the preparation owner',
            detail: { stage: 'prepare', reason: 'pipeline-pending', opaque: unknownFailure },
            cause: unknownFailure,
          },
          inspection: { unsafeProducerDetail: 'not-copied' },
        },
      ],
    };
    const childStepFrame = vi.fn(() => ({
      ok: false,
      error: { code: 'app-frame-step-invalid', detail: { reason: 'credit' } },
    }));
    const replies = new Map<string, (value: Record<string, unknown>) => void>();
    let responseGate: { ids: string[]; entered: () => void; resume: Promise<void> } | undefined;
    const failures: Record<string, unknown>[] = [];
    const pickErrors: Record<string, unknown>[] = [];
    const picked: Record<string, unknown>[] = [];
    const transport = {
      async request(_service: string, payload: unknown) {
        const value = payload as Record<string, unknown>;
        if (value.kind === 'failed') failures.push(value);
        if (value.kind === 'pick-error') pickErrors.push(value);
        if (value.kind === 'picked') picked.push(value);
        replies.get(String(value.id))?.(value);
        if (responseGate?.ids.includes(String(value.id))) {
          responseGate.entered();
          await responseGate.resume;
        }
        return {};
      },
      subscribe(_topic: string, onValue: (value: unknown) => void) {
        listeners.add(onValue);
        return () => {
          listeners.delete(onValue);
        };
      },
    };
    let counter = 0;
    const command = (operation: string, input: unknown) => {
      const id = String(++counter);
      const result = new Promise<Record<string, unknown>>((resolve) => replies.set(id, resolve));
      for (const listener of [...listeners])
        listener({ kind: 'command', id, sessionId: 'session', operation, input });
      return result;
    };
    try {
      for (let cycle = 0; cycle < 10; cycle++) {
        const fiber = await context.plugin(engineWorkspaceBrowserPlugin, {
          app,
          canvas,
          transport,
          async createPreviewApp({ context: scope, targetId }) {
            expect(targetId).toBe('child');
            if (childCreation) {
              childCreation.entered();
              await childCreation.resume;
            }
            const childWorld = new World();
            childWorldIdentity = childWorld.identity;
            for (const binding of childInspection.meshMaterialBindings)
              binding.worldIdentity = childWorld.identity;
            for (const component of [
              Camera,
              SceneInstance,
              ChildOf,
              Children,
              GlobalTransform,
              Transform,
            ])
              childWorld.components.register(component).unwrap();
            const owner = await scope.plugin({
              name: 'test-preview-renderer-and-world',
              provide: ['world'],
              apply(ctx) {
                ctx.provide('world', childWorld);
                ctx.effect(() => () => {
                  destroyed.push(childWorld.identity);
                });
              },
            });
            const frame = new Promise<void>((resolve) => {
              releaseFrame = resolve;
            });
            return {
              ...app,
              world: childWorld,
              renderer: { inspect: () => childInspection },
              execution: { report: () => ({ world: { identity: childWorld.identity } }) },
              stepFrame: childStepFrame,
              observation: createAppObservation(childWorld, {} as never, { report: () => ({}) }),
              async dispose() {
                draining = true;
                await frame;
                await owner.dispose();
                return { ok: true, value: undefined };
              },
            } as unknown as App;
          },
          surface: canvas as unknown as HTMLElement,
          project: { id: 'project', root: '/project' },
          target: {
            targetId: 'target',
            sessionId: 'session',
            worldId: world.identity,
            width: 320,
            height: 240,
            headed: true,
          },
        });
        await fiber.await();
        expect(dataset.forgeaxWorkspaceReady).toBe('true');
        const tools = context.engineWorkspaceTargetTools;
        expect(tools?.pick).toBeTypeOf('function');
        if (!tools?.pick) throw new Error('Expected the actual target tools');
        const pickSpy = vi.spyOn(tools, 'pick');
        if (cycle === 0) {
          const missing = await command('openPreview', {
            asset: { guid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'scene' },
            width: 320,
            height: 240,
          });
          expect(missing).toMatchObject({
            ok: false,
            error: {
              code: expect.not.stringContaining('browser-failure'),
              hint: expect.not.stringContaining('[object Object]'),
            },
          });
        }
        const opened = await command('openPreview', {
          asset: { guid, kind: 'scene' },
          width: 320,
          height: 240,
        });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
        const previewOwner = (opened.value as { previewOwner: string }).previewOwner;
        const presentation = context.engineWorkspacePresentation;
        if (!presentation) throw new Error('Workspace presentation must be installed');
        const ownedTarget = presentation.resolveTarget?.('target');
        expect(ownedTarget?.target.targetId).toBe('target');
        expect(presentation.resolveTarget?.('missing')).toBeUndefined();
        if (cycle === 0) {
          const click = Object.assign(new Event('click'), { button: 0, clientX: 10, clientY: 10 });
          expect(() => frameEvents.dispatchEvent(click)).not.toThrow();
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(pickSpy).not.toHaveBeenCalled();
          expect(
            await command('target.pick', { x: 10, y: 10, targetId: 'target', previewOwner }),
          ).toMatchObject({
            ok: false,
            error: {
              code: 'engine-workspace-frame-unavailable',
              detail: { reason: 'missing-frame' },
            },
          });
          expect(failures).toEqual([]);
          pickSpy.mockRejectedValueOnce(new Error('async-pick-failure'));
          expect(
            await command('target.pick', { x: 10, y: 10, targetId: 'target', previewOwner }),
          ).toMatchObject({
            ok: false,
            error: { code: 'engine-workspace-browser-failure', hint: 'async-pick-failure' },
          });
          expect(failures).toEqual([]);
          expect(pickErrors).toEqual([]);
          expect(picked).toEqual([]);
        }
        expect(
          await command('target.control', { targetId: 'target', previewOwner, mode: 'player' }),
        ).toMatchObject({ ok: false, error: { code: 'engine-workspace-capability-unavailable' } });
        if (cycle === 0) publishBrowserFrameSubmitted(canvas, { frameId: 1, deviceGeneration: 0 });
        canvasHidden = true;
        const resized = await command('resize', {
          targetId: 'target',
          previewOwner,
          width: 400,
          height: 300,
        });
        expect(resized).toMatchObject({
          ok: true,
          value: { target: { width: 400, height: 300, worldId: world.identity } },
        });
        expect([canvas.width, canvas.height]).toEqual([400, 300]);
        canvasHidden = false;
        if (cycle === 0) {
          canvasAttributes.set('data-forgeax-render-width-limit', '160');
          canvasAttributes.set('data-forgeax-render-height-limit', '90');
          await command('resize', { targetId: 'target', previewOwner, width: 1204, height: 658 });
          expect([canvas.width, canvas.height]).toEqual([160, 87]);
          canvasAttributes.clear();
          await command('resize', { targetId: 'target', previewOwner, width: 400, height: 300 });
          const capture = command('capture', { targetId: 'target', previewOwner });
          publishBrowserFrameCompleted(canvas, {
            frameId: 1,
            deviceGeneration: 0,
            presentation: 'ready',
          });
          publishBrowserFrameSubmitted(canvas, { frameId: 2, deviceGeneration: 0 });
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(capturePixels).not.toHaveBeenCalled();
          publishBrowserFrameCompleted(canvas, {
            frameId: 2,
            deviceGeneration: 0,
            presentation: 'pending',
          });
          await new Promise((resolve) => setTimeout(resolve, 40));
          expect(
            capturePixels,
            'pending GPU completion cannot qualify capture',
          ).not.toHaveBeenCalled();
          publishBrowserFrameSubmitted(canvas, { frameId: 3, deviceGeneration: 0 });
          publishBrowserFrameCompleted(canvas, {
            frameId: 3,
            deviceGeneration: 0,
            presentation: 'ready',
          });
          expect(await capture).toMatchObject({
            ok: true,
            value: { frameId: 3, width: 400, height: 300 },
          });
          expect(capturePixels).toHaveBeenCalledOnce();
          const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
          try {
            dataset.forgeaxPreviewRhiWindow = JSON.stringify({
              targetId: 'target',
              worldIdentity: world.identity,
              status: 'recording',
              frames: [{ frameId: 3 }],
            });
            const stalled = command('capture', { targetId: 'target', previewOwner });
            await new Promise((resolve) => setTimeout(resolve, 40));
            clock.mockReturnValue(11_001);
            expect(await stalled).toMatchObject({
              ok: false,
              error: {
                code: 'engine-workspace-browser-failure',
                detail: {
                  targetId: 'target',
                  worldIdentity: world.identity,
                  rhiCapture: {
                    targetId: 'target',
                    worldIdentity: world.identity,
                    status: 'recording',
                    frames: [{ frameId: 3 }],
                  },
                  frameFloor: 3,
                  submittedFrame: 3,
                  readyCompletedFrame: 3,
                  renderer: { state: 'alive', environment: { status: 'candidate' } },
                },
              },
            });
            expect(capturePixels).toHaveBeenCalledOnce();
            dataset.forgeaxPreviewRhiWindow = JSON.stringify({
              targetId: 'target',
              worldIdentity: 'another-world',
              status: 'uploaded',
            });
            const wrongWorld = command('capture', { targetId: 'target', previewOwner });
            await new Promise((resolve) => setTimeout(resolve, 40));
            clock.mockReturnValue(22_002);
            const rejected = await wrongWorld;
            expect(rejected).toMatchObject({ ok: false });
            expect((rejected.error as { detail: unknown }).detail).not.toHaveProperty('rhiCapture');
          } finally {
            delete dataset.forgeaxPreviewRhiWindow;
            clock.mockRestore();
          }
        }
        expect([canvas.style.width, canvas.style.height]).toEqual(['200px', '150px']);
        expect(
          await command('resize', { targetId: 'target', previewOwner, width: 0, height: 300 }),
        ).toMatchObject({ ok: false });
        expect(canvas.width).toBe(400);
        const selected = await command('entity.inspect', {
          targetId: 'target',
          previewOwner,
          entityId: `target:${world.identity}:${entity}`,
        });
        expect(selected).toMatchObject({
          ok: true,
          value: { name: 'Persistent', worldId: world.identity },
        });
        const stale = await command('entity.inspect', {
          targetId: 'target',
          previewOwner: 'stale',
          entityId: `target:${world.identity}:${entity}`,
        });
        expect(stale).toMatchObject({
          ok: false,
          error: { code: 'engine-workspace-target-stale' },
        });
        if (cycle === 0) {
          let resumeCreation = () => {};
          const creationEntered = new Promise<void>((resolve) => {
            childCreation = {
              entered: resolve,
              resume: new Promise<void>((resume) => {
                resumeCreation = resume;
              }),
            };
          });
          const childOpening = command('openPreview', {
            targetId: 'target',
            previewTargetId: 'child',
            asset: { guid, kind: 'scene' },
          });
          await creationEntered;
          let tree: Record<string, unknown> | undefined;
          let inspected: Record<string, unknown> | undefined;
          let staleQuery: Record<string, unknown> | undefined;
          let cancelledQuery: Record<string, unknown> | undefined;
          const inspectSpy = vi.spyOn(tools, 'inspect');
          void command('scene.tree.get', { targetId: 'target', previewOwner }).then((value) => {
            tree = value;
          });
          void command('entity.inspect', {
            targetId: 'target',
            previewOwner,
            entityId: `target:${world.identity}:${entity}`,
          }).then((value) => {
            inspected = value;
          });
          void command('entity.inspect', {
            targetId: 'target',
            previewOwner: 'stale',
            entityId: `target:${world.identity}:${entity}`,
          }).then((value) => {
            staleQuery = value;
          });
          void command('entity.inspect', {
            targetId: 'target',
            previewOwner,
            entityId: `target:${world.identity}:${entity}`,
          }).then((value) => {
            cancelledQuery = value;
          });
          for (const listener of [...listeners])
            listener({ kind: 'cancel', id: String(counter), sessionId: 'session' });
          const queuedResize = command('resize', {
            targetId: 'target',
            previewOwner,
            width: 401,
            height: 300,
          });
          let queriesAvailable = false;
          try {
            await vi.waitFor(() => {
              expect(tree).toMatchObject({
                ok: true,
                value: {
                  nodes: expect.arrayContaining([
                    expect.objectContaining({ name: 'Persistent', entity }),
                  ]),
                },
              });
              expect(inspected).toMatchObject({
                ok: true,
                value: { name: 'Persistent', worldId: world.identity },
              });
              expect(staleQuery).toMatchObject({
                ok: false,
                error: { code: 'engine-workspace-target-stale' },
              });
              expect(cancelledQuery).toMatchObject({ ok: false });
            });
            expect(inspectSpy).toHaveBeenCalledOnce();
            expect(canvas.width).toBe(400);
            queriesAvailable = true;
          } finally {
            childCreation = undefined;
            resumeCreation();
            await childOpening;
            if (!queriesAvailable) releaseFrame();
          }
          const child = await childOpening;
          expect(await queuedResize).toMatchObject({ ok: true });
          expect(canvas.width).toBe(401);
          await command('resize', { targetId: 'target', previewOwner, width: 400, height: 300 });
          expect(child).toMatchObject({ ok: true, value: { target: { targetId: 'child' } } });
          const childOwner = (child.value as { previewOwner: string }).previewOwner;
          const childClock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
          try {
            const stalledChild = command('capture', {
              targetId: 'child',
              previewOwner: childOwner,
            });
            await new Promise((resolve) => setTimeout(resolve, 40));
            childClock.mockReturnValue(11_001);
            const rejectedChild = await stalledChild;
            expect(rejectedChild).toMatchObject({
              ok: false,
              error: {
                code: 'engine-workspace-browser-failure',
                detail: {
                  targetId: 'child',
                  worldIdentity: childWorldIdentity,
                  renderer: {
                    ...childInspection,
                    meshMaterialBindings: [
                      {
                        worldId: 0,
                        worldIdentity: childWorldIdentity,
                        entityKey: 42,
                        bindings: [{ handle: 4, source: 'mesh-default' }],
                        diagnostics: [
                          {
                            code: 'mesh-renderer-material-override-invalid',
                            slotIndex: 0,
                            handle: 4,
                          },
                        ],
                        residency: [
                          {
                            readiness: 'pending',
                            samplers: [],
                            textures: [],
                            preparationFailure: {
                              code: 'pipeline-pending',
                              expected: 'A prepared material',
                              hint: 'Inspect material preparation',
                            },
                          },
                        ],
                      },
                    ],
                    featureDiagnostics: [
                      {
                        identity: 'child-feature',
                        status: 'failed',
                        latestError: {
                          code: 'render-feature-preparation-failed',
                          expected: 'A prepared graphics pipeline',
                          hint: 'Inspect the preparation owner',
                        },
                      },
                    ],
                  },
                  execution: { world: { identity: childWorldIdentity } },
                },
              },
            });
            expect(
              (rejectedChild.error as { detail: { renderer: { featureDiagnostics: unknown[] } } })
                .detail.renderer.featureDiagnostics[0],
            ).not.toHaveProperty('inspection');
            expect(() =>
              JSON.stringify((rejectedChild.error as { detail: unknown }).detail),
            ).not.toThrow();
            const serialized = JSON.stringify(rejectedChild.error);
            expect(serialized).not.toContain('opaqueCounter');
            expect(serialized).not.toContain('unsafeProducerDetail');
            expect(serialized).not.toContain('"cause"');
            expect(childWorldIdentity).not.toBe(world.identity);
            expect(capturePixels).toHaveBeenCalledOnce();
          } finally {
            childClock.mockRestore();
          }
          const closing = command('closePreview', { targetId: 'child' });
          try {
            await vi.waitFor(() => expect(draining).toBe(true));
            expect(destroyed).toEqual([]);
          } finally {
            releaseFrame();
          }
          expect(await closing).toMatchObject({ ok: true });
          expect(destroyed).toHaveLength(1);
          expect(context.world).toBe(world);
          expect(await command('closePreview', { targetId: 'target', previewOwner })).toMatchObject(
            { ok: true },
          );
          expect(presentation.resolveTarget?.('target')).toBeUndefined();
          expect(() => ownedTarget?.getCamera({ targetId: 'target' })).toThrow('closed');
          expect(
            await command('target.pick', { x: 10, y: 10, targetId: 'target', previewOwner }),
          ).toMatchObject({ ok: false });
          expect(picked).toEqual([]);
          expect(pickErrors).toEqual([]);
        }
        if (cycle === 9) {
          world
            .addSystem(Update, {
              name: 'broken-game',
              queries: [],
              fn() {
                throw new Error('broken game');
              },
            })
            .unwrap();
          const update = world.update();
          expect(update.ok).toBe(false);
          const notify = vi.mocked(app.onError).mock.calls.at(-1)?.[0];
          if (!notify) throw new Error('The error listener must be installed');
          const error = {
            code: 'app-system-update-failed',
            expected: 'A healthy World',
            hint: 'Stop the failed run.',
          } as never;
          notify(error);
          notify(error);
          expect(failures).toEqual([
            expect.objectContaining({ kind: 'failed', targetId: 'target', error }),
          ]);
          world.removeSystem(Update, 'broken-game').unwrap();
        }
        expect(setInputAllowed).toHaveBeenCalledWith(false);
        await fiber.dispose();
        expect(setInputAllowed).toHaveBeenLastCalledWith(true);
        expect(listeners.size).toBe(0);
        expect(context.engineWorkspaceTargetTools).toBeUndefined();
        expect(dataset.forgeaxWorkspaceReady).toBeUndefined();
        expect(world.get(entity, Name).unwrap().value).toBe('Persistent');
        if (cycle < 9) expect([...world.query({}).unwrap()].length).toBe(1);
      }
      setInputAllowed.mockClear();
      const game = await context.plugin(engineWorkspaceBrowserPlugin, {
        app,
        canvas,
        transport,
        input: { owner: () => 'game', grantGame() {}, revokeGame() {} } as never,
        project: { id: 'project', root: '/project' },
        target: {
          targetId: 'game',
          sessionId: 'session',
          worldId: world.identity,
          width: 320,
          height: 240,
          headed: true,
        },
      });
      await game.await();
      expect(
        await command('resize', {
          targetId: 'game',
          previewOwner: 'session',
          width: 640,
          height: 360,
        }),
      ).toMatchObject({ ok: true, value: { target: { width: 640, height: 360 } } });
      expect([canvas.width, canvas.height]).toEqual([640, 360]);
      let releaseResponses = () => {};
      let responsesEntered = 0;
      responseGate = {
        ids: [String(counter + 1), String(counter + 2)],
        entered: () => responsesEntered++,
        resume: new Promise<void>((resolve) => {
          releaseResponses = resolve;
        }),
      };
      const reads = Promise.all([
        command('describe', { targetId: 'game' }),
        command('scene.tree.get', { targetId: 'game', previewOwner: 'session' }),
      ]);
      await vi.waitFor(() => expect(responsesEntered).toBe(2));
      expect(await reads).toEqual([
        expect.objectContaining({ ok: true }),
        expect.objectContaining({ ok: true }),
      ]);
      let contextDisposed = false;
      const disposing = context.fiber.dispose().then(() => {
        contextDisposed = true;
      });
      try {
        await vi.waitFor(() => expect(listeners.size).toBe(0));
        expect(contextDisposed).toBe(false);
      } finally {
        responseGate = undefined;
        releaseResponses();
        await disposing;
      }
      expect(contextDisposed).toBe(true);
      expect(setInputAllowed).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await context.fiber.dispose();
    }
  });
});
