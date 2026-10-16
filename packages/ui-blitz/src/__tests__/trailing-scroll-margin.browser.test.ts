import { expect, it } from 'vitest';
import { createBlitzUi, type UiWasmHost } from '../index.js';
import { required } from './fixture.js';

const bytes = new Uint8Array(
  await (await fetch(new URL('../../pkg/ui_blitz_bg.wasm', import.meta.url))).arrayBuffer(),
);
const wasm: UiWasmHost = {
  readWasm: async () => bytes,
  instantiate: (imports) => WebAssembly.instantiate(bytes, imports as WebAssembly.Imports),
};
const metrics = (element: HTMLElement) => ({
  height: element.scrollHeight,
  client: element.clientHeight,
  top: element.scrollTop,
});

it.each([
  [0, 0, 200],
  [12, 0, 224],
  [0, 12, 212],
  [12, 12, 236],
])('includes the final block margin in scroll extent and resize (padding=%s, margin=%s)', async (padding, margin, expected) => {
  const html = `<style>*{box-sizing:border-box}html,body{margin:0}
    #outer{width:300px;height:100px;padding:${padding}px;overflow:auto}
    #child{height:200px;margin-bottom:${margin}px;background:red}</style>
    <div id="outer"><div id="child"></div></div>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width:320px;height:240px;border:0';
  document.body.append(frame);
  const loaded = new Promise<void>((resolve) => {
    frame.onload = () => resolve();
  });
  frame.srcdoc = html;
  await loaded;
  const reference = required(required(frame.contentDocument).querySelector<HTMLElement>('#outer'));
  const ui = await createBlitzUi({
    wasm,
    html,
    width: 320,
    height: 240,
    onError: (cause) => {
      throw cause;
    },
  });
  try {
    const actual = required(ui.document.querySelector<HTMLElement>('#outer'));
    expect(metrics(reference)).toEqual({ height: expected, client: 100, top: 0 });
    expect(metrics(actual)).toEqual(metrics(reference));
    for (const element of [reference, actual]) element.scrollTop = 10000;
    expect(metrics(reference).top).toBe(expected - 100);
    expect(metrics(actual)).toEqual(metrics(reference));
    for (const element of [reference, actual]) element.style.height = '160px';
    expect(metrics(reference)).toEqual({ height: expected, client: 160, top: expected - 160 });
    expect(metrics(actual)).toEqual(metrics(reference));
  } finally {
    ui.dispose();
    frame.remove();
  }
});
