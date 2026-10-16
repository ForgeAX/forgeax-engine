import { CheckList, defineFeature } from '../../lab/feature';
import { spawnStage } from '../../lab/stage';
import { privateBackend } from './support/private-backend';

export default defineFeature({
  title: 'Keyboard held / pressed / released edges',
  catalog: 'Keyboard input',
  kind: 'probe',
  summary:
    'Synthetic KeyboardEvents on a private window feed attachBrowserInputBackend; each sample() becomes one InputSnapshot with logical-key and physical-code readers.',
  expect:
    'All checks pass: press edge lasts one frame, hold persists, release edge appears once, key vs code are distinct, blur resets everything.',
  setup({ world }) {
    spawnStage(world);
    return {
      checks() {
        const c = new CheckList();
        const b = privateBackend();
        c.ok('idle frame: nothing down', !b.step().keyboard.down('a'));
        b.key('keydown', 'a', 'KeyA');
        let s = b.step();
        c.ok('down(a)', s.keyboard.down('a'));
        c.ok('justPressed(a) on press frame', s.keyboard.justPressed('a'));
        c.ok('downCode(KeyA)', s.keyboard.downCode('KeyA'));
        c.ok('justPressedCode(KeyA)', s.keyboard.justPressedCode('KeyA'));
        b.key('keydown', 'a', 'KeyA');
        s = b.step();
        c.ok('held: down(a) persists', s.keyboard.down('a'));
        c.ok('held + auto-repeat: no second justPressed', !s.keyboard.justPressed('a'));
        b.key('keyup', 'a', 'KeyA');
        s = b.step();
        c.ok('released: not down', !s.keyboard.down('a'));
        c.ok('up(a) edge', s.keyboard.up('a'));
        c.ok('upCode(KeyA) edge', s.keyboard.upCode('KeyA'));
        c.ok('up edge lasts one frame', !b.step().keyboard.up('a'));
        b.key('keydown', 'Z', 'KeyZ');
        s = b.step();
        c.ok('logical key keeps case (Z)', s.keyboard.down('Z') && !s.keyboard.down('z'));
        c.ok('physical code independent of layout', s.keyboard.downCode('KeyZ'));
        b.win.dispatchEvent(new Event('blur'));
        s = b.step();
        c.ok('blur releases held keys', !s.keyboard.down('Z') && !s.keyboard.downCode('KeyZ'));
        b.key('keydown', 'q', 'KeyQ');
        b.step();
        b.focused = false;
        b.key('keyup', 'q', 'KeyQ');
        s = b.step();
        c.ok(
          'unfocused keyup: released without up edge',
          !s.keyboard.down('q') && !s.keyboard.up('q'),
        );
        b.focused = true;
        c.ok(
          'snapshot readers are frozen objects',
          Object.isFrozen(s.keyboard) || Object.isFrozen(s),
        );
        b.dispose();
        return c.items;
      },
    };
  },
});
