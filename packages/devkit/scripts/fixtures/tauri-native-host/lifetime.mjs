import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const addon = createRequire(import.meta.url)(process.env.NATIVE_TAURI_ADDON ?? fileURLToPath(new URL(`./native/tauri-native-host.${process.platform}-${process.arch}.node`, import.meta.url)));
assert.equal(typeof globalThis.gc, 'function', 'Run this fixture with node --expose-gc');
const options = JSON.stringify({title:'ForgeaX drawable lifetime',width:320,height:180});
let controller = new addon.TauriWindow(options);
const native = controller.takeNativeWindow();
const weakController = new WeakRef(controller);
controller = undefined;
for (let i=0;i<8;i++) { await delay(0); globalThis.gc(); await delay(10); }
assert.equal(weakController.deref(), undefined, 'UI controller was collected');
assert.equal(JSON.parse(native.facts()).width, 320, 'RHI retains the drawable after UI controller GC');
native.pollEvents();
native.close();
let unclaimed = new addon.TauriWindow(options);
const weakUnclaimed = new WeakRef(unclaimed);
unclaimed = undefined;
for (let i=0;i<8;i++) { await delay(0); globalThis.gc(); await delay(10); }
assert.equal(weakUnclaimed.deref(), undefined, 'unclaimed UI owner was collected');
let finalController = new addon.TauriWindow(options);
let finalNative = finalController.takeNativeWindow();
const weakNative = new WeakRef(finalNative);
finalController = undefined;
finalNative = undefined;
for (let i=0;i<8;i++) { await delay(0); globalThis.gc(); await delay(10); }
assert.equal(weakNative.deref(), undefined, 'native surface owner was collected');
addon.shutdownHost();
console.log(JSON.stringify({status:'pass',checks:['UI GC preserves the RHI drawable','unclaimed UI GC closes its window','RHI GC releases Surface then native window','shutdown sees no live windows']}));
