"""Outbox worker: python -m app.jobs.worker. Runs as its own container."""

import asyncio
import logging
import signal

from app.config import get_settings
from app.services import outbox

log = logging.getLogger("pcms.worker")


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    problems = get_settings().check_production()
    if problems:
        raise SystemExit("unsafe production configuration: " + "; ".join(problems))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    log.info("outbox worker started (provider=%s)", get_settings().messaging_provider)
    while not stop.is_set():
        try:
            n = await outbox.run_once()
        except Exception:
            log.exception("outbox cycle failed")
            n = 0
        if n == 0:
            try:
                await asyncio.wait_for(stop.wait(), timeout=2)
            except TimeoutError:
                pass
    log.info("outbox worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
