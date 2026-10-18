"""Scheduler: python -m app.jobs.scheduler. Runs as its own container."""

import asyncio
import logging
import signal

from app.config import get_settings
from app.services import outbox, scheduler

log = logging.getLogger("pcms.scheduler")

TASKS = [
    (30, "scan", scheduler.scan_quarantine),
    (60, "acceptance", scheduler.acceptance_fallbacks),
    (60, "stuck_outbox", outbox.recover_stuck),
    (3600, "verify_reminders", scheduler.verification_reminders),
    (3600, "hold_reviews", scheduler.hold_reviews),
    (3600, "housekeeping", scheduler.housekeeping),
]


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    problems = get_settings().check_production()
    if problems:
        raise SystemExit("unsafe production configuration: " + "; ".join(problems))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    last: dict[str, float] = {}
    log.info("scheduler started")
    while not stop.is_set():
        t = loop.time()
        for every, name, fn in TASKS:
            if t - last.get(name, -1e9) >= every:
                last[name] = t
                try:
                    await fn()
                except Exception:
                    log.exception("scheduled task %s failed", name)
        try:
            await asyncio.wait_for(stop.wait(), timeout=10)
        except TimeoutError:
            pass
    log.info("scheduler stopped")


if __name__ == "__main__":
    asyncio.run(main())
