#!/usr/bin/env python3
"""Verify Codex controls in an installed Android release against a dedicated live thread.

Requires a saved, active Codex connection; CODEX_CONTROLS_SESSION identifies a
seeded test thread. Credentials come from CODEX_GATEWAY_PASSWORD_FILE.
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path
import uiautomator2

sys.excepthook = lambda kind, value, trace: print('UI check failed: ' + kind.__name__ + (': ' + str(value) if kind is AssertionError else ''), file=sys.stderr)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
base = os.environ['CODEX_GATEWAY_URL'].rstrip('/')
identifier = os.environ['CODEX_CONTROLS_SESSION']
password = Path(os.environ['CODEX_GATEWAY_PASSWORD_FILE']).read_text().strip()
username = os.environ.get('CODEX_GATEWAY_USERNAME', 'opencode')
headers = {'Authorization': 'Basic ' + base64.b64encode((username + ':' + password).encode()).decode(), 'Content-Type': 'application/json'}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(route):
    with opener.open(urllib.request.Request(base + route, headers=headers), timeout=30) as response:
        return json.load(response)


def session():
    return api('/session/' + identifier)


def wait_setting(key, value):
    for _ in range(40):
        if session()['codex'][key] == value:
            time.sleep(0.5)
            return
        time.sleep(0.25)
    raise AssertionError('Setting did not reach Codex: ' + key)


def click(resource):
    assert d(resourceId=resource).wait(timeout=15), 'Missing control: ' + resource
    for _ in range(80):
        if d(resourceId=resource).info.get('enabled', False):
            break
        time.sleep(0.25)
    assert d(resourceId=resource).info.get('enabled', False), 'Control stayed disabled: ' + resource
    print('Click:', resource, flush=True)
    d(resourceId=resource).click()
    time.sleep(0.5)


def reveal(resource):
    for _ in range(7):
        if d(resourceId=resource).exists:
            return
        d.swipe(360, 1330, 360, 550, 0.4)
        time.sleep(0.3)
    raise AssertionError('Control not found by scrolling: ' + resource)


current = session()
assert current['title'].startswith('Codex controls test '), 'Use a dedicated controls test thread'
d = uiautomator2.connect()
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text='Sessions').wait(timeout=25)
d(text='Sessions').click()
assert d(text=current['title']).wait(timeout=25), 'Seeded test thread missing'
d(text=current['title']).click()
click('codex-controls-button')
assert d(resourceId='codex-context-value').wait(timeout=20)
context = d(resourceId='codex-context-value').get_text()
assert 'tokens' in context, 'Context usage is missing'
d.screenshot(str(args.output_dir / 'context.png'))

click('codex-tab-effort')
for level in ['low', 'medium', 'high', 'xhigh']:
    assert d(resourceId='codex-effort-' + level).exists, 'Missing effort level: ' + level
click('codex-effort-high')
wait_setting('effort', 'high')
d.screenshot(str(args.output_dir / 'effort.png'))
reveal('codex-effort-max')
click('codex-effort-max')
wait_setting('effort', 'max')
click('codex-tab-permissions')
click('codex-permission-read-only')
wait_setting('permissionProfile', ':read-only')
assert session()['codex']['sandboxPolicy']['type'] == 'readOnly'
d.screenshot(str(args.output_dir / 'permissions.png'))
click('codex-permission-workspace')
wait_setting('permissionProfile', ':workspace')
reveal('codex-approval-untrusted')
click('codex-approval-untrusted')
wait_setting('approvalPolicy', 'untrusted')
click('codex-approval-on-request')
wait_setting('approvalPolicy', 'on-request')

click('codex-tab-mode')
click('codex-mode-plan')
wait_setting('mode', 'plan')
d.screenshot(str(args.output_dir / 'mode.png'))
click('codex-mode-default')
wait_setting('mode', 'default')
click('codex-controls-close')

# Model selection persists on the native session and the next prompt inherits it.
original_model = session()['codex']['model']
models = api('/codex/options')['models']
target = next(model['id'] for model in models if model['id'] != original_model and 'luna' in model['id'] and any(e['reasoningEffort'] == 'max' for e in model['efforts']))
click('model-chip')
reveal('model-option-codex-' + target)
click('model-option-codex-' + target)
wait_setting('model', target)
assert session()['codex']['effort'] == 'max'
click('codex-effort-chip')
click('codex-effort-low')
wait_setting('effort', 'low')
click('codex-controls-close')
prompt_start = len(api('/session/' + identifier + '/message'))
d(resourceId='chat-message-input').set_text('Reply exactly ANDROID_SETTINGS_OK. Do not use tools.')
click('chat-send-button')
for _ in range(90):
    rows = api('/session/' + identifier + '/message')
    if any(row['info']['role'] == 'assistant' and any(part.get('text') == 'ANDROID_SETTINGS_OK' for part in row['parts']) for row in rows[prompt_start:]) and session()['codex']['runtimeStatus'] == 'idle':
        break
    time.sleep(1)
else:
    raise AssertionError('Reply missing after changing settings')
assert session()['codex']['model'] == target
assert session()['codex']['effort'] == 'low'

# Sending a builtin command opens its control panel and preserves history.
before = len(api('/session/' + identifier + '/message'))
d(resourceId='chat-message-input').set_text('/permissions')
click('chat-send-button')
assert d(resourceId='codex-permission-workspace').wait(timeout=15)
assert len(api('/session/' + identifier + '/message')) == before, 'Builtin was sent to the model'
click('codex-tab-effort')
click('codex-effort-low')
wait_setting('effort', 'low')
click('codex-tab-status')
reveal('codex-compact')
click('codex-compact')
for _ in range(120):
    rows = api('/session/' + identifier + '/message')
    if len(rows) > before and any(part.get('text') == 'Context compacted.' for row in rows[before:] for part in row['parts']):
        break
    time.sleep(1)
else:
    raise AssertionError('Native compact did not complete from Android')
assert session()['codex']['compacting'] is False
assert session()['codex']['runtimeStatus'] == 'idle'
for _ in range(30):
    if not d(text='Compacting…').exists and d(resourceId='codex-compact').info['enabled']:
        break
    time.sleep(0.5)
else:
    raise AssertionError('UI remained compacting after native completion')
d.screenshot(str(args.output_dir / 'compacted.png'))
click('codex-controls-close')
# Reopen the app and verify settings/context survive a new HTTP/SSE connection.
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text=current['title']).wait(timeout=25)
d(text=current['title']).click()
click('codex-controls-button')
assert d(resourceId='codex-context-value').wait(timeout=20)
assert 'tokens' in d(resourceId='codex-context-value').get_text()
assert d(resourceId='codex-current-effort').get_text() == 'low'
(args.output_dir / 'hierarchy.xml').write_text(d.dump_hierarchy())
result = {'status': 'success', 'sessionId': identifier, 'checks': ['context', 'effort_high_max_low', 'permissions_read_only_workspace', 'approval_untrusted_on_request', 'plan_default', 'model_persistence', 'prompt_inherits_settings', 'slash_command', 'native_compact', 'app_reconnect']}
(args.output_dir / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
