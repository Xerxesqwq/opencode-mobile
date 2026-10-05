#!/usr/bin/env python3
"""Deterministic Android CUA for a dedicated fork-live-check fixture."""
import argparse, base64, json, os, re, sys, time, traceback, urllib.request
from pathlib import Path
import uiautomator2
sys.excepthook = lambda kind, value, trace: print('UI check failed: ' + kind.__name__ + (': ' + str(value) if kind is AssertionError else '') + ' at line ' + str(next((entry.lineno for entry in reversed(traceback.extract_tb(trace)) if entry.filename.endswith('check-codex-fork.py')), 0)), file=sys.stderr)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
fixture = json.loads(Path(os.environ['CODEX_WORKBENCH_REPORT']).read_text())
assert fixture['title'].startswith('Fork check ')
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

def search(text):
    click('codex-search-button'); d(resourceId='codex-search-input').set_text(text)
    click('codex-search-kind-user')
    wait(lambda: d(resourceId='codex-search-count').get_text().startswith('1 '), 'Expected exact search result')
    result = api('/session/' + fixture['source'] + '/codex/search?q=' + text + '&kind=user')['results'][0]
    click('codex-search-result-' + result['messageId'])
    assert d(resourceId='codex-search-target').wait(timeout=15), 'Search did not locate message'
    return result

def history(identifier):
    return [(row['info']['id'], row['info']['role'], [part.get('text') for part in row['parts'] if part['type'] == 'text']) for row in api('/session/' + identifier + '/message')]

def branch_ids():
    return {row['id'] for row in api('/codex/library') if row['title'].startswith('Fork · ' + fixture['title'])}

def create_fork():
    previous = branch_ids()
    assert d(textMatches='(?i)Create fork').wait(timeout=15), 'Fork confirmation missing'
    d(textMatches='(?i)Create fork').click()
    wait(lambda: bool(branch_ids() - previous), 'New branch not listed', 45)
    identifier = (branch_ids() - previous).pop()
    assert d(textStartsWith='Fork · ' + fixture['title'], className='android.widget.TextView').wait(timeout=30), 'New branch did not open'
    assert d(resourceId='chat-message-input').wait(timeout=20)
    return identifier

original = history(fixture['source'])
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text='Sessions').wait(timeout=25); d(text='Sessions').click()
click('codex-manage-button'); fill('codex-library-search', fixture['title']); close_keyboard()
if not d(text=fixture['title'], className='android.widget.TextView').exists:
    d(scrollable=True).scroll.to(text=fixture['title'], className='android.widget.TextView')
d(text=fixture['title'], className='android.widget.TextView').click()
assert d(resourceId='chat-message-input').wait(timeout=20)
fill('chat-message-input', 'UNSENT_SOURCE_DRAFT'); close_keyboard()
click('codex-controls-button'); click('codex-fork-current')
full = create_fork()
assert history(full) == original, 'Full fork history differs'
assert 'UNSENT_SOURCE_DRAFT' not in d(resourceId='chat-message-input').get_text(), 'Source draft leaked into fork'
save('full-fork')
d.press('back'); time.sleep(1)
assert d(resourceId='chat-message-input').get_text() == 'UNSENT_SOURCE_DRAFT', 'Original unsent draft was lost'
fill('chat-message-input', ''); close_keyboard()
result = search('FORK_SECOND')
click('codex-fork-' + result['messageId'])
partial = create_fork()
assert d(resourceId='chat-message-input').get_text() == 'Reply exactly FORK_SECOND. Do not use tools.', 'Fork draft missing'
assert api('/session/' + partial + '/codex/search?q=FORK_SECOND&kind=user')['total'] == 0
assert history(fixture['source']) == original, 'Source history changed during fork'
save('prompt-fork-draft')
fill('chat-message-input', 'Reply exactly ANDROID_FORK_ONLY. Do not use tools.'); click('chat-send-button')
wait(lambda: any(row['info']['role'] == 'assistant' and any(part.get('text') == 'ANDROID_FORK_ONLY' for part in row['parts']) for row in api('/session/' + partial + '/message')), 'Branch reply missing', 90)
assert history(fixture['source']) == original, 'Branch reply changed source'
wait(lambda: api('/session/' + partial)['codex']['runtimeStatus'] == 'idle', 'Branch task did not finish', 30)
close_keyboard()
for _ in range(5):
    if d(text='ANDROID_FORK_ONLY').exists: break
    d.swipe(360, 800, 360, 320, .4); time.sleep(.5)
assert d(text='ANDROID_FORK_ONLY').exists, 'Branch reply not shown in Android'
save('branch-reply')
report = {'status': 'success', 'source': fixture['source'], 'full': full, 'partial': partial, 'checks': ['full fork opens', 'original draft preserved', 'fork before prompt', 'draft restored in new branch', 'branch reply shown', 'source history unchanged']}
(args.output_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
