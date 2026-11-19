import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const path = new URL(
  '../../../packages/runtime/src/__tests__/physical-sky-ibl.browser.test.ts',
  import.meta.url,
);
const source = ts.createSourceFile(
  path.pathname,
  readFileSync(path, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
let observer;
function findObserver(node) {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(source) === 'deviceLost' &&
    ts.isArrowFunction(node.initializer)
  ) {
    observer = node.initializer;
  }
  ts.forEachChild(node, findObserver);
}
findObserver(source);
assert.ok(observer, 'the actual sky IBL fixture owns its host loss observer');
const javascript = ts.transpileModule(`const deviceLost = ${observer.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test('injected loss retires recorder handles before the renderer sees each real loss', async () => {
  const events = [];
  const fixture = runInNewContext(
    `let signalLoss; ${javascript} ({ deviceLost, signal: () => signalLoss() })`,
    { recorder: { deviceLost: () => events.push('recorder-loss') } },
  );
  for (let generation = 0; generation < 2; generation++) {
    const before = events.length;
    const loss = fixture.deviceLost();
    assert.equal(events.length, before, 'registering an observer does not lose a live device');
    const completed = loss.then((detail) => {
      events.push('renderer-loss');
      assert.equal(detail.reason, 'unknown');
      assert.equal(detail.message, 'host-injected sky IBL recovery');
    });
    fixture.signal();
    assert.deepEqual(events.slice(before), ['recorder-loss']);
    await completed;
    assert.deepEqual(events.slice(before), ['recorder-loss', 'renderer-loss']);
  }
});
