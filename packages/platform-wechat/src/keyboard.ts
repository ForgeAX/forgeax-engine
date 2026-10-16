import {
  type PlatformError,
  type PlatformRelease,
  platformError,
  releasePlatformResources,
} from '@forgeax/engine-platform';
import type { BlitzUiInput } from '@forgeax/engine-ui-blitz';

export interface WechatKeyboardEvent {
  readonly value: string;
}
/** Mini Game keyboards expose whole strings, without selection ranges or IME phases. */
export interface WechatKeyboardSource {
  showKeyboard(options: {
    readonly defaultValue: string;
    readonly maxLength: number;
    readonly multiple: boolean;
    readonly keyboardType: 'text' | 'number';
    readonly confirmHold: boolean;
    readonly confirmType: 'done';
    readonly fail: (cause: unknown) => void;
  }): void;
  hideKeyboard(options: { readonly fail: (cause: unknown) => void }): void;
  onKeyboardInput(listener: (event: WechatKeyboardEvent) => void): void;
  offKeyboardInput(listener: (event: WechatKeyboardEvent) => void): void;
  onKeyboardConfirm(listener: (event: WechatKeyboardEvent) => void): void;
  offKeyboardConfirm(listener: (event: WechatKeyboardEvent) => void): void;
  onKeyboardComplete(listener: (event: WechatKeyboardEvent) => void): void;
  offKeyboardComplete(listener: (event: WechatKeyboardEvent) => void): void;
}

export function attachWechatKeyboard(
  ui: BlitzUiInput,
  source: WechatKeyboardSource,
  reportError: (error: PlatformError) => void,
): PlatformRelease {
  for (const name of [
    'showKeyboard',
    'hideKeyboard',
    'onKeyboardInput',
    'offKeyboardInput',
    'onKeyboardConfirm',
    'offKeyboardConfirm',
    'onKeyboardComplete',
    'offKeyboardComplete',
  ] as const) {
    if (typeof source[name] !== 'function')
      throw platformError('platform-unavailable', { operation: `wx.${name}` }).error;
  }
  let disposed = false;
  let generation = 0;
  let releaseSession: PlatformRelease | undefined;
  const fail = (operation: string, cause: unknown) =>
    reportError(platformError('platform-operation-failed', { operation, cause }).error);
  const close = (hide: boolean) => {
    generation++;
    const release = releaseSession;
    releaseSession = undefined;
    if (!release) return;
    releasePlatformResources([
      release,
      () => {
        if (!hide) return;
        try {
          source.hideKeyboard({ fail: (cause) => fail('wx.hideKeyboard', cause) });
        } catch (cause) {
          fail('wx.hideKeyboard', cause);
        }
      },
    ]);
  };
  const synchronize = () => {
    if (disposed) return;
    close(true);
    const editor = ui.focusedText();
    if (!editor) return;
    const current = ++generation;
    const valid = () => !disposed && current === generation;
    let accepted = editor.value;
    const update = (event: WechatKeyboardEvent) => {
      if (!valid()) return;
      if (typeof event.value !== 'string') {
        fail('wx.keyboard', new TypeError('Keyboard value must be a string'));
        return;
      }
      if (event.value !== accepted) {
        accepted = event.value;
        ui.text(event.value);
      }
    };
    const input = (event: WechatKeyboardEvent) => update(event);
    const confirm = (event: WechatKeyboardEvent) => {
      update(event);
      if (valid()) ui.confirm();
    };
    const complete = (event: WechatKeyboardEvent) => {
      update(event);
      if (!valid()) return;
      // Closing the native editor does not blur a mobile document. In particular,
      // Done may have just focused an invalid field and displayed its explanation.
      close(false);
      ui.commitText();
    };
    const releases: PlatformRelease[] = [];
    releaseSession = () => releasePlatformResources(releases.reverse());
    try {
      releases.push(() => source.offKeyboardInput(input));
      source.onKeyboardInput(input);
      releases.push(() => source.offKeyboardConfirm(confirm));
      source.onKeyboardConfirm(confirm);
      releases.push(() => source.offKeyboardComplete(complete));
      source.onKeyboardComplete(complete);
      source.showKeyboard({
        defaultValue: editor.value,
        // Mini Game has no HTML -1 sentinel; use a finite signed-32-bit maximum.
        maxLength: editor.maxLength < 0 ? 2_147_483_647 : editor.maxLength,
        multiple: editor.multiline,
        // WeChat's Android number editor filters decimal points and signs even
        // when the IME displays those keys. HTML number keeps its text vocabulary.
        keyboardType: 'text',
        confirmHold: false,
        confirmType: 'done',
        fail: (cause) => {
          if (valid()) {
            close(false);
            fail('wx.showKeyboard', cause);
          }
        },
      });
    } catch (cause) {
      close(false);
      fail('wx.showKeyboard', cause);
    }
  };
  const unsubscribe = ui.subscribeFocus(() => close(true));
  let unsubscribeEdit: PlatformRelease | undefined;
  try {
    unsubscribeEdit = ui.subscribeTextEdit(synchronize);
  } catch (cause) {
    disposed = true;
    unsubscribe();
    unsubscribeEdit?.();
    close(false);
    throw cause;
  }
  return () => {
    if (disposed) return;
    disposed = true;
    releasePlatformResources([unsubscribe, () => unsubscribeEdit?.(), () => close(true)]);
  };
}
