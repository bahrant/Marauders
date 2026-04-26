"""
rule_engine.py
==============
BioReactorAgent — Deterministic Fast-Loop Rule Engine
=====================================================
Implements FR-12 through FR-14.

Evaluates all reactor states on a 30-second tick.  No GPT-4o involvement.
Provides sub-60s detection→write latency for threshold violations (NFR-01).

Rule table (FR-13):
─────────────────────────────────────────────────────────────────────────────
Condition                               Severity  Action
─────────────────────────────────────────────────────────────────────────────
pH < 6.8 or pH > 7.2                   Warning   set_pH_sp(reactor, 7.0)
pH < 6.5 or pH > 7.5                   Critical  flag_human — no auto-correct
DO < 30%                                Warning   set_agitation_sp(+20)
DO > 60%                                Warning   set_agitation_sp(−15)
DO < 20%                                Critical  flag_human
temperature > 37.6°C                    Warning   set_temp_sp(reactor, 37.0)
temperature > 39°C                      Critical  flag_human
lactate > 1.8 g/L                       Critical  set_feed_rate(×0.5) + flag_human
viability < 70%                         Critical  flag_human
glucose_est < 0.9 g/L (continuous)     Warning   set_feed_rate(current + 0.5)
pCO2 > 150 mmHg                         Warning   increase_stripping
osmolality > 390 mOsm/kg               Warning   set_feed_rate(×0.8)
─────────────────────────────────────────────────────────────────────────────

FR-14: For every rule that fires, an AgentLogEvent record is written to
       audit.py BEFORE the corresponding opc_writer call is made.

The set of active human flags (_human_flags) is shared with gpt_agent.py
so it can respect the 2-hour human-review guard (FR-19).

THRESHOLDS imported from bioreactor_simulator.py (copied to this directory)
to stay DRY and consistent with the simulation layer.
"""

import asyncio
import logging
import os
import time
from typing import Optional

import tomllib

import kalman
import opc_writer
from audit import AuditStore
from bioreactor_simulator import THRESHOLDS

logger = logging.getLogger("rule_engine")

# ── Module-level state ────────────────────────────────────────────────────────

_audit: Optional[AuditStore] = None
_run_id: str = "run-unknown"
_cfg: Optional[dict] = None

# Human-review flags: reactor_id → unix timestamp of flag
# Read by gpt_agent.py to implement FR-19 guard
human_flags: dict[str, float] = {}

# Per-reactor, per-rule fire-state to avoid log spam on sustained violations
# key: (reactor_id, rule_name) → last_fired_ts
_last_fired: dict[tuple[str, str], float] = {}
_MIN_REFIRE_S = 60.0   # minimum seconds between re-fires of the same rule


def configure(audit_store: AuditStore, run_id: str, cfg: dict) -> None:
    """Inject shared dependencies. Called once from main.py."""
    global _audit, _run_id, _cfg
    _audit = audit_store
    _run_id = run_id
    _cfg = cfg
    logger.info("rule_engine configured (run_id=%s)", run_id)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _should_fire(reactor_id: str, rule_name: str) -> bool:
    """Suppress re-fire of the same rule within _MIN_REFIRE_S seconds."""
    key = (reactor_id, rule_name)
    last = _last_fired.get(key, 0.0)
    if time.time() - last < _MIN_REFIRE_S:
        return False
    _last_fired[key] = time.time()
    return True


async def _audit_then_write(
    reactor_id: str,
    day: float,
    action_type: str,
    parameter: str,
    pre_value: Optional[float],
    new_value: Optional[float],
    reasoning: str,
    severity: str,
    write_coro,   # awaitable — the opc_writer call; None for flag_human
) -> None:
    """
    FR-14: Write audit entry BEFORE OPC-UA write.
    If write_coro is None (flag_human), the audit entry is still written.
    """
    if _audit is None:
        logger.error("rule_engine: audit not configured")
        return

    await _audit.write_audit(
        reactor_id, day, action_type,
        parameter=parameter,
        pre_value=pre_value,
        new_value=new_value,
        reasoning=reasoning,
        severity=severity,
        executed_by="rule_engine",
    )

    if write_coro is not None:
        await write_coro


async def _flag_human(reactor_id: str, day: float, parameter: str,
                      value: float, reason: str) -> None:
    """Record a human-review flag in audit and the shared human_flags dict."""
    human_flags[reactor_id] = time.time()
    logger.warning(
        "FLAG_HUMAN %s — %s=%s | %s", reactor_id, parameter, value, reason
    )
    await _audit_then_write(
        reactor_id, day,
        action_type="flag_human",
        parameter=parameter,
        pre_value=value,
        new_value=None,
        reasoning=reason,
        severity="critical",
        write_coro=None,
    )


# ── Rule table evaluation ─────────────────────────────────────────────────────

