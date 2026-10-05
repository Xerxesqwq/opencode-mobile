#!/usr/bin/env python3
"""Deterministic Android CUA for a dedicated workbench-live-check fixture."""
import argparse, base64, json, os, re, sys, time, traceback, urllib.request
from pathlib import Path
import uiautomator2
sys.excepthook = lambda kind, value, trace: print('UI check failed: ' + kind.__name__ + (': ' + str(value) if kind is AssertionError else '') + ' at line ' + str(traceback.extract_tb(trace)[-1].lineno), file=sys.stderr)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
fixture = json.loads(Path(os.environ['CODEX_WORKBENCH_REPORT']).read_text())
assert fixture['title'].startswith('Workbench ')
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

runner = api('/session/' + fixture['runner'])
assert runner['title'] == fixture['title'] + ' active task'
if runner['codex']['runtimeStatus'] == 'active':
    api('/session/' + fixture['runner'] + '/abort', {})
    wait(lambda: api('/session/' + fixture['runner'])['codex']['runtimeStatus'] != 'active', 'Fixture task did not stop', 90)
# Restore this test's fixtures so an interrupted UI run can be repeated safely.
api('/codex/archive', {'ids': [fixture['source'], fixture['backup']], 'archived': False})
assert api('/session/' + fixture['source'])['title'] == fixture['title']
if api('/session/' + fixture['source'] + '/codex/search?q=WORKBENCH_RETRY_MARKER&kind=user')['total'] == 0:
    api('/session/' + fixture['source'] + '/prompt_async', {'parts': [{'type': 'text', 'text': 'Reply exactly WORKBENCH_RETRY_MARKER. Do not use tools.'}]})
    wait(lambda: api('/session/' + fixture['source'])['codex']['runtimeStatus'] == 'idle', 'Fixture prompt did not finish', 90)
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text='Sessions').wait(timeout=25); d(text='Sessions').click()
click('codex-manage-button')
fill('codex-library-search', fixture['title']); close_keyboard()
if not d(text=fixture['title'], className='android.widget.TextView').exists:
    d(scrollable=True).scroll.to(text=fixture['title'], className='android.widget.TextView')
assert d(text=fixture['title'], className='android.widget.TextView').exists, 'Dedicated fixture missing from sessions'
d(text=fixture['title'], className='android.widget.TextView').click()
search('WORKBENCH_OLD_MARKER'); save('search-location')
click('codex-files-button')
first = fixture['files'][0]; second = fixture['files'][1]
assert d(resourceId='codex-file-' + first).wait(timeout=20)
assert d(resourceId='codex-diff-line-number').exists, 'Diff line numbers missing'
assert d(textContains='+2').exists, 'Added line count missing'
click('codex-file-' + first)
assert not d(resourceId='codex-diff-line-number').exists, 'File collapse failed'
click('codex-file-' + second)
assert d(resourceId='codex-diff-line-number').exists, 'File expand failed'
save('grouped-file-review'); click('codex-workbench-close')
result = search('WORKBENCH_RETRY_MARKER')
click('codex-rewind-' + result['messageId'])
assert d(textMatches='(?i)Back up & rewind').wait(timeout=10)
d(textMatches='(?i)Back up & rewind').click()
assert d(textMatches='(?i)Edit prompt').wait(timeout=45), 'Rewind did not complete'
d(textMatches='(?i)Edit prompt').click()
assert 'WORKBENCH_RETRY_MARKER' in d(resourceId='chat-message-input').get_text(), 'Original prompt not restored'
assert api('/session/' + fixture['source'] + '/codex/search?q=WORKBENCH_RETRY_MARKER&kind=user')['total'] == 0
save('rewind-draft')
d(resourceId='chat-message-input').set_text('Reply exactly ANDROID_WORKBENCH_RETRY_OK. Do not use tools.'); click('chat-send-button')
wait(lambda: any(row['info']['role'] == 'assistant' and any(part.get('text') == 'ANDROID_WORKBENCH_RETRY_OK' for part in row['parts']) for row in api('/session/' + fixture['source'] + '/message')), 'Retry reply missing', 90)
close_keyboard(); d.press('back'); time.sleep(1)
click('codex-manage-button'); fill('codex-library-search', fixture['title']); close_keyboard()
for identifier in [fixture['source'], fixture['backup']]:
    if not d(resourceId='codex-library-select-' + identifier).exists:
        d(scrollable=True).scroll.to(resourceId='codex-library-select-' + identifier)
    click('codex-library-select-' + identifier)
click('codex-library-batch')
wait(lambda: d(resourceId='codex-library-notice').exists and d(resourceId='codex-library-notice').get_text().startswith('2 '), 'Batch archive incomplete')
click('codex-workspace-archived'); fill('codex-library-search', fixture['title']); close_keyboard()
for identifier in [fixture['source'], fixture['backup']]:
    if not d(resourceId='codex-library-select-' + identifier).exists:
        d(scrollable=True).scroll.to(resourceId='codex-library-select-' + identifier)
    click('codex-library-select-' + identifier)
save('archived-sessions'); click('codex-library-batch')
wait(lambda: d(resourceId='codex-library-notice').exists and d(resourceId='codex-library-notice').get_text().startswith('2 '), 'Batch restore incomplete')
click('codex-workbench-close')
# Start only the dedicated runner; stop it through the dashboard.
api('/session/' + fixture['runner'] + '/prompt_async', {'parts': [{'type': 'text', 'text': 'Run sleep 90 once. Do not change files.'}]})
click('codex-tasks-button'); fill('codex-library-search', fixture['title'] + ' active task'); close_keyboard()
assert d(resourceId='codex-task-' + fixture['runner']).wait(timeout=30), 'Active task missing'
save('active-task'); click('codex-task-stop-' + fixture['runner'])
assert d(textMatches='(?i)Stop').wait(timeout=10); d(textMatches='(?i)Stop').click()
wait(lambda: api('/session/' + fixture['runner'])['codex']['runtimeStatus'] != 'active', 'Task did not stop', 90)
click('codex-task-filter-all')
wait(lambda: d(resourceId='codex-task-state-' + fixture['runner']).exists and d(resourceId='codex-task-state-' + fixture['runner']).get_text() == 'Stopped', 'Dashboard status did not update', 25)
d(text=fixture['title'] + ' active task', className='android.widget.TextView').click()
assert d(resourceId='codex-search-button').wait(timeout=15), 'Task jump failed'
save('task-jump')
report = {'status': 'success', 'fixture': fixture['source'], 'checks': ['search and locate', 'grouped diffs and line numbers', 'collapse and expand', 'backup and rewind draft', 'retry reply', 'batch archive and restore', 'global task stop and jump']}
(args.output_dir / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report))
