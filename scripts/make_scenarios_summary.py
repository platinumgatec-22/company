#!/usr/bin/env python3
"""Summarize a Make scenarios list compactly.

Input: JSON array from the Make API / MCP `scenarios_list` (file path or stdin).
Output: one line per scenario, active first, plus totals.

Usage:
    python3 scripts/make_scenarios_summary.py scenarios.json
    cat scenarios.json | python3 scripts/make_scenarios_summary.py
"""
import json
import sys
from collections import Counter

# Short aliases for Make package names.
PKG = {
    "google-sheets": "Sheets", "google-email": "Gmail", "google-drive": "Drive",
    "ai-tools": "AI", "openai-gpt-3": "OpenAI", "gateway": "Webhook",
    "datastore": "DataStore", "whatsapp-business-cloud": "WhatsApp",
    "facebook-pages": "FB", "instagram-business": "IG", "tiktok": "TikTok",
    "youtube": "YouTube", "buffer": "Buffer", "slack": "Slack", "canva": "Canva",
    "notion": "Notion", "browse-ai": "BrowseAI", "telegram": "Telegram",
    "google-calendar": "Calendar", "builtin": "", "util": "", "json": "",
    "http": "HTTP", "regexp": "", "array-aggregator": "",
}


def schedule(s):
    sch = s.get("scheduling") or {}
    t = sch.get("type")
    if t == "immediately" or s.get("hookId"):
        return "instant"
    if t == "indefinitely" and sch.get("interval"):
        sec = sch["interval"]
        if sec % 86400 == 0:
            return f"{sec // 86400}d"
        if sec % 3600 == 0:
            return f"{sec // 3600}h"
        return f"{sec // 60}m"
    return t or "on-demand"


def apps(s):
    seen = []
    for p in s.get("usedPackages") or []:
        name = PKG.get(p, p)
        if name and name not in seen:
            seen.append(name)
    return ",".join(seen)


def line(s):
    flags = []
    if s.get("errors"):
        flags.append(f"err={s['errors']}")
    if s.get("dlqCount"):
        flags.append(f"dlq={s['dlqCount']}")
    if s.get("isinvalid"):
        flags.append("INVALID")
    if s.get("isPaused"):
        flags.append("paused")
    extra = (" !" + " ".join(flags)) if flags else ""
    return (f"  {s['id']:<8} {schedule(s):<9} runs={s.get('executions', 0):<4} "
            f"{s['name']} [{apps(s)}]{extra}")


def main():
    src = open(sys.argv[1], encoding="utf-8") if len(sys.argv) > 1 else sys.stdin
    data = json.load(src)
    scenarios = [s for s in data if not s.get("deleted")]
    active = sorted((s for s in scenarios if s.get("islinked")), key=lambda s: s["name"])
    inactive = sorted((s for s in scenarios if not s.get("islinked")), key=lambda s: s["name"])

    print(f"Scenarios: {len(scenarios)} total, {len(active)} active, {len(inactive)} inactive")
    print(f"\nACTIVE ({len(active)})")
    for s in active:
        print(line(s))
    print(f"\nINACTIVE ({len(inactive)})")
    for s in inactive:
        print(line(s))

    sched = Counter(schedule(s) for s in active)
    usage = Counter(a for s in scenarios for a in apps(s).split(",") if a)
    flagged = [s for s in scenarios if s.get("errors") or s.get("dlqCount") or s.get("isinvalid")]
    print("\nActive by schedule: " + ", ".join(f"{k}={v}" for k, v in sched.most_common()))
    print("Apps (scenario count): " + ", ".join(f"{k}={v}" for k, v in usage.most_common()))
    print(f"With errors/DLQ/invalid: {len(flagged)}"
          + ("" if not flagged else " -> " + ", ".join(s["name"] for s in flagged)))


if __name__ == "__main__":
    main()