async def _evaluate_reactor(reactor_id: str, state: dict) -> None:
    """
    Evaluate all rules for one reactor.
    state: dict from kalman.get_state() — same shape as bioreactor_simulator._snapshot()
    """
    day       = state.get("day", 0.0)
    pH        = state.get("pH", 7.0)
    DO        = state.get("DO", 50.0)
    temp      = state.get("temperature", 37.0)
    lactate   = state.get("lactate", 0.0)
    viability = state.get("viability", 98.0)
    glucose   = state.get("glucose", 4.8)
    pCO2      = state.get("pCO2", 35.0)
    osmolality= state.get("osmolality", 300.0)
    agitation = state.get("agitation", 80.0)
    feed_rate = state.get("feed_rate", 1.0)   # L/h current, default if unknown
    strategy  = state.get("strategy", "")

    # Retrieve current feed_rate from opc_reader for accurate pre_value
    import opc_reader as _opc_reader
    current_feed = _opc_reader.get_latest(reactor_id, "feed_rate") or feed_rate
    current_agit = _opc_reader.get_latest(reactor_id, "agitation") or agitation

    # ── pH Warning: 6.8–7.2 band ─────────────────────────────────────────
    if (pH < 6.8 or pH > 7.2) and _should_fire(reactor_id, "pH_warning"):
        await _audit_then_write(
            reactor_id, day,
            action_type="ph_correction",
            parameter="pH",
            pre_value=pH,
            new_value=7.0,
            reasoning=f"pH={pH:.3f} outside operating band 6.8–7.2. Correcting setpoint to 7.0.",
            severity="warning",
            write_coro=opc_writer.set_pH_sp(
                reactor_id, 7.0,
                reasoning=f"pH={pH:.3f} — rule engine correction",
                day=day,
            ),
        )

    # ── pH Critical: 6.5–7.5 band ─────────────────────────────────────────
    if (pH < 6.5 or pH > 7.5) and _should_fire(reactor_id, "pH_critical"):
        await _flag_human(
            reactor_id, day, "pH", pH,
            f"pH={pH:.3f} outside critical limits 6.5–7.5. No auto-correct — human required."
        )

    # ── DO Warning Low: < 30% ──────────────────────────────────────────────
    if DO < 30.0 and _should_fire(reactor_id, "DO_low_warning"):
        new_agit = min(current_agit + 20.0,
                       _cfg.get("cpp_limits", {}).get("agitation_max", 400))
        await _audit_then_write(
            reactor_id, day,
            action_type="agitation_correction",
            parameter="agitation",
            pre_value=current_agit,
            new_value=new_agit,
            reasoning=f"DO={DO:.1f}% below 30%. Increasing agitation {current_agit:.0f}→{new_agit:.0f} RPM.",
            severity="warning",
            write_coro=opc_writer.set_agitation_sp(
                reactor_id, new_agit,
                reasoning=f"DO={DO:.1f}% low — rule engine",
                day=day,
            ),
        )

    # ── DO Warning High: > 60% ─────────────────────────────────────────────
    if DO > 60.0 and _should_fire(reactor_id, "DO_high_warning"):
        new_agit = max(current_agit - 15.0,
                       _cfg.get("cpp_limits", {}).get("agitation_min", 30))
        await _audit_then_write(
            reactor_id, day,
            action_type="agitation_correction",
            parameter="agitation",
            pre_value=current_agit,
            new_value=new_agit,
            reasoning=f"DO={DO:.1f}% above 60%. Reducing agitation {current_agit:.0f}→{new_agit:.0f} RPM.",
            severity="warning",
            write_coro=opc_writer.set_agitation_sp(
                reactor_id, new_agit,
                reasoning=f"DO={DO:.1f}% high — rule engine",
                day=day,
            ),
        )

    # ── DO Critical: < 20% ────────────────────────────────────────────────
    if DO < 20.0 and _should_fire(reactor_id, "DO_critical"):
        await _flag_human(
            reactor_id, day, "DO", DO,
            f"DO={DO:.1f}% critically low (<20%). Human intervention required."
        )

    # ── Temperature Warning: > 37.6°C ─────────────────────────────────────
    if temp > 37.6 and _should_fire(reactor_id, "temp_warning"):
        await _audit_then_write(
            reactor_id, day,
            action_type="temp_correction",
            parameter="temperature",
            pre_value=temp,
            new_value=37.0,
            reasoning=f"Temperature={temp:.2f}°C above 37.6°C. Correcting setpoint to 37.0°C.",
            severity="warning",
            write_coro=opc_writer.set_temp_sp(
                reactor_id, 37.0,
                reasoning=f"temp={temp:.2f}°C high — rule engine",
                day=day,
            ),
        )

    # ── Temperature Critical: > 39°C ──────────────────────────────────────
    if temp > 39.0 and _should_fire(reactor_id, "temp_critical"):
        await _flag_human(
            reactor_id, day, "temperature", temp,
            f"Temperature={temp:.2f}°C critically high (>39°C). Human intervention required."
        )

    # ── Lactate Critical: > 1.8 g/L ───────────────────────────────────────
    if lactate > THRESHOLDS["lactate"]["max"] and _should_fire(reactor_id, "lactate_critical"):
        new_feed = current_feed * 0.5
        await _audit_then_write(
            reactor_id, day,
            action_type="feed_rate_correction",
            parameter="feed_rate",
            pre_value=current_feed,
            new_value=new_feed,
            reasoning=(
                f"Lactate={lactate:.3f} g/L exceeded toxic threshold "
                f"{THRESHOLDS['lactate']['max']} g/L. "
                f"Halving feed rate {current_feed:.2f}→{new_feed:.2f} L/h."
            ),
            severity="critical",
            write_coro=opc_writer.set_feed_rate(
                reactor_id, new_feed,
                reasoning=f"lactate={lactate:.3f} g/L critical — rule engine",
                day=day,
            ),
        )
        # Also flag for human review
        await _flag_human(
            reactor_id, day, "lactate", lactate,
            f"Lactate={lactate:.3f} g/L > {THRESHOLDS['lactate']['max']} g/L — feed halved, human review needed."
        )

    # ── Viability Critical: < 70% ─────────────────────────────────────────
    if viability < THRESHOLDS["viability"]["min"] and _should_fire(reactor_id, "viability_critical"):
        await _flag_human(
            reactor_id, day, "viability", viability,
            f"Viability={viability:.1f}% below critical threshold {THRESHOLDS['viability']['min']}%."
        )

    # ── Glucose Warning (continuous strategy only): < 0.9 g/L ────────────
    if (glucose < THRESHOLDS["glucose"]["min"]
            and "continuous" in strategy.lower()
            and _should_fire(reactor_id, "glucose_continuous_warning")):
        new_feed = current_feed + 0.5
        await _audit_then_write(
            reactor_id, day,
            action_type="feed_rate_correction",
            parameter="feed_rate",
            pre_value=current_feed,
            new_value=new_feed,
            reasoning=(
                f"Glucose estimate={glucose:.3f} g/L below {THRESHOLDS['glucose']['min']} g/L "
                f"on continuous strategy. Increasing feed rate "
                f"{current_feed:.2f}→{new_feed:.2f} L/h."
            ),
            severity="warning",
            write_coro=opc_writer.set_feed_rate(
                reactor_id, new_feed,
                reasoning=f"glucose_est={glucose:.3f} g/L low — rule engine continuous",
                day=day,
            ),
        )

    # ── pCO2 Warning: > 150 mmHg ──────────────────────────────────────────
    if pCO2 > THRESHOLDS["pCO2"]["max"] and _should_fire(reactor_id, "pCO2_warning"):
        await _audit_then_write(
            reactor_id, day,
            action_type="stripping_correction",
            parameter="pCO2",
            pre_value=pCO2,
            new_value=None,
            reasoning=f"pCO2={pCO2:.1f} mmHg above {THRESHOLDS['pCO2']['max']} mmHg. Increasing CO2 stripping.",
            severity="warning",
            write_coro=opc_writer.increase_stripping(
                reactor_id,
                reasoning=f"pCO2={pCO2:.1f} mmHg — rule engine",
                day=day,
            ),
        )

    # ── Osmolality Warning: > 390 mOsm/kg ────────────────────────────────
    if osmolality > THRESHOLDS["osmolality"]["max"] and _should_fire(reactor_id, "osmolality_warning"):
        new_feed = current_feed * 0.8
        await _audit_then_write(
            reactor_id, day,
            action_type="feed_rate_correction",
            parameter="feed_rate",
            pre_value=current_feed,
            new_value=new_feed,
            reasoning=(
                f"Osmolality={osmolality:.0f} mOsm/kg above "
                f"{THRESHOLDS['osmolality']['max']} mOsm/kg. "
                f"Reducing feed rate {current_feed:.2f}→{new_feed:.2f} L/h."
            ),
            severity="warning",
            write_coro=opc_writer.set_feed_rate(
                reactor_id, new_feed,
                reasoning=f"osmolality={osmolality:.0f} — rule engine",
                day=day,
            ),
        )


# ── Main run loop ─────────────────────────────────────────────────────────────

async def run() -> None:
    """
    FR-12: Evaluate all reactor states on a 30-second tick.
    Evaluation completes synchronously within each tick.
    This coroutine runs indefinitely and is supervised by main.py.
    """
    tick_s = (_cfg or {}).get("timing", {}).get("fast_loop_s", 30)

    logger.info(
        "rule_engine started — tick=%ds, reactors=%s",
        tick_s,
        list(kalman._filters.keys()) if kalman._filters else "none yet"
    )

    while True:
        await asyncio.sleep(tick_s)

        reactor_ids = list(kalman._filters.keys())
        if not reactor_ids:
            logger.debug("rule_engine tick — no reactors initialised yet")
            continue

        for reactor_id in reactor_ids:
            state = kalman.get_state(reactor_id)
            if state is None:
                logger.debug("rule_engine: no state yet for %s", reactor_id)
                continue
            try:
                await _evaluate_reactor(reactor_id, state)
            except Exception as exc:
                logger.exception(
                    "rule_engine error evaluating %s: %s", reactor_id, exc
                )
