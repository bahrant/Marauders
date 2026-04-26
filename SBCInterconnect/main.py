"""
main.py
=======
BioReactorAgent — Edge Compute Entry Point
==========================================
asyncio supervisor that launches and crash-restarts all module tasks.

Task graph:
    opc_reader.run()     — OPC-UA push subscriptions          (always running)
    kalman.run()         — EKF predict + correct loops        (always running)
    rule_engine.run()    — 30s deterministic rule tick         (always running)
    gpt_agent.run()      — 30min GPT-4o strategic sweep       (always running)
    heartbeat.run()      — systemd + OPC-UA dual watchdog     (always running)

NFR-03: Each task has an independent exception handler with 10s backoff restart.
        One task crashing does not affect the others.

Startup sequence:
    1. Load config.toml
    2. Load .env secrets
    3. Open aiosqlite AuditStore (audit.py)
    4. Connect asyncua Client (shared by opc_writer + heartbeat)
    5. Configure all modules with shared dependencies
    6. Launch all tasks under the per-task supervisor

Deployment:
    /opt/bioreactor-agent/main.py
    Managed by systemd unit bioreactor-agent.service (Type=notify)
"""

import asyncio
import logging
import os
import sys

import tomllib
from asyncua import Client
from dotenv import load_dotenv

import audit as audit_mod
import gpt_agent
import heartbeat
import kalman
import opc_reader
import opc_writer
import rule_engine

# ── Logging setup ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)-14s  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("main")

# ── Config + secrets ──────────────────────────────────────────────────────────

_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "config.toml")
_TASK_RESTART_BACKOFF_S = 10   # NFR-03


def _load_config() -> dict:
    with open(_CONFIG_PATH, "rb") as f:
        return tomllib.load(f)


def _load_env() -> None:
    """Load .env from the same directory as main.py."""
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path)
        logger.info("Loaded secrets from .env")
    else:
        logger.warning(".env not found — using environment variables only")


# ── Per-task supervisor ───────────────────────────────────────────────────────

async def _supervised_task(name: str, coro_factory) -> None:
    """
    NFR-03: Run a coroutine factory in a loop with 10s backoff on exception.
    A crash in this task does not propagate to the asyncio.gather() in main —
    each task is wrapped independently.
    """
    while True:
        try:
            logger.info("[%s] starting", name)
            await coro_factory()
            # If the coroutine returns normally (shouldn't happen for infinite loops)
            logger.warning("[%s] exited without exception — restarting", name)
        except asyncio.CancelledError:
            logger.info("[%s] cancelled — stopping", name)
            raise
        except Exception as exc:
            logger.exception(
                "[%s] crashed: %s — restarting in %ds",
                name, exc, _TASK_RESTART_BACKOFF_S
            )
        await asyncio.sleep(_TASK_RESTART_BACKOFF_S)


# ── OPC-UA client context ─────────────────────────────────────────────────────

class _SharedOPCClient:
    """
    Thin wrapper holding a single asyncua.Client instance shared across
    opc_writer and heartbeat. The client connection lifecycle is managed
    by opc_reader which reconnects on loss; opc_writer and heartbeat receive
    the same client reference and handle disconnected-client gracefully.

    In the current implementation we create the client once and pass it by
    reference. opc_reader.run() maintains the actual TCP connection; if the
    connection drops, opc_reader re-establishes it and opc_writer checks
    opc_reader.is_connected before writing (FR-24).
    """

    def __init__(self, endpoint: str) -> None:
        self.client = Client(url=endpoint)

    async def connect(self, username: str, password: str) -> None:
        self.client.set_user(username)
        self.client.set_password(password)
        try:
            await self.client.connect()
            logger.info("Shared OPC-UA client connected")
        except Exception as exc:
            # Non-fatal at startup — opc_reader will retry the connection.
            # opc_writer and heartbeat check is_connected before writing.
            logger.warning(
                "Initial OPC-UA connect failed (%s) — "
                "opc_reader will retry in background",
                exc,
            )

    async def disconnect(self) -> None:
        try:
            await self.client.disconnect()
        except Exception:
            pass


# ── Entry point ───────────────────────────────────────────────────────────────

async def main() -> None:
    logger.info("=" * 60)
    logger.info("  BioReactorAgent — starting up")
    logger.info("=" * 60)

    # ── 1. Load configuration ──────────────────────────────────────────────
    cfg = _load_config()
    _load_env()

    run_id = os.environ.get("RUN_ID", "run-001")
    logger.info("Run ID: %s", run_id)

    # ── 2. Open audit store ────────────────────────────────────────────────
    db_path = cfg.get("data", {}).get("db_path", "/opt/bioreactor-agent/data/audit.db")
    store = audit_mod.AuditStore(db_path=db_path, run_id=run_id)
    await store.init()
    logger.info("AuditStore ready: %s", db_path)

    # ── 3. Create shared OPC-UA client ─────────────────────────────────────
    opc_cfg = cfg["opc_ua"]
    endpoint = opc_cfg["endpoint"]
    username = opc_cfg["username"]
    password = os.environ.get("OPC_UA_PASSWORD", "")

    shared_opc = _SharedOPCClient(endpoint)
    await shared_opc.connect(username, password)

    # ── 4. Configure all modules ───────────────────────────────────────────
    opc_writer.configure(
        audit_store=store,
        run_id=run_id,
        client=shared_opc.client,
    )
    rule_engine.configure(
        audit_store=store,
        run_id=run_id,
        cfg=cfg,
    )
    gpt_agent.configure(
        audit_store=store,
        run_id=run_id,
        cfg=cfg,
    )
    heartbeat.configure(
        cfg=cfg,
        client=shared_opc.client,
    )

    logger.info("All modules configured — launching task supervisors")

    # ── 5. Wire rule_engine Critical events → gpt_agent immediate trigger ──
    # Monkey-patch rule_engine._flag_human to call gpt_agent.trigger_immediate()
    _orig_flag_human = rule_engine._flag_human

    async def _patched_flag_human(reactor_id, day, parameter, value, reason):
        await _orig_flag_human(reactor_id, day, parameter, value, reason)
        logger.info(
            "Critical event in %s — triggering immediate GPT sweep", reactor_id
        )
        gpt_agent.trigger_immediate()

    rule_engine._flag_human = _patched_flag_human

    # ── 6. Launch supervised tasks (NFR-03) ────────────────────────────────
    tasks = [
        asyncio.create_task(
            _supervised_task("opc_reader",  lambda: opc_reader.run()),
            name="task.opc_reader",
        ),
        asyncio.create_task(
            _supervised_task("kalman",      lambda: kalman.run()),
            name="task.kalman",
        ),
        asyncio.create_task(
            _supervised_task("rule_engine", lambda: rule_engine.run()),
            name="task.rule_engine",
        ),
        asyncio.create_task(
            _supervised_task("gpt_agent",   lambda: gpt_agent.run()),
            name="task.gpt_agent",
        ),
        asyncio.create_task(
            _supervised_task("heartbeat",   lambda: heartbeat.run()),
            name="task.heartbeat",
        ),
    ]

    logger.info(
        "BioReactorAgent running — %d tasks active. "
        "Endpoint: %s  Run: %s",
        len(tasks), endpoint, run_id,
    )

    try:
        # Run until cancelled (e.g. SIGTERM from systemd)
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        logger.info("Shutdown signal received — cancelling tasks")
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        logger.info("Closing audit store and OPC-UA client")
        await store.close()
        await shared_opc.disconnect()
        logger.info("BioReactorAgent stopped cleanly")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Interrupted — exiting")
