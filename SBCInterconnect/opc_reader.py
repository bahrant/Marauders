"""
opc_reader.py
=============
BioReactorAgent — OPC-UA Subscription Reader
=============================================
Implements FR-01 through FR-06.

Single interface between the DCS and the rest of the system.
All probe data enters through this module — no other module reads OPC-UA.

Architecture:
  - asyncua.Client with username/password auth (FR-01)
  - 500ms OPC-UA subscription using subscribe_data_change() push model (FR-02)
  - Subscribes: pH, DO, temperature, agitation, offgas_CO2, offgas_O2 per reactor
    Additional nodes configurable in config.toml without code changes (FR-03)
  - On notification → push (reactor_id, parameter, value, server_timestamp)
    to module-level asyncio.Queue consumed by kalman.py (FR-04)
  - get_latest(reactor_id, parameter) → float | None (FR-05)
  - Reconnect backoff 1→2→4→8→16→60s on connection loss (FR-06)
  - is_connected: bool flag consumed by opc_writer.py (FR-06)
"""

import asyncio
import logging
import os
import time
from typing import Optional

import tomllib
from asyncua import Client, ua
from asyncua.common.subscription import SubHandler

logger = logging.getLogger("opc_reader")

# ── Module-level state ────────────────────────────────────────────────────────

# FR-06: consumed by opc_writer.py before any write attempt
is_connected: bool = False

# FR-04: kalman.py consumes this queue
# Each item: (reactor_id: str, parameter: str, value: float, server_ts: float)
measurement_queue: asyncio.Queue = asyncio.Queue(maxsize=2048)

# FR-05: most recent value per (reactor_id, parameter)
_latest: dict[tuple[str, str], float] = {}

# Internal: maps OPC-UA node string → (reactor_id, parameter_name)
_node_map: dict[str, tuple[str, str]] = {}

# Reconnect backoff sequence (seconds) — FR-06
_BACKOFF = [1, 2, 4, 8, 16, 60]


# ── Subscription handler ──────────────────────────────────────────────────────

class _DataChangeHandler(SubHandler):
    """
    asyncua subscription callback handler.
    Invoked by the asyncua stack for every 500ms data-change notification.
    """

    def datachange_notification(self, node, val, data):
        """
        FR-04: Push (reactor_id, parameter, value, server_timestamp) to queue.
        Runs in the asyncua thread — uses put_nowait to avoid blocking the
        OPC-UA receive loop.
        """
        node_str = node.nodeid.to_string()
        mapping = _node_map.get(node_str)
        if mapping is None:
            logger.debug("datachange_notification: unknown node %s", node_str)
            return

        reactor_id, parameter = mapping

        # Coerce to float — DCS may send variants (Int16, Float, Double)
        try:
            value = float(val)
        except (TypeError, ValueError):
            logger.warning(
                "Non-numeric value for %s.%s: %r", reactor_id, parameter, val
            )
            return

        # Server timestamp from the DataValue — falls back to local clock
        server_ts: float
        try:
            server_ts = data.monitored_item.Value.SourceTimestamp.timestamp()
        except Exception:
            server_ts = time.time()

        # Update latest cache (FR-05)
        _latest[(reactor_id, parameter)] = value

        # Push to queue (FR-04)
        try:
            measurement_queue.put_nowait((reactor_id, parameter, value, server_ts))
        except asyncio.QueueFull:
            logger.warning(
                "measurement_queue full — dropping %s.%s=%s",
                reactor_id, parameter, value
            )

    def event_notification(self, event):
        pass  # Not used


# ── Public API ────────────────────────────────────────────────────────────────

def get_latest(reactor_id: str, parameter: str) -> Optional[float]:
    """
    FR-05: Return most recently received value for any subscribed node.
    Returns None if no value has been received yet.
    """
    return _latest.get((reactor_id, parameter))


# ── Internal helpers ──────────────────────────────────────────────────────────

def _load_config() -> dict:
    config_path = os.path.join(os.path.dirname(__file__), "config.toml")
    with open(config_path, "rb") as f:
        return tomllib.load(f)


