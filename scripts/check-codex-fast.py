#!/usr/bin/env python3
"""Deterministic Android CUA for a dedicated Luna Fast-mode fixture."""
import argparse, base64, json, os, re, sys, time, traceback, urllib.request
from pathlib import Path
import uiautomator2
sys.excepthook = lambda kind, value, trace: print('UI check failed: ' + kind.__name__ + (': ' + str(value) if kind is AssertionError else '') + ' at line ' + str(next((entry.lineno for entry in reversed(traceback.extract_tb(trace)) if entry.filename.endswith('check-codex-fast.py')), 0)), file=sys.stderr)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
fixture = json.loads(Path(os.environ['CODEX_FAST_REPORT']).read_text())
assert fixture['title'].startswith('Fast Luna check ')
base = os.environ['CODEX_GATEWAY_URL'].rstrip('/')
password = Path(os.environ['CODEX_GATEWAY_PASSWORD_FILE']).read_text().strip()
headers = {'Authorization': 'Basic ' + base64.b64encode((os.environ.get('CODEX_GATEWAY_USERNAME', 'opencode') + ':' + password).encode()).decode(), 'Content-Type': 'application/json'}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def api(route, body=None):
    req = urllib.request.Request(base + route, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    with opener.open(req, timeout=120) as response: return json.load(response)
def wait(predicate, message, seconds=45):
    end = time.time() + seconds
    while time.time() < end:
        if predicate(): return
        time.sleep(.5)
    raise AssertionError(message)
d = uiautomator2.connect()
def click(resource):
    print('Click:', resource, flush=True)
    assert d(resourceId=resource).wait(timeout=20), 'Missing control: ' + resource
    wait(lambda: d(resourceId=resource).info.get('enabled', False), 'Control stayed disabled: ' + resource, 30)
    d(resourceId=resource).click(); time.sleep(.5)
def fill(resource, text):
    assert d(resourceId=resource).wait(timeout=30), 'Missing input: ' + resource
    d(resourceId=resource).set_text(text)
def save(name):
    time.sleep(.8)
    d.screenshot(str(args.output_dir / (name + '.png')))
    (args.output_dir / (name + '.xml')).write_text(d.dump_hierarchy())
    print('PASS:', name, flush=True)
def close_keyboard():
    # Android can publish IME visibility after set_text has returned.
    time.sleep(.8)
    shown = lambda: bool(re.search(r'type=ime frame=[^\n]*visible=true', d.shell('dumpsys window').output))
    for _ in range(5):
        if shown():
            d.press('back')
            wait(lambda: not shown(), 'Keyboard did not close', 8)
            time.sleep(.5)
            return
        time.sleep(.2)

def current(): return api('/session/' + fixture['source'])['codex']
def open_fixture():
    d.app_start('cc.agentlabs.opencode', stop=True)
    assert d(text='Sessions').wait(timeout=25); d(text='Sessions').click()
    click('codex-manage-button'); fill('codex-library-search', fixture['title']); close_keyboard()
    assert d(text=fixture['title'], className='android.widget.TextView').wait(timeout=25)
    d(text=fixture['title'], className='android.widget.TextView').click()
    assert d(resourceId='chat-message-input').wait(timeout=20)

assert current()['model'] == 'gpt-6-luna', 'Use Luna for all inference checks'
original = current()
open_fixture()
click('codex-controls-button'); click('codex-tab-mode')
assert d(resourceId='codex-speed-value').get_text() == 'Standard'
click('codex-speed-fast')
wait(lambda: current()['serviceTier'] == fixture['fastTier'], 'Fast was not saved')
wait(lambda: d(resourceId='codex-speed-value').get_text() == 'Fast', 'Fast status missing')
save('fast-on')
click('codex-tab-status')
assert d(resourceId='codex-current-speed').get_text() == 'Fast'
click('codex-controls-close')
open_fixture()
click('codex-controls-button'); click('codex-tab-mode')
wait(lambda: d(resourceId='codex-speed-value').get_text() == 'Fast', 'Fast did not survive app restart')
click('codex-controls-close')
marker = 'ANDROID_FAST_OK_' + str(int(time.time()))
fill('chat-message-input', 'Reply exactly ' + marker + '. Do not use tools.')
click('chat-send-button')
wait(lambda: any(row['info']['role'] == 'assistant' and any(part.get('text') == marker for part in row['parts']) for row in api('/session/' + fixture['source'] + '/message')), 'Luna reply missing', 90)
close_keyboard()
for _ in range(6):
    if d(text=marker, className='android.widget.TextView').exists: break
    d.swipe(360, 800, 360, 320, .4); time.sleep(.5)
assert d(text=marker, className='android.widget.TextView').wait(timeout=10), 'Luna reply not visible'
assert current()['model'] == 'gpt-6-luna'
assert current()['serviceTier'] == fixture['fastTier']
before = len(api('/session/' + fixture['source'] + '/message'))
fill('chat-message-input', '/fast')
click('chat-send-button')
assert d(resourceId='codex-speed-standard').wait(timeout=15), '/fast did not open speed controls'
click('codex-speed-standard')
wait(lambda: current()['serviceTier'] in [None, 'default'], 'Standard was not saved')
wait(lambda: d(resourceId='codex-speed-value').get_text() == 'Standard', 'Standard status missing')
save('fast-off')
click('codex-controls-close')
open_fixture()
click('codex-controls-button')
wait(lambda: d(resourceId='codex-current-speed').get_text() == 'Standard', 'Standard did not survive restart')
assert len(api('/session/' + fixture['source'] + '/message')) == before, '/fast was sent as a prompt'
for key in ['model', 'effort', 'sandboxPolicy', 'approvalPolicy']:
    assert current()[key] == original[key], key + ' changed unexpectedly'
report = {'status': 'success', 'model': 'gpt-6-luna', 'checks': ['Fast on', 'status display', 'app restart persistence', 'Luna reply in Fast', '/fast opens controls without inference', 'Standard off', 'settings preserved']}
(args.output_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
