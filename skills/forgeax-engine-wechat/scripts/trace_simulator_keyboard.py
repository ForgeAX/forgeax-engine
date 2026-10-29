#!/usr/bin/env python3
"""Bounded native keyboard/focus diagnosis in one existing official simulator."""
import argparse
from pathlib import Path
from wechatide import invoke, load_config


def expression(action):
    owner = 'game.__forgeaxNativeKeyboardTrace'
    if action == 'install':
        source = Path(__file__).with_name('native_keyboard_trace.js').read_text().replace('export function ', 'function ', 1)
        body = source + f'''
        if ({owner}) throw new Error('Keyboard trace already exists; read or release it first');
        {owner} = observeNativeKeyboard(game.wx, function () {{
          const result = game.__forgeaxGameInspection.ui({{selector:'input'}});
          return result.ok ? result.value.focused : null;
        }});
        return {owner}.report;'''
    else:
        body = f'''if (!{owner}) throw new Error('No keyboard trace in this game realm');
        {'const trace = ' + owner + '; trace.release(); delete ' + owner + '; return trace.report;' if action == 'release' else 'return ' + owner + '.report;'}'''
    return 'function () { const game = GameGlobal.__gameContextWindow; ' + body + ' }'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--action', choices=['install', 'read', 'release'], required=True)
    args = parser.parse_args()
    _, status = invoke(load_config(args.config), ['automation_evaluate', '--project', args.project,
        '--fn-source', expression(args.action)], args.out, 45)
    raise SystemExit(status)
