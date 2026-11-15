import { readFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { frameDrawOptions } from '../assembly/draw-frame-input';
import type { DynamicGeometryHostImplementation } from '../assembly/dynamic-geometry-host';
import { runDrawWorldError } from '../assembly/renderer-frame-operations';
import type { RenderFrameInput } from '../render-contract';

function actualDrawRequest(source: object, camera: number): RenderFrameInput {
  const path = new URL('post-process-depth.gpu-fixture.ts', import.meta.url);
  const text = readFileSync(path, 'utf8');
  const tree = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'renderer.draw') {
      if (expression !== undefined) throw new Error('Ambiguous fixture draw input');
      expression = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  if (expression === undefined) throw new Error('Missing actual fixture draw request');
  return new Function('lease', 'camera', `return (${expression.getText(tree)});`)(
    source,
    camera,
  ) as RenderFrameInput;
}

const geometryHost = {
  dynamicGeometryFault: () => undefined,
} as unknown as DynamicGeometryHostImplementation;

it('draws the original post-process source through the Renderer owning lease and selected camera', () => {
  const world = new World();
  const lease = {};
  const owned = new Map([[lease, world]]);
  const request = actualDrawRequest(lease, 17);
  expect(runDrawWorldError(geometryHost, owned.get(request.source ?? {}), request)).toBeUndefined();
  expect(request.source).toBe(lease);
  expect(frameDrawOptions(request)).toMatchObject({ cameraEntityKey: 17 });
});

it('preserves the real rejection of a foreign or retired source lease', () => {
  const attachedLease = {};
  const owned = new Map([[attachedLease, new World()]]);
  const request = actualDrawRequest({}, 17);
  expect(runDrawWorldError(geometryHost, owned.get(request.source ?? {}), request)).toMatchObject({
    code: 'world-lease-invalid',
  });
  const retired = actualDrawRequest(attachedLease, 17);
  owned.delete(attachedLease);
  expect(runDrawWorldError(geometryHost, owned.get(retired.source ?? {}), retired)).toMatchObject({
    code: 'world-lease-invalid',
  });
});
