import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

interface PadState {
  connected: boolean;
  buttons: { value: number; pressed: boolean }[];
  axes: number[];
}

export default defineFeature({
  title: 'Gamepad scan (injected navigator)',
  catalog: 'Gamepad input',
  kind: 'probe',
  summary:
    'attachBrowserInputBackend polls navigator.getGamepads() once per sample; an injected standard-mapping stub proves connectivity, button/value edges, raw axes and action deadzones.',
  expect:
    'All checks pass: slot 0 connects, button edges last one frame, analog value and raw axes pass through, an action deadzone filters small stick values, disconnect clears the slot.',
  setup({ world }) {
    spawnStage(world);
    return {
      checks() {
        const c = new CheckList();
        const pad: PadState = {
          connected: true,
          buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
          axes: [0, 0, 0, 0],
        };
        const raw = () => ({
          index: 0,
          id: 'fl-standard-pad',
          mapping: 'standard',
          timestamp: 0,
          ...pad,
        });
        const b = privateBackend({
          navigator: { getGamepads: () => [raw() as unknown as Gamepad] },
        });
        const map = [
          { action: 'jump', bindings: [{ type: 'gamepadButton' as const, button: 0 as const }] },
          {
            action: 'right',
            bindings: [{ type: 'gamepadAxis' as const, axis: 0 as const, sign: 1 as const }],
            deadzone: 0.25,
          },
        ];
        let s = b.step(map);
        c.ok('capabilities.gamepad true with getGamepads', s.capabilities.gamepad);
        c.ok('slot 0 connected', s.gamepad(0).connected && s.gamepad(0).standardMapping);
        c.ok('slot 1 disconnected', !s.gamepad(1).connected);
        pad.buttons[0] = { value: 1, pressed: true };
        pad.buttons[7] = { value: 0.6, pressed: true };
        s = b.step(map);
        c.ok('button(0) down + justPressed', s.gamepad(0).button(0) && s.gamepad(0).justPressed(0));
        c.near('analog buttonValue(7)', s.gamepad(0).buttonValue(7), 0.6);
        c.ok(
          'action jump pressed via gamepadButton',
          s.action('jump').isPressed() && s.action('jump').justPressed(),
        );
        s = b.step(map);
        c.ok('held button: no second edge', s.gamepad(0).button(0) && !s.gamepad(0).justPressed(0));
        pad.buttons[0] = { value: 0, pressed: false };
        s = b.step(map);
        c.ok('justReleased(0)', s.gamepad(0).justReleased(0) && s.action('jump').justReleased());
        pad.axes = [0.2, -0.5, 0, 0];
        s = b.step(map);
        c.near('raw axis(0) unfiltered', s.gamepad(0).axis(0), 0.2);
        c.near('raw axis(1)', s.gamepad(0).axis(1), -0.5);
        c.equal('deadzone filters 0.2 < 0.25', s.action('right').strength, 0);
        pad.axes = [1, 0, 0, 0];
        s = b.step(map);
        c.near('full deflection strength 1', s.action('right').strength, 1);
        pad.connected = false;
        s = b.step(map);
        c.ok('disconnect clears slot 0', !s.gamepad(0).connected);
        b.dispose();
        const none = privateBackend({ navigator: {} });
        c.ok('no getGamepads -> capabilities.gamepad false', !none.step().capabilities.gamepad);
        none.dispose();
        return c.items;
      },
    };
  },
});
