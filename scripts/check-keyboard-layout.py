#!/usr/bin/env python3
"""Check an open chat with Gboard visible and a nonempty draft.

Usage: python3 scripts/check-keyboard-layout.py --output-dir verification --label multiline
Requires adb on PATH and uiautomator2 (pip install uiautomator2).
Saves a screenshot, UI XML, window insets and JSON result.
Uses actual Android window coordinates, so the old zero-header-offset fails.
"""
import argparse
import json
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
import uiautomator2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", type=Path, required=True)
parser.add_argument("--label", required=True)
parser.add_argument("--serial", default="emulator-5554")
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)


def adb(*command):
    return subprocess.check_output(["adb", "-s", args.serial, *command], timeout=30)


def save(extension, content):
    path = args.output_dir / f"{args.label}.{extension}"
    path.write_bytes(content if isinstance(content, bytes) else content.encode())


xml = uiautomator2.connect(args.serial).dump_hierarchy().encode()
window = adb("shell", "dumpsys", "window").decode()
ime = adb("shell", "settings", "get", "secure", "default_input_method").decode().strip()
save("xml", xml)
save("windows.txt", window)
save("png", adb("exec-out", "screencap", "-p"))
frames = re.findall(r"type=ime frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\][^\n]*? visible=true", window)
assert frames, "The keyboard must be open before checking layout"
top = min(int(frame[1]) for frame in frames)
assert "com.google.android.inputmethod.latin" in ime, f"Expected Gboard, got {ime}"
result = {"label": args.label, "ime": ime, "keyboardTop": top, "controls": {}}
for identifier in ["chat-message-input", "chat-send-button"]:
    nodes = [node for node in ET.fromstring(xml).iter("node") if node.get("resource-id", "").split("/")[-1] == identifier]
    bounds = list(map(int, re.findall(r"\d+", nodes[0].get("bounds", "")))) if nodes else []
    visible = len(bounds) == 4 and bounds[2] > bounds[0] and bounds[3] > bounds[1] and bounds[3] <= top
    result["controls"][identifier] = {"bounds": bounds, "aboveKeyboard": visible}
result["passed"] = all(control["aboveKeyboard"] for control in result["controls"].values())
if result["passed"]:
    density = int(re.findall(r"\d+", adb("shell", "wm", "density").decode())[-1]) / 160
    bottom = max(control["bounds"][3] for control in result["controls"].values())
    result["gapBelowControlsDp"] = round((top - bottom) / density, 2)
    result["passed"] = result["gapBelowControlsDp"] <= 64
save("json", json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
raise SystemExit(0 if result["passed"] else 1)
