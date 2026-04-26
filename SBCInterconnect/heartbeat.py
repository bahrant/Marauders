"""
heartbeat.py
============
BioReactorAgent — Dual Watchdog Heartbeat
==========================================
Implements FR-29, FR-30, FR-31.

Signals liveness to two independent monitoring systems:

1. systemd watchdog (FR-29)
   sdnotify.SystemdNotifier().notify("WATCHDOG=1") every ≤30s
   systemd unit has WatchdogSec=60 — if not notified within 60s,
   the service is killed and restarted.

2. OPC-UA heartbeat node (FR-30)
   Writes an incrementing integer counter to the DCS heartbeat node
   every 15 seconds. The DCS monitors this to detect agent failure.

FR-31: A failed OPC-UA heartbeat write does NOT stop the systemd
       notification. The two watchdog tasks run as fully independent
       asyncio.Tasks — an exception in one does not propagate to the other.

The OPC-UA write uses the asyncua client directly (not opc_writer.py)
to minimise the dependency chain for a safety-critical liveness signal.
opc_writer dependency on config + audit would add failure modes that could
silently prevent heartbeat writes.
"""

import asyncio
import logging
import os
from typing import Optional

import tomllib
from asyncua import Client, ua

logger = logging.getLogger("heartbeat")

# ── Module wiring ──────────────────────────────────────────────────────────────

_cfg: Optional[dict] = None
_client: Optional[Client] = None

# Monotonically increasing counter written to OPC-UA node
_hb_counter: int = 0


def configure(cfg: dict, client: Client) -> None:
    """Inject shared config and asyncua client. Called once from main.py."""
    global _cfg, _client
    _cfg = cfg
    _client = client
    logger.info("heartbeat configured")


# ── OPC-UA heartbeat node path ──────────────────────────────────────────────

def _get_heartbeat_node() -> Optional[str]:
    """
    Return the OPC-UA heartbeat node path from config.
    Uses the first reactor's heartbeat node (all reactors share one agent node
    per config.toml: ns=2;s=Agent.heartbeat).
    """
    if _cfg is None:
        return None
    reactors = _cfg.get("reactors", {})
    for reactor_cfg in reactors.values():
        hb = reactor_cfg.get("opc_heartbeat")
        if hb:
            return hb
    return None


# ── systemd watchdog task (FR-29) ─────────────────────────────────────────────

async def _systemd_watchdog_loop(interval_s: int) -> None:
    """
    FR-29: Notify systemd watchdog every interval_s seconds.
    Uses sdnotify if available; falls back to no-op with a warning
    (allows running outside systemd during development).
    """
    try:
        import sdnotify
        notifier = sdnotify.SystemdNotifier()
        # Tell systemd the service is ready and we're starting the watchdog loop
        notifier.notify("READY=1")
        logger.info("systemd watchdog started — interval=%ds", interval_s)
    except ImportError:
        notifier = None
        logger.warning(
            "sdnotify not installed — systemd watchdog disabled "
            "(install sdnotify on target hardware)"
        )

    while True:
        await asyncio.sleep(interval_s)
        if notifier:
            try:
                notifier.notify("WATCHDOG=1")
                logger.debug("systemd WATCHDOG=1 sent")
            except Exception as exc:
                # FR-31: log but do NOT stop the loop or affect the OPC-UA task
                logger.error("systemd watchdog notify failed: %s", exc)


# ── OPC-UA heartbeat task (FR-30) ─────────────────────────────────────────────

async def _opc_heartbeat_loop(interval_s: int) -> None:
    """
    FR-30: Write incrementing integer counter to OPC-UA heartbeat node
    every interval_s seconds.

    FR-31: A failed write is logged but does not raise — the systemd
    watchdog task is fully independent and unaffected.
    """
    global _hb_counter
    node_str = _get_heartbeat_node()

    if node_str is None:
        logger.warning("No heartbeat OPC-UA node configured — OPC-UA watchdog disabled")
        # Keep looping so the task doesn't exit (FR-31 independence preserved)
        while True:
            await asyncio.sleep(interval_s)
        return

    logger.info("OPC-UA heartbeat started — node=%s interval=%ds", node_str, interval_s)

    while True:
        await asyncio.sleep(interval_s)

        if _client is None:
            logger.debug("OPC-UA heartbeat: client not ready yet")
            continue

        _hb_counter += 1

        try:
            node = _client.get_node(node_str)
            dv = ua.DataValue(ua.Variant(_hb_counter, ua.VariantType.UInt32))
            await node.write_value(dv)
            logger.debug("OPC-UA heartbeat written: %d → %s", _hb_counter, node_str)
        except Exception as exc:
            # FR-31: exception must NOT propagate — systemd loop continues unaffected
            logger.warning(
                "OPC-UA heartbeat write failed (counter=%d): %s — "
                "systemd watchdog unaffected",
                _hb_counter, exc
            )


# ── Main run coroutine ────────────────────────────────────────────────────────

async def run() -> None:
    """
    FR-29/FR-30/FR-31: Launch both heartbeat tasks as independent asyncio.Tasks
    so that a failure in one does not kill the other.

    This coroutine is supervised by main.py's per-task crash handler.
    """
    timing = (_cfg or {}).get("timing", {})
    watchdog_s: int = int(timing.get("watchdog_s", 25))
    heartbeat_s: int = int(timing.get("heartbeat_s", 15))

    # Two fully independent tasks — FR-31
    systemd_task = asyncio.create_task(
        _systemd_watchdog_loop(watchdog_s),
        name="heartbeat.systemd",
    )
    opc_task = asyncio.create_task(
        _opc_heartbeat_loop(heartbeat_s),
        name="heartbeat.opc",
    )

    # Wait for both — if either raises, catch and log without killing the other
    done, pending = await asyncio.wait(
        {systemd_task, opc_task},
        return_when=asyncio.FIRST_EXCEPTION,
    )

    for task in done:
        if task.exception():
            logger.error(
                "heartbeat sub-task %s raised: %s — restarting outer run()",
                task.get_name(), task.exception()
            )

    # Cancel remaining tasks and re-raise to trigger main.py restart
    for task in pending:
        task.cancel()

    # Re-raise so main.py can restart run() after backoff (NFR-03)
    raise RuntimeError("heartbeat sub-task exited unexpectedly — triggering restart")
