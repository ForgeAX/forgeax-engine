import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachEngineFatalBanner } from '../packages/view-plugin-viewport/src/engine-fatal-banner.ts';
import { setLocale } from '../packages/view-plugin-viewport/src/i18n/index.ts';

test('fatal banner locale updates preserve diagnostics and existing copy feedback reset timing', async () => {
  const observers = [];
  const previousObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  const createElement = () => ({
    children: [], style: {}, attributes: {}, listeners: {}, writes: 0, isConnected: true,
    set textContent(value) { this.text = value; this.writes++; },
    get textContent() { return this.text ?? ''; },
    append(...children) { for (const child of children) child.parentNode = this; this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    remove() {},
  });
  const host = createElement();
  const fatal = createElement();
  fatal.style.display = 'grid';
  fatal.textContent = 'engine-start-failed: original diagnostic';
  const copied = [];
  setLocale('en');
  const dispose = attachEngineFatalBanner({
    document: { createElement, documentElement: {}, getElementById: () => fatal, querySelector: () => null },
    host,
    writeClipboard: async text => { copied.push(text); },
  });
  try {
    const [message, actions] = host.children[0].children;
    const [copy, close] = actions.children;
    const writes = copy.writes + close.writes;
    observers[1].callback();
    assert.equal(copy.writes + close.writes, writes, 'observer synchronization must not write unchanged labels');
    copy.listeners.click({ preventDefault() {}, stopPropagation() {} });
    await Promise.resolve();
    assert.equal(copy.textContent, 'Copied');
    setLocale('zh');
    assert.equal(copy.textContent, '已复制');
    observers[1].callback();
    assert.equal(copy.textContent, '复制错误');
    assert.equal(message.textContent, fatal.textContent);
    assert.deepEqual(copied, [fatal.textContent]);
  } finally {
    dispose();
    assert.ok(observers.every(observer => observer.disconnected));
    globalThis.MutationObserver = previousObserver;
    setLocale('en');
  }
});
