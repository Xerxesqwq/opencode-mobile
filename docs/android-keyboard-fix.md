# Android keyboard layout verification

## Change

The chat measures its container position to calculate `keyboardVerticalOffset`.
On Android, the status bar inset is added because React Native window measurements
and keyboard screen coordinates use different origins. This keeps the composer
and send button above Gboard when using edge-to-edge layout.

## Reproduction and results

Tested on an Android 15 Pixel 6 emulator with Gboard 14.2.09.629370537,
720 × 1600 display and 280 dpi. The app connected to the repository mock server
on port 14096. A nonempty draft and the send button were checked with real UI
bounds and the Android IME frame.

- Before the fix: the composer and send button were covered by Gboard.
- After the fix: both controls ended at y=977, above the keyboard at y=1019.
  The gap was 24 dp.
- A multiline draft and three keyboard reopen cycles passed the same checks.
- Sending a draft with Gboard open reached the mock server successfully.
- The same layout fix was exercised in a signed release build without Metro.
- These checks used the earlier personal build identity. Version 0.4.16 restores
  the original package/name and leaves the tested keyboard layout code unchanged.
- A physical phone and other Android/input method combinations remain untested.

| Before | After |
| --- | --- |
| ![Before](verification/android-keyboard/before-fix.png) | ![After](verification/android-keyboard/after-fix.png) |

Machine-readable results are in `docs/verification/android-keyboard/`.

To rerun, open a chat with a nonempty draft and Gboard visible, then run:

```sh
python3 -m pip install uiautomator2
python3 scripts/check-keyboard-layout.py --output-dir verification --label keyboard
```

The script requires `adb` on PATH and defaults to `emulator-5554`.
Use `--serial` for a different device. It fails if the composer is hidden, if
its controls overlap the keyboard, or if the gap below the controls exceeds 64 dp.

## Icons and version

The launcher uses a navy background with white/cyan code brackets and a cursor.
Adaptive icons include a monochrome variant. Source SVG and the generator are
checked in; run `node scripts/generate-launcher-icons.mjs` to regenerate assets.
Release metadata is 0.4.16 with versionCode 43 and package `cc.agentlabs.opencode`.
