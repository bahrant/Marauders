"""
opc_writer.py
=============
BioReactorAgent — Validated OPC-UA Setpoint Write Exit Point
=============================================================
Implements FR-21 through FR-25.

The ONLY module that writes OPC-UA nodes.  No other module writes directly.
All rule_engine and gpt_agent setpoint changes route through this module.

Write pipeline for every call:
  1. Resolve target node path from config.toml [reactors.RN]  (FR-21)
  2. Validate value against [cpp_limits]  (FR-22)
     → Out of bounds: log constraint_block to audit, return (no write)
  3. Read pre_value via opc_reader.get_latest()  (FR-23)
  4. Check opc_reader.is_connected  (FR-24)
     → Disconnected: log write_skipped_disconnected, return (no exception)
  5. Write via asyncua node.write_value()
  6. Record OPC-UA server response status in audit  (FR-25)
     → Bad_NotWritable: log write_rejected

Public helpers (called by rule_engine.py and gpt_agent.py):
    set_pH_sp(reactor_id, value)
    set_temp_sp(reactor_id, value)
    set_agitation_sp(reactor_id, value)
    set_feed_rate(reactor_id, value)
    increase_stripping(reactor_id)   # increments CO2 stripping setpoint

All helpers are thin wrappers around the single write() coroutine.
"""

import logging
import os
from typing import Optional

import tomllib
from asyncua import Client, ua

import opc_reader
from audit import AuditStore

logger = logging.getLogger("opc_writer")

# ── Module wiring (injected by main.py before any writes) ────────────────────

_audit: Optional[AuditStore] = None
_run_id: str = "run-unknown"
_cfg: Optional[dict] = None
_client: Optional[Client] = None


def configure(audit_store: AuditStore, run_id: str, client: Client) -> None:
    """
    Wire opc_writer to the shared audit store and asyncua client.
    Called once from main.py after both are initialised.
    """
    global _audit, _run_id, _client, _cfg
    _audit = audit_store
    _run_id = run_id
    _client = client
    _cfg = _load_config()
    logger.info("opc_writer configured (run_id=%s)", run_id)


def _load_config() -> dict:
    config_path = os.path.join(os.path.dirname(__file__), "config.toml")
    with open(config_path, "rb") as f:
        return tomllib.load(f)


# ── CPP limit validation ──────────────────────────────────────────────────────

# Map canonical parameter names → config key(s) in [cpp_limits]
_CPP_MAP: dict[str, tuple[Optional[str], Optional[str]]] = {
    "pH":         ("pH_min",        "pH_max"),
    "temperature":("temp_min",      "temp_max"),
    "agitation":  ("agitation_min", "agitation_max"),
    "DO":         ("do_min",        "do_max"),
    "feed_rate":  ("feed_rate_min", "feed_rate_max"),
}


def _check_cpp(parameter: str, value: float, cpp: dict) -> tuple[bool, str]:
    """
    FR-22: Validate value against [cpp_limits].
    Returns (valid: bool, reason: str).
    """
    keys = _CPP_MAP.get(parameter)
    if keys is None:
        return True, ""   # parameter not in CPP map — allow through

    lo_key, hi_key = keys
    if lo_key and lo_key in cpp:
        lo = cpp[lo_key]
        if value < lo:
            return False, f"{parameter}={value} below CPP minimum {lo}"
    if hi_key and hi_key in cpp:
        hi = cpp[hi_key]
        if value > hi:
            return False, f"{parameter}={value} above CPP maximum {hi}"
    return True, ""


# ── Core write coroutine ──────────────────────────────────────────────────────

