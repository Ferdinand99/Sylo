"""Prints the UDID of the newest available iPhone simulator, preferring a Pro model."""
import json
import re
import subprocess
import sys

data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "-j", "devices", "available"]))
best = None
for runtime, devices in data["devices"].items():
    match = re.search(r"iOS-(\d+)-(\d+)", runtime)
    if not match:
        continue
    version = (int(match.group(1)), int(match.group(2)))
    for device in devices:
        if not device.get("isAvailable", True):
            continue
        name = re.match(r"^iPhone (\d+)(?: (Pro))?$", device["name"])
        if not name:
            continue
        rank = (version, 1 if name.group(2) else 0, int(name.group(1)))
        if best is None or rank > best[0]:
            best = (rank, device["udid"], device["name"], runtime)

if best is None:
    print("No iPhone simulator is available.", file=sys.stderr)
    sys.exit(1)
print("Picked %s on %s" % (best[2], best[3]), file=sys.stderr)
print(best[1])