def _build_node_map(cfg: dict) -> dict[str, tuple[str, str]]:
    """
    Build reactor_id/parameter → OPC-UA node string mapping from config.
    The 'opc_' prefix keys in each [reactors.RN] section that are NOT setpoints
    are measurement nodes to subscribe to.

    Measurement node keys follow the pattern: opc_<parameter>
    Setpoint node keys follow the pattern: opc_<parameter>_sp  (excluded here)
    Extra nodes can be added to config without code changes (FR-03).
    """
    node_map: dict[str, tuple[str, str]] = {}
    reactors_cfg = cfg.get("reactors", {})
    for reactor_id, reactor_cfg in reactors_cfg.items():
        for key, node_str in reactor_cfg.items():
            if not key.startswith("opc_"):
                continue
            # Exclude setpoint keys (end in _sp) and heartbeat
            if key.endswith("_sp") or key == "opc_heartbeat":
                continue
            # Derive parameter name: strip "opc_" prefix
            parameter = key[4:]  # e.g. "opc_pH" → "pH"
            node_map[node_str] = (reactor_id, parameter)
            logger.debug("Mapped node %s → (%s, %s)", node_str, reactor_id, parameter)
    return node_map


async def _subscribe_reactor_nodes(
    client: Client,
    reactor_id: str,
    reactor_cfg: dict,
    subscription,
    handler: _DataChangeHandler,
) -> None:
    """Subscribe to all measurement nodes for one reactor."""
    nodes_to_subscribe = []
    for key, node_str in reactor_cfg.items():
        if not key.startswith("opc_"):
            continue
        if key.endswith("_sp") or key == "opc_heartbeat":
            continue
        try:
            node = client.get_node(node_str)
            nodes_to_subscribe.append(node)
            logger.debug("Subscribing to %s (%s.%s)", node_str, reactor_id, key[4:])
        except Exception as exc:
            logger.error("Failed to get node %s: %s", node_str, exc)

    if nodes_to_subscribe:
        await subscription.subscribe_data_change(nodes_to_subscribe)
        logger.info(
            "Subscribed %d nodes for %s", len(nodes_to_subscribe), reactor_id
        )


# ── Main run loop ─────────────────────────────────────────────────────────────

async def run() -> None:
    """
    FR-01 to FR-06: Connect to OPC-UA server, establish push subscriptions for
    all reactors, and maintain connection with exponential backoff on failure.

    This coroutine runs indefinitely and is supervised by main.py.
    """
    global is_connected, _node_map

    cfg = _load_config()
    opc_cfg = cfg["opc_ua"]
    timing_cfg = cfg["timing"]
    reactors_cfg = cfg.get("reactors", {})

    endpoint: str = opc_cfg["endpoint"]
    username: str = opc_cfg["username"]
    password: str = os.environ.get("OPC_UA_PASSWORD", "")
    sub_interval_ms: int = timing_cfg.get("subscription_ms", 500)

    # Pre-build the node → (reactor_id, parameter) map used by the handler
    _node_map = _build_node_map(cfg)

    backoff_idx = 0

    while True:
        try:
            logger.info("Connecting to OPC-UA server: %s", endpoint)
            async with Client(url=endpoint) as client:
                # FR-01: authenticate with username/password
                client.set_user(username)
                client.set_password(password)
                await client.connect()

                is_connected = True
                backoff_idx = 0
                logger.info("OPC-UA connection established")

                # FR-02: create 500ms push subscription
                handler = _DataChangeHandler()
                subscription = await client.create_subscription(
                    sub_interval_ms, handler
                )

                # FR-03: subscribe all reactor measurement nodes
                for reactor_id, reactor_cfg in reactors_cfg.items():
                    await _subscribe_reactor_nodes(
                        client, reactor_id, reactor_cfg, subscription, handler
                    )

                logger.info(
                    "All subscriptions active — running push loop "
                    "(publishing interval %dms)", sub_interval_ms
                )

                # Keep the connection alive; asyncua delivers notifications
                # via the subscription callback.  We just park here.
                while True:
                    await asyncio.sleep(5)
                    # Light keepalive — asyncua handles the OPC-UA keep-alive
                    # internally; this just lets us detect a broken TCP socket
                    # via the context manager's __aexit__ on exception.

        except Exception as exc:
            is_connected = False
            # FR-06: log connection_lost and apply backoff
            logger.error("OPC-UA connection lost: %s", exc)
            wait = _BACKOFF[min(backoff_idx, len(_BACKOFF) - 1)]
            logger.info(
                "Reconnecting in %ds (attempt %d)…", wait, backoff_idx + 1
            )
            backoff_idx += 1
            await asyncio.sleep(wait)
