#!/usr/bin/env python3
"""Android regression: delayed and failed requests must stay in their own session."""
import argparse, json, os, re, subprocess, time, urllib.request
from pathlib import Path
import uiautomator2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--expect-bug', action='store_true')
parser.add_argument('--setup', action='store_true')
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
port = int(os.environ.get('NAVIGATION_PORT', '14101'))
base = 'http://127.0.0.1:' + str(port)
connection_name = 'Navigation regression'
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def control(operation='state', body=None):
    request = urllib.request.Request(base + '/__control/' + operation, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
    with opener.open(request, timeout=10) as response: return json.load(response)
def wait(predicate, message, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        if predicate(): return
        time.sleep(.3)
    raise AssertionError(message)
def save(name):
    time.sleep(.7)
    d.screenshot(str(args.output_dir / (name + '.png')))
    (args.output_dir / (name + '.xml')).write_text(d.dump_hierarchy())
    print('CHECK:', name, flush=True)
def hide_keyboard():
    time.sleep(.6)
    if re.search(r'type=ime frame=[^\n]*visible=true', d.shell('dumpsys window').output):
        d.press('back'); time.sleep(.6)
def click(identifier):
    assert d(resourceId=identifier).wait(timeout=25), 'Missing ' + identifier
    d(resourceId=identifier).click(); time.sleep(.4)
def fill(identifier, value):
    hide_keyboard()
    for _ in range(8):
        if d(resourceId=identifier).exists:
            d(resourceId=identifier).set_text(value); hide_keyboard(); return
        d.swipe_ext('up', scale=.5); time.sleep(.4)
    raise AssertionError('Missing field ' + identifier)
def sessions():
    hide_keyboard()
    for _ in range(5):
        if d(text='Sessions').exists:
            d(text='Sessions').click(); break
        d.press('back'); time.sleep(.4)
    assert d(resourceId='session-item-navigation-a').wait(timeout=25), 'Session A missing from list'
def open_session(identifier):
    click('session-item-' + identifier)
    marker = 'NAV_A_ONLY' if identifier == 'navigation-a' else 'NAV_B_ONLY'
    assert d(text=marker).wait(timeout=25), 'Wrong conversation: expected ' + marker
    assert not d(text='NAV_B_ONLY' if identifier == 'navigation-a' else 'NAV_A_ONLY').exists, 'Both conversations are shown'
    if not args.expect_bug:
        assert d(resourceId='chat-content-' + identifier).exists, 'Route content identity mismatch'
def assert_a():
    assert d(text='NAV_A_ONLY').wait(timeout=20)
    assert not d(text='NAV_B_ONLY').exists, 'B replaced A'
    assert d(resourceId='chat-content-navigation-a').exists

d = uiautomator2.connect()
subprocess.run(['adb', 'reverse', 'tcp:' + str(port), 'tcp:' + str(port)], check=True, stdout=subprocess.DEVNULL)
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text='Connections').wait(timeout=30)
if args.setup:
    subprocess.run(['adb', 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'opencode://connection/add', 'cc.agentlabs.opencode'], check=True, stdout=subprocess.DEVNULL)
    click('backend-codex')
    fill('connection-name-input', connection_name)
    fill('connection-url-input', base)
    for _ in range(8):
        if d(resourceId='connection-save-button').exists: break
        d.swipe_ext('up', scale=.5); time.sleep(.4)
    click('connection-save-button')
    assert d(text='Connections').wait(timeout=25)
    d(text='Connections').click()
d(text='Connections').click()
for _ in range(12):
    if d(text=connection_name).exists: break
    d.swipe_ext('up', scale=.6); time.sleep(.4)
assert d(text=connection_name).exists, 'Fixture connection missing'
d(text=connection_name).click()
sessions(); open_session('navigation-b')
control('hold', {'id': 'navigation-a'})
sessions(); click('session-item-navigation-a')
wait(lambda: control()['pending'].get('navigation-a', 0) > 0, 'A request was not held')
if not args.expect_bug:
    assert d(resourceId='chat-loading-session').exists
    assert not d(text='NAV_B_ONLY').exists
    assert not d(resourceId='chat-content-navigation-b').exists
    assert not d(resourceId='chat-message-input').info.get('enabled', True), 'Composer stayed enabled during load'
    save('loading-a')
control('release', {'id': 'navigation-a', 'status': 503})
if args.expect_bug:
    assert d(text='NAV_B_ONLY').wait(timeout=15), 'Expected stale B was not reproduced'
    save('before-failed-a-shows-b')
    (args.output_dir / 'result.json').write_text(json.dumps({'bugReproduced': True, 'scenario': 'B remains after clicking A and its history request fails', 'inferenceRequests': 0}, indent=2) + '\n')
    print('Reproduced: clicked A, failed load leaves B', flush=True)
    raise SystemExit(0)
assert d(resourceId='chat-session-error').wait(timeout=15)
assert not d(text='NAV_B_ONLY').exists
save('failed-a')
click('chat-retry-session'); assert_a(); save('retry-a')

# Start a background B refresh, then navigate to A before B resolves.
sessions(); open_session('navigation-b')
control('hold', {'id': 'navigation-b'})
control('event', {'type': 'session.status', 'properties': {'sessionID': 'navigation-b', 'status': {'type': 'idle'}}, 'close': True})
wait(lambda: control()['pending'].get('navigation-b', 0) > 0, 'B background refresh was not held')
sessions(); open_session('navigation-a')
control('release', {'id': 'navigation-b'})
time.sleep(2); assert_a(); save('late-b-refresh')

# Repeated list navigation must keep title, body and requested directory together.
for identifier in ['navigation-b', 'navigation-a', 'navigation-b', 'navigation-a']:
    sessions(); open_session(identifier)
assert_a()

# Fork uses a second kept-alive chat screen. Back must restore A and its draft.
fill('chat-message-input', 'NAV_DRAFT_A')
click('codex-controls-button'); click('codex-fork-current')
assert d(textMatches='(?i)Create fork').wait(timeout=15)
d(textMatches='(?i)Create fork').click()
assert d(resourceId='chat-content-navigation-b').wait(timeout=25)
assert d(text='NAV_B_ONLY').exists
assert d(resourceId='chat-message-input').get_text() != 'NAV_DRAFT_A', 'A draft leaked into B'
d.press('back'); assert_a()
assert d(resourceId='chat-message-input').get_text() == 'NAV_DRAFT_A', 'A draft was lost on return'
save('back-to-a-draft')

# Canned fixture submission verifies the destination without calling a model.
fill('chat-message-input', 'NAV_SEND_A')
click('chat-send-button')
wait(lambda: len(control()['writes']) == 1, 'Fixture prompt was not submitted')
state = control()
assert state['writes'][0]['id'] == 'navigation-a', 'Prompt went to another session'
assert state['writes'][0]['body']['parts'][0]['text'] == 'NAV_SEND_A'
assert all(row['directory'] == ('/navigation/A' if '/navigation-a' in row['route'] else '/navigation/B') for row in state['requests'] if re.match(r'/session/navigation-[ab](?:/|$)', row['route'])), 'Wrong project directory'
save('send-a')
report = {'status': 'success', 'inferenceRequests': 0, 'checks': ['A loading hides B and disables composer', 'A failure exposes retry', 'retry loads A', 'late B refresh cannot replace A', 'repeated A/B list selection', 'back navigation restores A and its unsent draft', 'prompt stays in A', 'request directory matches session']}
(args.output_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
