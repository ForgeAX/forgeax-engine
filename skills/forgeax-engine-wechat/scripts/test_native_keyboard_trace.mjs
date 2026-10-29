import assert from 'node:assert/strict';
import test from 'node:test';
import { observeNativeKeyboard } from './native_keyboard_trace.js';

test('observes calls/events without retaining text and restores its exact leases', () => {
  const listeners = new Map(), calls = [], timers = [];
  const wx = { showKeyboard(...args) { calls.push([this, args]); return 7; }, hideKeyboard() {} };
  const original = Object.getOwnPropertyDescriptor(wx, 'showKeyboard');
  for (const name of ['KeyboardInput', 'WindowResize']) {
    wx['on' + name] = callback => listeners.set(name, callback);
    wx['off' + name] = callback => { assert.equal(listeners.get(name), callback); listeners.delete(name); };
  }
  const trace = observeNativeKeyboard(wx, () => 'field', callback => { timers.push(callback); return 3; }, id => assert.equal(id, 3));
  const options = { defaultValue: 'private text' };
  assert.equal(wx.showKeyboard(options), 7);
  assert.equal(calls[0][0], wx); assert.equal(calls[0][1][0], options);
  listeners.get('KeyboardInput')({ value: 'private text' });
  assert.equal(trace.report.events[1].valueLength, 12);
  assert.equal(JSON.stringify(trace.report).includes('private text'), false);
  assert.doesNotThrow(() => listeners.get('KeyboardInput')(Object.defineProperty({}, 'value', { get() { throw new Error(); } })));
  assert.equal(trace.report.collectionFailed, 1);
  wx.hideKeyboard(); assert.ok(trace.report.events[2].stack);
  for (let i = 0; i < 100; i++) listeners.get('WindowResize')({ size: { windowWidth: 844, windowHeight: 390 } });
  assert.equal(trace.report.events.length, 64); assert.equal(trace.report.dropped, 39);
  timers[0](); trace.release();
  assert.equal(listeners.size, 0); assert.equal(trace.report.ended, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(wx, 'showKeyboard'), original);
});

test('keeps original throws and later method ownership', () => {
  const cause = new Error('native failure');
  const wx = { showKeyboard() { throw cause; }, hideKeyboard() {} };
  const trace = observeNativeKeyboard(wx, () => { throw cause; }, () => 1, () => {});
  assert.throws(() => wx.showKeyboard(), error => error === cause);
  const replacement = () => {};
  wx.hideKeyboard = replacement;
  trace.release(); assert.equal(wx.hideKeyboard, replacement);
  assert.equal(trace.report.events[0].focusUnavailable, true);
});
