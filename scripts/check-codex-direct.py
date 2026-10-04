#!/usr/bin/env python3
"""Live Android check. Requires a Codex gateway and an installed release APK.

CODEX_GATEWAY_URL=https://host:port CODEX_GATEWAY_PASSWORD_FILE=/private/password
python scripts/check-codex-direct.py --output-dir /path/to/evidence

Creates a dedicated test session through the gateway, connects using the UI,
opens its seeded history, sends a second prompt, then creates a session in UI.
Credentials are read from a file and never logged.
"""
import argparse
import base64
import json
import os
import subprocess
import time
import sys
import re
import urllib.request
from pathlib import Path
import uiautomator2

# UIAutomator errors can embed setText arguments. Never log their payload.
sys.excepthook = lambda kind, value, trace: print('UI check failed: ' + kind.__name__ + (': ' + str(value) if kind is AssertionError else ''), file=sys.stderr)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
base = os.environ['CODEX_GATEWAY_URL'].rstrip('/')
password = Path(os.environ['CODEX_GATEWAY_PASSWORD_FILE']).read_text().strip()
username = os.environ.get('CODEX_GATEWAY_USERNAME', 'opencode')
headers = {'Authorization': 'Basic ' + base64.b64encode((username + ':' + password).encode()).decode(), 'Content-Type': 'application/json'}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(route, body=None):
    request = urllib.request.Request(base + route, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    with opener.open(request, timeout=30) as response:
        return json.load(response)


def wait_reply(identifier, text):
    for _ in range(60):
        rows = api('/session/' + identifier + '/message')
        if any(row['info']['role'] == 'assistant' and text in part.get('text', '') for row in rows for part in row['parts']):
            return rows
        time.sleep(2)
    raise AssertionError('Missing assistant response: ' + text)


title = 'Codex Android ' + str(int(time.time()))
seed = api('/session', {'title': title})
api('/session/' + seed['id'] + '/prompt_async', {'parts': [{'type': 'text', 'text': 'Reply exactly ANDROID_HISTORY_OK. Do not use tools or change files.'}]})
wait_reply(seed['id'], 'ANDROID_HISTORY_OK')
d = uiautomator2.connect()
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text='Connections').wait(timeout=25), 'App startup did not complete'
subprocess.run(['adb', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'opencode://connection/add', 'cc.agentlabs.opencode'], check=True, stdout=subprocess.DEVNULL)
assert d(resourceId='backend-codex').wait(timeout=20)
d(resourceId='backend-codex').click()
assert d(resourceId='connection-name-input').wait(timeout=10)
d.screenshot(str(args.output_dir / 'codex-connection.png'))


def hide_keyboard():
    time.sleep(0.3)
    window = subprocess.check_output(['adb', 'shell', 'dumpsys', 'window'], text=True)
    if re.search(r'type=ime frame=[^\n]*visible=true', window):
        d.press('back')
        for _ in range(15):
            window = subprocess.check_output(['adb', 'shell', 'dumpsys', 'window'], text=True)
            if not re.search(r'type=ime frame=[^\n]*visible=true', window):
                break
            time.sleep(0.2)
    time.sleep(0.4)


def fill(identifier, value):
    hide_keyboard()
    item = d(resourceId=identifier)
    for _ in range(6):
        if item.exists:
            print('Fill:', identifier, flush=True)
            item.click()
            for _ in range(25):
                time.sleep(0.2)
                window = subprocess.check_output(['adb', 'shell', 'dumpsys', 'window'], text=True)
                frames = re.findall(r'type=ime frame=\[\d+,(\d+)\][^\n]*visible=true', window)
                if frames and item.exists and item.info['bounds']['bottom'] <= min(map(int, frames)):
                    break
            assert frames and item.exists and item.info['bounds']['bottom'] <= min(map(int, frames)), 'Focused field covered by keyboard: ' + identifier
            item.set_text(value)
            hide_keyboard()
            return
        d.swipe_ext('up', scale=0.55)
        time.sleep(0.5)
    raise AssertionError('Field missing: ' + identifier)


connection_name = 'Codex Direct ' + str(int(time.time()))
fill('connection-name-input', connection_name)
fill('connection-url-input', base)
fill('connection-username-input', username)
fill('connection-password-input', password)
for _ in range(6):
    if d(resourceId='connection-save-button').exists:
        break
    d.swipe_ext('up', scale=0.55)
d(resourceId='connection-save-button').click()
assert d(text='Connections').wait(timeout=25), 'Connection did not save'
d(text='Connections').click()
assert d(text=connection_name).wait(timeout=15), 'Saved connection missing'
d(text=connection_name).click()
d(text='Sessions').click()
assert d(text=title).wait(timeout=25), 'The seeded existing session is absent'
d(text=title).click()
assert d(text='ANDROID_HISTORY_OK').wait(timeout=20), 'Existing history missing in Android'
d.screenshot(str(args.output_dir / 'existing-history.png'))
d(resourceId='chat-message-input').set_text('Reply exactly ANDROID_CONTINUE_OK. Do not use tools or change files.')
d(resourceId='chat-send-button').click()
wait_reply(seed['id'], 'ANDROID_CONTINUE_OK')
hide_keyboard()
# The inverted list preserves its position while new messages arrive. Reveal
# the latest reply without navigating away or reloading server history.
for _ in range(6):
    if d(text='ANDROID_CONTINUE_OK').exists:
        break
    d.swipe(360, 800, 360, 320, 0.4)
    time.sleep(0.5)
assert d(text='ANDROID_CONTINUE_OK').wait(timeout=10), 'Streamed response missing in Android'
d.screenshot(str(args.output_dir / 'continued-session.png'))
# Return to list and create another session through the app.
if d(resourceId='chat-message-input').exists:
    d.press('back')
assert d(resourceId='new-session-fab').wait(timeout=15)
before = {row['id'] for row in api('/experimental/session')}
d(resourceId='new-session-fab').click()
assert d(resourceId='chat-message-input').wait(timeout=20), 'New-session composer missing'
after = {row['id'] for row in api('/experimental/session')}
assert len(after - before) == 1, 'UI did not create a new server session'
d.screenshot(str(args.output_dir / 'new-session.png'))
result = {'status': 'success', 'existing_history': True, 'continued_response': True, 'new_session': True, 'testThreadIds': [seed['id'], *sorted(after - before)]}
(args.output_dir / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
