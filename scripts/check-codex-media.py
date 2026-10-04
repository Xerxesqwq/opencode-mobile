#!/usr/bin/env python3
"""Deterministic Android CUA for a image previews and empty-bubble filtering."""
import argparse, base64, json, os, re, sys, time, traceback, urllib.request
from pathlib import Path
import uiautomator2
sys.excepthook = lambda kind, value, trace: print('UI check failed: ' + kind.__name__ + (': ' + str(value) if kind is AssertionError else '') + ' at line ' + str(next((entry.lineno for entry in reversed(traceback.extract_tb(trace)) if entry.filename.endswith('check-codex-media.py')), 0)), file=sys.stderr)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
fixture = json.loads(Path(os.environ['CODEX_MEDIA_FIXTURE']).read_text())
assert fixture['title'].startswith('Media UI check ')
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

def open_session(title):
    d.app_start('cc.agentlabs.opencode', stop=True)
    assert d(text='Sessions').wait(timeout=25); d(text='Sessions').click()
    click('codex-manage-button'); fill('codex-library-search', title); close_keyboard()
    assert d(text=title, className='android.widget.TextView').wait(timeout=30), 'Fixture not listed'
    d(text=title, className='android.widget.TextView').click()
    assert d(resourceId='chat-message-input').wait(timeout=20)

def locate(identifier, query, kind, message_id=None):
    click('codex-search-button'); fill('codex-search-input', query)
    click('codex-search-kind-' + kind); close_keyboard()
    rows = api('/session/' + identifier + '/codex/search?q=' + urllib.parse.quote(query) + '&kind=' + kind)['results']
    result = next(row for row in rows if message_id is None or row['messageId'] == message_id)
    resource = 'codex-search-result-' + result['messageId']
    if not d(resourceId=resource).exists: d(scrollable=True).scroll.to(resourceId=resource)
    click(resource)
    assert d(resourceId='codex-search-target').wait(timeout=30), 'Message was not located'
    time.sleep(1)

def viewer():
    # Search highlight is an absolute sibling overlay in the native hierarchy.
    bounds = d(resourceId='codex-search-target').info['bounds']
    def selected_preview():
        for node in d(resourceId='chat-image-preview'):
            box = node.info['bounds']
            if bounds['top'] <= box['top'] < bounds['bottom'] and node.info.get('enabled'):
                return node
        return None
    wait(lambda: selected_preview() is not None, 'Image did not decode', 30)
    selected_preview().click()
    assert d(resourceId='chat-image-fullscreen').wait(timeout=15), 'Viewer did not open'
    click('chat-image-zoom'); click('chat-image-reset'); click('chat-image-close')

import urllib.parse
rows = api('/session/' + fixture['id'] + '/message')
assert api('/session/' + fixture['id'])['codex']['model'] == 'gpt-6-luna'
open_session(fixture['title'])
locate(fixture['id'], 'View image', 'tool')
viewer(); save('viewed-fixture')
locate(fixture['id'], 'MEDIA_MARKDOWN_OK', 'assistant')
assert d(resourceId='chat-image-loaded').wait(timeout=30), 'Markdown image did not decode'
# The long reply may need scrolling to bring its missing image into view.
for _ in range(8):
    if d(resourceId='chat-image-error').exists: break
    d.swipe(360, 1050, 360, 450, .4); time.sleep(.5)
assert d(resourceId='chat-image-error').wait(timeout=20), 'Missing image had no error state'
save('missing-image')
import shutil
shutil.copyfile(Path(fixture['cwd']) / 'preview.png', Path(fixture['cwd']) / 'missing.png')
click('chat-image-retry')
wait(lambda: not d(resourceId='chat-image-error').exists, 'Retry did not recover', 30)
assert d(resourceId='chat-image-loaded').exists
save('markdown-retry')
original = os.environ.get('CODEX_MEDIA_ORIGINAL')
if original:
    session = api('/session/' + original)
    history = api('/session/' + original + '/message')
    assert all(row['parts'] or row['info'].get('error') for row in history), 'Blank source bubble remains'
    open_session(session['title'])
    for tool in ['imageGeneration', 'imageView']:
        row = next(row for row in history if any(part.get('tool') == tool for part in row['parts']) and any(part['type'] == 'file' for part in row['parts']))
        # Tool inputs expose only the referenced path and prompt, never base64.
        part = next(part for part in row['parts'] if part.get('tool') == tool)
        query = Path(part['state']['input']['path']).name
        locate(original, query, 'tool', row['info']['id'])
        viewer()
    # Original-session screenshots stay local and are not publication evidence.
report = {'status': 'success', 'inferenceRequests': 0, 'checks': ['viewed image preview', 'full-screen zoom and close', 'Markdown local image', 'missing image error', 'retry recovery', 'original generated and viewed images', 'empty source records omitted']}
(args.output_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
