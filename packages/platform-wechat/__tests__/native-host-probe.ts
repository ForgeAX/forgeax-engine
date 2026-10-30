// Simulator contract fixture; its callbacks and 2D pixels are not Renderer receipts.
import { Update, World } from '@forgeax/engine-ecs';
import { INPUT_BACKEND_KEY, INPUT_SNAPSHOT_RESOURCE_KEY, InputFrameStartScan, type InputSnapshot } from '@forgeax/engine-input';
import { createWechatInputBackend, createWechatPlatform, type WechatHost, type WechatTouchSource } from '../src/index.js';

declare const wx: WechatHost['wx'] & WechatTouchSource;
declare const GameGlobal: Record<string, unknown>;

const platform = createWechatPlatform({ wx, requestAnimationFrame: callback => requestAnimationFrame(callback), cancelAnimationFrame }).unwrap();
const display = platform.display().unwrap();
platform.canvas.width = Math.round(display.width * display.pixelRatio);
platform.canvas.height = Math.round(display.height * display.pixelRatio);
const canvas = platform.canvas as typeof platform.canvas & {
  getContext(kind: '2d'): CanvasRenderingContext2D;
};
const context = canvas.getContext('2d');
const input = createWechatInputBackend(wx, platform).unwrap();
const world = new World();
world.insertResource(INPUT_BACKEND_KEY, input);
world.addSystem(Update, InputFrameStartScan).unwrap();
const state = {
  kind: 'native-host-contract-only',
  display: platform.display().unwrap(),
  initialNativeTime: wx.getPerformance().now(),
  initialMilliseconds: platform.now().unwrap(),
  elapsedMilliseconds: 0,
  hostCallbacks: 0,
  cancelledCallbackRan: false,
  touches: [] as unknown[],
  inputEvents: 0,
  events: [] as unknown[],
  clockMeasurement: undefined as { nativeDelta: number; milliseconds: number; wallMilliseconds: number } | undefined,
};
GameGlobal.__forgeaxHostProbe = state;
console.log("FORGEAX_HOST_PROBE_READY", state);
const startedWall = Date.now();
setTimeout(() => {
  state.clockMeasurement = { nativeDelta: wx.getPerformance().now() - state.initialNativeTime, milliseconds: platform.now().unwrap() - state.initialMilliseconds, wallMilliseconds: Date.now() - startedWall };
  console.log('FORGEAX_HOST_CLOCK', state.clockMeasurement);
}, 250);
platform.subscribe(event => { state.events.push(event); }).unwrap();
function paint() {
  context.fillStyle = '#102334';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.save();
  context.scale(display.pixelRatio, display.pixelRatio);
  context.fillStyle = '#7ee2b8';
  context.font = 'bold 22px sans-serif';
  context.fillText('ForgeAX native host', 22, 65);
  context.fillStyle = '#e4edf3';
  context.font = '15px sans-serif';
  context.fillText('Platform contract probe', 22, 103);
  context.fillText(`Host callbacks: ${state.hostCallbacks}`, 22, 145);
  context.fillText(`Native elapsed ms: ${state.elapsedMilliseconds.toFixed(2)}`, 22, 175);
  context.fillText(`Touches: ${state.touches.length}`, 22, 205);
  context.fillText(`Cancellation: ${state.cancelledCallbackRan ? 'FAIL' : 'OK'}`, 22, 235);
  context.fillText('This is not a 3D game acceptance run.', 22, 285);
  context.fillText(`World input events: ${state.inputEvents}`, 22, 325);
  context.restore();
}
const cancelResult = platform.requestFrame(() => { state.cancelledCallbackRan = true; });
if (!cancelResult.ok) console.error('FORGEAX_REQUEST_ERROR', cancelResult.error.code, String(cancelResult.error.detail), 'cause' in cancelResult.error.detail ? String(cancelResult.error.detail.cause) : '');
cancelResult.unwrap()();
function frame() {
  world.update(1 / 60).unwrap();
  const snapshot = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
  if (snapshot.pointerEvents.length > 0) {
    state.inputEvents += snapshot.pointerEvents.length;
    state.touches.push(...snapshot.pointerEvents.filter(event => event.phase === 'down'));
    if (state.touches.length > 20) state.touches.splice(0, state.touches.length - 20);
    console.log('FORGEAX_HOST_INPUT', { worldIdentity: world.identity, events: snapshot.pointerEvents, pointerLocked: snapshot.mouse.pointerLocked });
  }
  state.hostCallbacks += 1;
  state.elapsedMilliseconds = platform.now().unwrap() - state.initialMilliseconds;
  paint();
  if (state.hostCallbacks === 120) console.log("FORGEAX_HOST_PROBE_COMPLETE", state);
  platform.requestFrame(frame).unwrap();
}
platform.requestFrame(frame).unwrap();
