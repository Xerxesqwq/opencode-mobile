#!/usr/bin/env python3
"""Read-only Android navigation check against two existing saved sessions."""
import argparse, json, os, time
from pathlib import Path
import uiautomator2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args(); args.output_dir.mkdir(parents=True, exist_ok=True)
identifiers = os.environ['NAVIGATION_LIVE_IDS'].split(',')
assert len(identifiers) == 2 and all(identifiers)
connection = os.environ['NAVIGATION_LIVE_CONNECTION']
d = uiautomator2.connect()
d.app_start('cc.agentlabs.opencode', stop=True)
assert d(text='Connections').wait(timeout=30)
d(text='Connections').click()
for _ in range(15):
    if d(text=connection).exists: break
    d.swipe_ext('up', scale=.6); time.sleep(.4)
assert d(text=connection).exists, 'Saved live connection not found'
d(text=connection).click(); time.sleep(1)
d(text='Sessions').click()
checks = []
for identifier in identifiers * 2:
    resource = 'session-item-' + identifier
    for _ in range(20):
        if d(resourceId=resource).exists: break
        d.swipe_ext('up', scale=.55); time.sleep(.5)
    assert d(resourceId=resource).exists, 'Existing session row not found'
    d(resourceId=resource).click()
    assert d(resourceId='chat-content-' + identifier).wait(timeout=45), 'Wrong or unloaded conversation'
    assert d(resourceId='chat-route-' + identifier).exists, 'Route identity mismatch'
    time.sleep(3)
    assert d(resourceId='chat-content-' + identifier).exists, 'Live updates changed the destination'
    assert all(not d(resourceId='chat-content-' + other).exists for other in identifiers if other != identifier)
    checks.append({'requestedID': identifier, 'visibleID': identifier, 'stableAfterLiveUpdates': True})
    d.press('back')
    assert d(text='Sessions').wait(timeout=15)
    d(text='Sessions').click(); time.sleep(.8)
    # Return the list to its beginning before finding the next session.
    for _ in range(3): d.swipe_ext('down', scale=.7)
report = {'status': 'success', 'inferenceRequests': 0, 'sessionMutations': 0, 'checks': checks}
(args.output_dir / 'live-android.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
