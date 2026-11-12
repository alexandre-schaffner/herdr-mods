"""What waits on the person in HQ, per org, for the sidebar's "Needs you" strip.

  python3 -I needs.py

Prints {"<org folder>": {"asks": n, "review": n}}: open approvals and questions (a decision
only the person makes), and open finished work to look over. Reads data/hq/<org>/inbox/*.json
(HQ writes one file per item). Cheap enough to run every few seconds.
"""

import glob
import json
import os
import sys

HQ = os.path.join(os.path.expanduser("~"), ".config", "herdr-app", "data", "hq")


def main():
    out = {}
    for org in sorted(os.listdir(HQ)) if os.path.isdir(HQ) else []:
        if not os.path.isdir(os.path.join(HQ, org, "inbox")):
            continue
        asks = review = 0
        for f in glob.glob(os.path.join(HQ, org, "inbox", "*.json")):
            try:
                with open(f, encoding="utf-8") as fh:
                    it = json.load(fh)
            except (OSError, ValueError):
                continue
            if it.get("state") != "open":
                continue
            if it.get("kind") in ("approval", "question"):
                asks += 1
            elif it.get("kind") == "done":
                review += 1
        out[org] = {"asks": asks, "review": review}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
