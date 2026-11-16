import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBarrelDistortionMapping, readEditorAssistance } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { expect, it } from 'vitest';
import { publishBrowserFrameSubmitted, retainBrowserFrameSubmitted } from '../browser-frame-signal';
import { createWorkspaceEditorAssistance } from '../workspace-editor-assistance';

function fixture() {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const target = world.spawn({ component: Transform, data: {} }).unwrap();
  const canvas = Object.assign(new EventTarget(), { width: 128, height: 128 }) as HTMLCanvasElement;
  const editor = createWorkspaceEditorAssistance(world, 'target', canvas);
  const invoke = (intent: Parameters<typeof editor.invoke>[0]['intent'], connectionId = 'owner') =>
    editor.invoke({ intent, connectionId });
  const publish = (frameId: number, deviceGeneration = 1) =>
    publishBrowserFrameSubmitted(canvas, {
      frameId,
      deviceGeneration,
      worldIdentity: world.identity,
      barrelDistortion: createBarrelDistortionMapping(128, 128, { strength: 0 }).unwrap(),
      editorAssistance: {
        frameId,
        deviceGeneration,
        sourceIdentity: world.identity,
        sourceMutationEpoch: 1,
        revision: 1,
        views: [
          {
            identity: 'scene',
            width: 128,
            height: 128,
            hits: [
              {
                action: { kind: 'entity', entity: target },
                depth: 'always',
                triangle: [54, 54, 84, 54, 54, 84],
              },
            ],
          },
        ],
      },
    });
  const pick = (frameId: number, deviceGeneration = 1) =>
    editor.pick({ x: 64, y: 64, frameId, deviceGeneration });
  return { assets, world, target, canvas, editor, invoke, publish, pick };
}

it('keeps View assistance read-only and installs no state for an idle read', () => {
  const f = fixture();
  try {
    expect(f.invoke({ kind: 'get' })).toEqual({ options: { enabled: false } });
    expect(readEditorAssistance(f.world)).toBeUndefined();
    for (const intent of [
      { kind: 'gizmo', entityId: `target:${f.world.identity}:${f.target}` },
      { kind: 'pointer', phase: 'begin', x: 64, y: 64 },
    ]) {
      expect(() => f.invoke(intent as never)).toThrow('read-only');
    }
    f.invoke({ kind: 'configure', options: { enabled: true, icons: true } });
    expect(f.world.inspect().entityCount).toBe(1);
    expect(Array.from(f.world.get(f.target, Transform).unwrap().pos)).toEqual([0, 0, 0]);
    expect(f.invoke({ kind: 'get' })).not.toHaveProperty('gizmo');
  } finally {
    f.editor.dispose();
    f.assets.dispose();
  }
});

it('uses only held submitted frames and rejects retired devices, extents and full entity handles', () => {
  const f = fixture();
  try {
    f.invoke({ kind: 'configure', options: { enabled: true, icons: true } });
    f.publish(1);
    f.publish(2);
    expect(f.pick(1).action?.entity).toBe(f.target);
    f.publish(3);
    expect(() => f.pick(1)).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-frame-unavailable' }),
    );
    f.publish(4, 2);
    expect(() => f.pick(3)).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-frame-unavailable' }),
    );
    expect(f.pick(4, 2).action?.entity).toBe(f.target);
    f.canvas.width = 256;
    expect(() => f.pick(4, 2)).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-frame-unavailable' }),
    );
    f.canvas.width = 128;
    f.world.despawn(f.target).unwrap();
    expect(() => f.pick(4, 2)).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-frame-unavailable' }),
    );
  } finally {
    f.editor.dispose();
    f.assets.dispose();
  }
});

it('retires only the matching presentation connection', () => {
  const f = fixture();
  try {
    f.invoke({ kind: 'configure', options: { enabled: true, icons: true } });
    expect(() => f.invoke({ kind: 'configure', options: { bounds: true } }, 'other')).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-target-busy' }),
    );
    f.editor.revoke('other');
    expect(f.invoke({ kind: 'get' }).options.enabled).toBe(true);
    f.editor.revoke('owner');
    expect(f.invoke({ kind: 'get' }).options.enabled).toBe(false);
    f.invoke({ kind: 'configure', options: { enabled: true } }, 'other');
    expect(f.invoke({ kind: 'get' }).options.enabled).toBe(true);
  } finally {
    f.editor.dispose();
    f.assets.dispose();
  }
});

it('retains the clicked frame across RPC delay and releases it with its request', () => {
  const f = fixture();
  try {
    f.invoke({ kind: 'configure', options: { enabled: true, icons: true } });
    f.publish(1);
    const release = retainBrowserFrameSubmitted(f.canvas, 1);
    expect(release).toBeDefined();
    for (let frame = 2; frame <= 16; frame++) f.publish(frame);
    expect(f.pick(1).action?.entity).toBe(f.target);
    expect(retainBrowserFrameSubmitted(f.canvas, 16)).toBeUndefined();
    release?.();
    expect(() => f.pick(1)).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-frame-unavailable' }),
    );
    const next = retainBrowserFrameSubmitted(f.canvas, 16);
    expect(next).toBeDefined();
    release?.();
    for (let frame = 17; frame <= 20; frame++) f.publish(frame);
    expect(f.pick(16).action?.entity).toBe(f.target);
    f.publish(21, 2);
    expect(() => f.pick(16)).toThrowError(
      expect.objectContaining({ code: 'engine-workspace-frame-unavailable' }),
    );
    next?.();
  } finally {
    f.editor.dispose();
    f.assets.dispose();
  }
});