async def write(
    reactor_id: str,
    parameter: str,
    value: float,
    *,
    reasoning: str = "",
    severity: str = "info",
    executed_by: str = "opc_writer",
    day: float = 0.0,
) -> bool:
    """
    FR-21 to FR-25: Validated OPC-UA setpoint write.

    Parameters
    ----------
    reactor_id : str    e.g. "R1"
    parameter  : str    canonical name — must match a key in [reactors.RN]
                        via opc_<parameter>_sp (e.g. "pH" → "opc_pH_sp")
    value      : float  engineering units
    reasoning  : str    human-readable reason (logged to audit)
    severity   : str    audit entry severity
    executed_by: str    "rule_engine" | "gpt_agent" | "heartbeat"
    day        : float  current simulated/real run day (for audit)

    Returns True if the write was sent to the DCS, False otherwise.
    """
    if _cfg is None or _audit is None or _client is None:
        logger.error("opc_writer.write called before configure()")
        return False

    cpp_limits = _cfg.get("cpp_limits", {})
    reactors_cfg = _cfg.get("reactors", {})
    reactor_cfg = reactors_cfg.get(reactor_id, {})

    # ── FR-21: Resolve node path ──────────────────────────────────────────
    node_key = f"opc_{parameter}_sp"
    node_str = reactor_cfg.get(node_key)
    if node_str is None:
        logger.warning(
            "No OPC-UA node configured for %s.%s (key=%s)",
            reactor_id, parameter, node_key
        )
        return False

    # ── FR-22: CPP validation ──────────────────────────────────────────────
    valid, reason = _check_cpp(parameter, value, cpp_limits)
    if not valid:
        logger.warning("constraint_block %s.%s=%s — %s", reactor_id, parameter, value, reason)
        await _audit.write_audit(
            reactor_id, day, "constraint_block",
            parameter=parameter,
            new_value=value,
            reasoning=reason,
            severity="warning",
            executed_by=executed_by,
        )
        return False

    # ── FR-23: Read pre_value ──────────────────────────────────────────────
    pre_value = opc_reader.get_latest(reactor_id, parameter)

    # ── FR-24: Check connection ────────────────────────────────────────────
    if not opc_reader.is_connected:
        logger.warning(
            "write_skipped_disconnected %s.%s=%s", reactor_id, parameter, value
        )
        await _audit.write_audit(
            reactor_id, day, "write_skipped_disconnected",
            parameter=parameter,
            pre_value=pre_value,
            new_value=value,
            reasoning="OPC-UA client disconnected — write suppressed",
            severity="warning",
            executed_by=executed_by,
        )
        return False

    # ── FR-25: Write and record response status ───────────────────────────
    status_code_name = "unknown"
    try:
        node = _client.get_node(node_str)
        dv = ua.DataValue(ua.Variant(value, ua.VariantType.Float))
        result = await node.write_value(dv)

        # asyncua returns a StatusCode or list of StatusCodes
        if isinstance(result, list):
            sc = result[0] if result else None
        else:
            sc = result

        if sc is not None:
            status_code_name = sc.name if hasattr(sc, "name") else str(sc)
            if "NotWritable" in status_code_name or "BadNot" in status_code_name:
                logger.warning(
                    "write_rejected %s.%s=%s — server returned %s",
                    reactor_id, parameter, value, status_code_name
                )
                await _audit.write_audit(
                    reactor_id, day, "write_rejected",
                    parameter=parameter,
                    pre_value=pre_value,
                    new_value=value,
                    reasoning=f"OPC-UA server rejected write: {status_code_name}",
                    severity="warning",
                    executed_by=executed_by,
                )
                return False
        else:
            status_code_name = "Good"

    except Exception as exc:
        logger.error(
            "OPC-UA write error %s.%s=%s: %s", reactor_id, parameter, value, exc
        )
        await _audit.write_audit(
            reactor_id, day, "write_error",
            parameter=parameter,
            pre_value=pre_value,
            new_value=value,
            reasoning=str(exc),
            severity="critical",
            executed_by=executed_by,
        )
        return False

    # Success — write audit entry
    await _audit.write_audit(
        reactor_id, day, f"{parameter}_setpoint_write",
        parameter=parameter,
        pre_value=pre_value,
        new_value=value,
        reasoning=f"{reasoning} [OPC status: {status_code_name}]",
        severity=severity,
        executed_by=executed_by,
    )
    logger.info(
        "WRITE %s.%s: %s → %s (%s)",
        reactor_id, parameter, pre_value, value, status_code_name
    )
    return True


# ── Public helper methods (called by rule_engine and gpt_agent) ───────────────

async def set_pH_sp(reactor_id: str, value: float, *,
                    reasoning: str = "", day: float = 0.0,
                    executed_by: str = "rule_engine") -> bool:
    """Write pH setpoint."""
    return await write(
        reactor_id, "pH", value,
        reasoning=reasoning, day=day, executed_by=executed_by
    )


async def set_temp_sp(reactor_id: str, value: float, *,
                      reasoning: str = "", day: float = 0.0,
                      executed_by: str = "rule_engine") -> bool:
    """Write temperature setpoint."""
    return await write(
        reactor_id, "temperature", value,
        reasoning=reasoning, day=day, executed_by=executed_by
    )


async def set_agitation_sp(reactor_id: str, value: float, *,
                            reasoning: str = "", day: float = 0.0,
                            executed_by: str = "rule_engine") -> bool:
    """Write agitation setpoint."""
    return await write(
        reactor_id, "agitation", value,
        reasoning=reasoning, day=day, executed_by=executed_by
    )


async def set_feed_rate(reactor_id: str, value: float, *,
                        reasoning: str = "", day: float = 0.0,
                        executed_by: str = "rule_engine") -> bool:
    """Write feed rate setpoint (L/h)."""
    return await write(
        reactor_id, "feed_rate", value,
        reasoning=reasoning, day=day, executed_by=executed_by
    )


async def increase_stripping(reactor_id: str, *,
                              increment: float = 5.0,
                              reasoning: str = "pCO2 elevated — increasing stripping",
                              day: float = 0.0,
                              executed_by: str = "rule_engine") -> bool:
    """
    Increase CO2 stripping by bumping the sparge/overlay flow setpoint.
    Uses the current agitation setpoint as a proxy if a dedicated stripping
    node is not configured — extend config.toml with opc_stripping_sp to override.
    """
    if _cfg is None:
        return False
    reactor_cfg = _cfg.get("reactors", {}).get(reactor_id, {})

    # Prefer a dedicated stripping setpoint node if configured
    if "opc_stripping_sp" in reactor_cfg:
        current = opc_reader.get_latest(reactor_id, "stripping") or 20.0
        return await write(
            reactor_id, "stripping", current + increment,
            reasoning=reasoning, day=day, executed_by=executed_by
        )
    else:
        # Fallback: increase agitation (improves CO2 outgassing per DIN spec)
        current = opc_reader.get_latest(reactor_id, "agitation") or 80.0
        new_val = min(current + increment, _cfg.get("cpp_limits", {}).get("agitation_max", 400))
        return await set_agitation_sp(
            reactor_id, new_val,
            reasoning=f"{reasoning} (agitation proxy for stripping)",
            day=day, executed_by=executed_by,
        )
