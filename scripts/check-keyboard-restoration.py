#!/usr/bin/env python3
"""Check composer placement before, during and after real Android IME cycles.

Start the fixture server with --seed-sessions, connect the app to it, then run:
  python3 scripts/check-keyboard-restoration.py --output-dir verification
Requires adb and uiautomator2. The default IME must be Gboard.
"""
import argparse
import json
import re
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import uiautomator2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--serial', default='emulator-5554')
parser.add_argument('--package', default='cc.agentlabs.opencode')
parser.add_argument('--session', default='Default Project Session')
parser.add_argument('--ime-package', default='com.google.android.inputmethod.latin')
parser.add_argument('--cycles', type=int, default=5)
parser.add_argument('--multiline', action='store_true', help='Expand the draft to three lines on the second cycle')
parser.add_argument('--send', action='store_true', help='Also send a draft with the IME open')
args = parser.parse_args()
assert args.cycles > 0
args.output_dir.mkdir(parents=True, exist_ok=True)
device = uiautomator2.connect(args.serial)


def adb(*command):
    return subprocess.check_output(['adb', '-s', args.serial, *command], timeout=30)


def frames(window):
    return re.findall(r'type=ime frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]*? visible=true', window)


def snapshot(label):
    xml = device.dump_hierarchy()
    window = adb('shell', 'dumpsys', 'window').decode()
    (args.output_dir / f'{label}.xml').write_text(xml)
    (args.output_dir / f'{label}.windows.txt').write_text(window)
    device.screenshot(str(args.output_dir / f'{label}.png'))
    controls = {}
    for node in ET.fromstring(xml).iter('node'):
        identifier = node.get('resource-id', '').split('/')[-1]
        if identifier in ['chat-message-input', 'chat-send-button']:
            controls[identifier] = list(map(int, re.findall(r'\d+', node.get('bounds', ''))))
    assert 'chat-message-input' in controls, 'Open the seeded chat before checking layout'
    ime = frames(window)
    return {'label': label, 'controls': controls, 'keyboardTop': min(int(f[1]) for f in ime) if ime else None}


def wait_keyboard(visible):
    for _ in range(30):
        if bool(frames(adb('shell', 'dumpsys', 'window').decode())) == visible:
            time.sleep(0.5)
            return
        time.sleep(0.2)
    raise AssertionError(f'Keyboard visibility did not become {visible}')


def focus_input():
    # Tapping a red-underlined word opens the Android spellchecker popup,
    # which hides the app from accessibility. Use the field's blank edge.
    box = device(resourceId='chat-message-input').info['bounds']
    device.click(box['right'] - 12, (box['top'] + box['bottom']) // 2)


def check_open(state):
    top = state['keyboardTop']
    assert top is not None, 'Keyboard is not visible'
    for name in ['chat-message-input', 'chat-send-button']:
        box = state['controls'].get(name, [])
        assert len(box) == 4 and box[2] > box[0] and box[3] > box[1] and box[3] <= top, f'{name} overlaps keyboard: {box}'
    bottom = max(b[3] for b in state['controls'].values())
    state['gapBelowControlsDp'] = round((top - bottom) / density, 2)
    assert state['gapBelowControlsDp'] <= 64, f'Excess space above keyboard: {state}'


def check_closed(state):
    assert state['keyboardTop'] is None, 'Keyboard is still visible'
    box = state['controls']['chat-message-input']
    state['extraGapDp'] = round((baseline['controls']['chat-message-input'][3] - box[3]) / density, 2)
    assert abs(state['extraGapDp']) <= 2, f'Composer did not restore its initial position: {state}'


ime = adb('shell', 'settings', 'get', 'secure', 'default_input_method').decode().strip()
assert ime.startswith(args.ime_package + '/'), f'Expected {args.ime_package}, got {ime}'
density = int(re.findall(r'\d+', adb('shell', 'wm', 'density').decode())[-1]) / 160
# A fresh screen establishes the original position before any keyboard event.
# Comparing two already-broken post-hide layouts would miss the regression.
device.app_start(args.package, stop=True)
assert device(text=args.session).wait(timeout=15), f'Missing seeded session: {args.session}'
device(text=args.session).click()
assert device(resourceId='chat-message-input').wait(timeout=15)
wait_keyboard(False)
baseline = snapshot('initial')
results = {'ime': ime, 'density': density, 'baseline': baseline, 'cycles': [], 'passed': False}
try:
    for number in range(1, args.cycles + 1):
        focus_input()
        wait_keyboard(True)
        if number == 1:
            adb('shell', 'input', 'text', 'Keyboard-restoration-test')
        if number == 2 and args.multiline:
            # Set the multiline native field without relying on caret placement
            # or Gboard's autocorrection of injected hardware key events.
            device(resourceId='chat-message-input').set_text('Keyboard restoration test\nSecond line\nThird line')
        opened = snapshot(f'open-{number}')
        check_open(opened)
        device.press('back')
        wait_keyboard(False)
        closed = snapshot(f'closed-{number}')
        results['cycles'].append({'open': opened, 'closed': closed})
        check_closed(closed)
    if args.send:
        focus_input()
        wait_keyboard(True)
        results['sentDraft'] = device(resourceId='chat-message-input').get_text()
        assert results['sentDraft'].strip(), 'The test draft is empty'
        if args.multiline:
            assert results['sentDraft'].count('\n') >= 2, 'The test draft is not multiline'
        device(resourceId='chat-send-button').click()
        time.sleep(1)
        device.press('back')
        wait_keyboard(False)
        results['afterSend'] = snapshot('after-send')
        check_closed(results['afterSend'])
        assert device(textContains=results['sentDraft']).wait(timeout=10), 'Sent message missing from transcript'
    results['passed'] = True
finally:
    (args.output_dir / 'results.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))
