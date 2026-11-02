import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
 CAPTURE_TIMEOUT_MS, checkpointRows, draftValues, ENGINE_WORKSPACE_CALL_SERVICE, highlightOverlays, mergePick, modelingOperations, pickSize, pixelBox,
 pixelRay, projectRelative, SELECTION_OVERLAY_KEY, selectorReference, sliderValue, slidersOf, stabilityNotes,
} from '../model.ts';

// The top view of model.render: camera above the center looking down -y; right +x, up -z.
const top = {
 view: 'top', image: '.forgeax/tool-runs/r/view-top.png',
 camera: { eye: [0, 3, 0], target: [0, 0, 0], mapping: { width: 512, height: 512, pixelsPerMeter: 256, center: [0, 0, 0], right: [1, 0, 0], up: [0, 0, -1] } },
};
const close = (a, b) => a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) < 1e-9, `${a} vs ${b}`));

test('a click becomes a world ray through the pixel along the view direction', () => {
 const ray = pixelRay(top, 256 + 128, 256 - 64);
 close(ray.direction, [0, -1, 0]);
 // 128 px right = 0.5 m along +x; 64 px up = 0.25 m along up (-z); starting at the camera plane.
 close(ray.origin, [0.5, 3, -0.25]);
 assert.equal(pixelRay({ ...top, camera: { eye: [0, 3, 0], target: [0, 0, 0] } }, 1, 1), undefined);
});

test('a drag becomes a box select in the view frame', () => {
 const box = pixelBox(top, [0, 0], [256, 128]);
 close(box.center, [-0.5, 0, -0.75]);
 assert.equal(box.halfWidth, 0.5);
 assert.equal(box.halfHeight, 0.25);
 close(box.direction, [0, -1, 0]);
 assert.equal(box.visible, true);
 assert.equal(pixelBox(top, [10, 10], [10, 40]), undefined);
 assert.equal(pixelBox(top, [0, 0], [8, 8], false).visible, false);
});

test('Shift adds picks, a plain click replaces them', () => {
 const a = mergePick({}, { faces: [3, 1] }, false);
 const b = mergePick(a, { faces: [1, 2], rays: [{ origin: [0, 0, 0], direction: [1, 0, 0] }] }, false);
 assert.deepEqual(b.faces, [1, 2, 3]);
 assert.equal(pickSize(b), 4);
 assert.deepEqual(mergePick(b, { faces: [9] }, true), { faces: [9] });
});

test('sliders cover ranged numeric draft fields and snap to their domain', () => {
 const sliders = slidersOf([
  { name: 'diameter', type: 'f32', minimum: 0.4572, maximum: 0.5588 },
  { name: 'spokes', type: 'u32', minimum: 5, maximum: 10 },
  { name: 'label', type: 'string' },
  { name: 'open', type: 'f32', minimum: 1 },
  { name: 'flat', type: 'f32', minimum: 1, maximum: 1 },
 ]);
 assert.deepEqual(sliders.map(s => [s.name, s.integer]), [['diameter', false], ['spokes', true]]);
 assert.equal(sliderValue(sliders[1], 7.6), 8);
 assert.equal(sliderValue(sliders[1], 42), 10);
 assert.equal(sliderValue(sliders[0], 0.1), 0.4572);
 assert.deepEqual(draftValues({ diameter: 0.5, spokes: 7, label: 'x' }, sliders), { diameter: 0.5, spokes: 7 });
});

test('checkpoint rows list every session checkpoint, then the output final state', () => {
 const rows = checkpointRows({ sessions: [
  { index: 0, faces: 10, checkpoints: [{ name: 'helper', opIndex: 1, faces: 4 }] },
  { index: 1, output: 'mesh/wheel-rim', faces: 2899, checkpoints: [{ name: 'barrel', opIndex: 2, faces: 600 }, { name: 'assembled', opIndex: 3, faces: 2800 }] },
 ] });
 assert.deepEqual(rows.map(r => [r.name, r.session, r.checkpoint]), [['helper', 0, 'helper'], ['barrel', 1, 'barrel'], ['assembled', 1, 'assembled'], ['mesh/wheel-rim', 1, undefined]]);
});

const report = {
 expression: "sel.tag('window-array:2')", jaccard: 1, picked: 28, matched: 28, fallback: false, stability: 'unstable',
 checks: [{ parameter: 'spokes', value: 5, jaccard: 1 }, { parameter: 'spokes', value: 10, jaccard: 0 }],
 alternatives: [], session: 5,
 highlight: { topology: 'triangle-list', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], colors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
};

test('the AI reference carries the selector, J, stability and where it was evaluated', () => {
 assert.deepEqual(stabilityNotes(report), ['spokes = 10: J = 0']);
 const ref = selectorReference(report, { source: 'assets/wheel-rim.pack.ts', values: { spokes: 5 } });
 assert.match(ref.text, /sel\.tag\('window-array:2'\)/);
 assert.match(ref.text, /J = 1, unstable/);
 assert.match(ref.text, /"source":"assets\/wheel-rim.pack.ts"/);
 assert.match(ref.text, /model\.select/);
 assert.deepEqual(stabilityNotes({ ...report, fallback: true }), ['names positions (near): holds for this build only']);
 assert.deepEqual(stabilityNotes({ ...report, checks: [] }), []);
});

test('highlight overlays add or remove one preview overlay key', () => {
 assert.deepEqual(Object.keys(highlightOverlays(report)), [SELECTION_OVERLAY_KEY]);
 assert.equal(highlightOverlays(report)[SELECTION_OVERLAY_KEY].positions.length, 9);
 assert.equal(highlightOverlays(undefined)[SELECTION_OVERLAY_KEY], null);
});

test('model.* calls go through the Engine workspace call service with fixed render defaults', async () => {
 const calls = [];
 const ops = modelingOperations(async (service, payload) => { calls.push([service, payload]); return {}; });
 await ops.render({ source: 'a.pack.ts', views: ['top'] });
 await ops.select({ source: 'a.pack.ts', selector: 'sel.all()' });
 await ops.synthesize({ source: 'a.pack.ts', pick: { faces: [1] } });
 assert.equal(calls.every(([service]) => service === ENGINE_WORKSPACE_CALL_SERVICE), true);
 assert.deepEqual(calls.map(([, p]) => p.operation), ['model.render', 'model.select', 'model.synthesize']);
 assert.deepEqual(calls[0][1].args.views, ['top']);
 assert.equal(calls[0][1].args.projection, 'orthographic');
 assert.equal(calls[1][1].args.highlight, true);
 assert.ok(calls.every(([, p]) => p.args.timeoutMs === CAPTURE_TIMEOUT_MS));
});

test('Pack paths become project relative', () => {
 assert.equal(projectRelative('/p/assets/a.pack.ts', '/p'), 'assets/a.pack.ts');
 assert.equal(projectRelative('assets/a.pack.ts', '/p'), 'assets/a.pack.ts');
 assert.equal(projectRelative('/q/a.pack.ts', '/p/'), '/q/a.pack.ts');
});
