"""Demo SMS gateway: a real phone with a SIM is the gateway number, read over adb and forwarded to the server.

Usage (gateway phone connected by USB, SAHAY_GATEWAY_SECRET set on the server):
    python backend/scripts/sms_gateway_adb.py --serial <adb serial> --api https://<host>/api/v1 --secret <secret>

It polls the phone's SMS inbox for messages that start with `SAHAY1|` and POSTs each new one to
POST /sms-gateway/inbound. The server ignores repeats (same report), so restarting is safe.
For a real deployment use Twilio or a forwarder app instead; this script exists so the demo needs no account.
"""
import argparse
import os
import re
import subprocess
import time

import httpx

ADB = os.environ.get("ADB", "adb")
ROW = re.compile(r"address=(?P<addr>[^,]*), body=(?P<body>SAHAY1\|[^,]*?)(?:, |$)")


def inbox(serial: str) -> list[tuple[str, str]]:
    out = subprocess.run(
        [ADB, "-s", serial, "shell", "content", "query", "--uri", "content://sms/inbox", "--projection", "address:body"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    ).stdout
    return [(m["addr"].strip(), m["body"].strip()) for line in out.splitlines() if (m := ROW.search(line))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", required=True)
    ap.add_argument("--api", required=True)
    ap.add_argument("--secret", default=os.environ.get("SAHAY_GATEWAY_SECRET", ""))
    ap.add_argument("--interval", type=float, default=3.0)
    args = ap.parse_args()
    if not args.secret:
        raise SystemExit("--secret or SAHAY_GATEWAY_SECRET is required")
    seen: set[tuple[str, str]] = set()
    client = httpx.Client(timeout=15, headers={"ngrok-skip-browser-warning": "1"})
    print("gateway running; Ctrl+C to stop")
    while True:
        for addr, body in inbox(args.serial):
            if (addr, body) in seen:
                continue
            r = client.post(f"{args.api.rstrip('/')}/sms-gateway/inbound",
                            headers={"X-Gateway-Secret": args.secret}, json={"from": addr, "body": body})
            print(addr, body[:40], "->", r.status_code)
            if r.status_code < 500:  # 5xx: try again next round
                seen.add((addr, body))
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
