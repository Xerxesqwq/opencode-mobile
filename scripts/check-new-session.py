#!/usr/bin/env python3
"""Android regression: /new and /clear create usable sessions without a crash."""
import argparse, json, os, re, subprocess, time, urllib.request
from pathlib import Path
import uiautomator2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--setup', action='store_true')
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
port = int(os.environ.get('NAVIGATION_PORT', '14101'))
base = 'http://127.0.0.1:' + str(port)
connection_name = 'New session regression'
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

def open_source():
    hide_keyboard()
    d.app_start('cc.agentlabs.opencode', stop=True)
    assert d(text='Sessions').wait(timeout=25)
    d(text='Sessions').click()
    for _ in range(20):
        if d(resourceId='session-item-navigation-a').exists: break
        d.swipe_ext('up', scale=.6); time.sleep(.3)
    assert d(resourceId='session-item-navigation-a').wait(timeout=5)
    click('session-item-navigation-a')
    assert d(resourceId='chat-content-navigation-a').wait(timeout=25)

def command(value):
    d(resourceId='chat-message-input').set_text('/' + value)
    assert d(text='/' + value).wait(timeout=10)
    d(text='/' + value).click()

baseline = control()
initial_creations = baseline['creations']
initial_requests = len(baseline['requests'])
open_source()
control('create', {'fail': True})
command('new')
assert d(text='OK').wait(timeout=15), 'Creation error was not shown'
d(text='OK').click()
assert d(resourceId='chat-content-navigation-a').wait(timeout=15)
assert control()['creations'] == initial_creations
save('create-failed-keeps-source')
control('create', {'delay': 1500})
control('long', {'id': 'navigation-a'})
open_source()
control('event', {'type': 'session.status', 'properties': {'sessionID': 'navigation-a', 'status': {'type': 'busy'}}})
command('new')
assert d(resourceId='chat-content-navigation-new-' + str(initial_creations + 1)).wait(timeout=25), 'New route missing or app crashed'
assert d.app_current()['package'] == 'cc.agentlabs.opencode'
save('new-from-busy-long-conversation')
for index, cmd in enumerate(['clear', 'new', 'clear'], 2):
    command(cmd)
    assert d(resourceId='chat-content-navigation-new-' + str(initial_creations + index)).wait(timeout=25)
    assert d.app_current()['package'] == 'cc.agentlabs.opencode'
    assert d(resourceId='chat-message-input').get_text() in ['', 'Message…', 'Message...', 'Type a message...']
save('clear-starts-fresh')
state = control()
creates = [r for r in state['requests'][initial_requests:] if r['method'] == 'POST' and r['route'] == '/session']
assert len(creates) == 5 and state['creations'] - initial_creations == 4
assert all(r['directory'] == '/navigation/A' for r in creates), 'New conversation changed project'
assert not state['writes'], 'Slash command was sent to the model'
open_source()
assert d(resourceId='chat-content-navigation-a').wait(timeout=15)
save('original-conversation-preserved')
report = {'status': 'success', 'checks': ['creation failure keeps original', 'new from busy long conversation', 'clear appears in suggestions', 'repeated new and clear', 'directory preserved', 'original history preserved'], 'creations': state['creations'] - initial_creations, 'inferenceRequests': 0}
(args.output_dir / 'android.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
