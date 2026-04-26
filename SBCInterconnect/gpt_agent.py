"""
gpt_agent.py
============
BioReactorAgent — GPT-4o Strategic Decision Agent
==================================================
Implements FR-15 through FR-20.

Strategic decisions beyond the rule engine's fixed rules.
Runs at low frequency (every 30 minutes) or immediately on any Critical
severity rule engine event.

Defers to parent agent.py patterns
───────────────────────────────────
The tool schema structure, dispatch pattern, and reasoning templates in this
module follow the same conventions as the parent-directory agent.py.
Key differences from the simulator-backed parent:
  • State is read from kalman.get_state() (live EKF) instead of simulator
  • All setpoint writes route through opc_writer.py (not simulator mutation)
  • Audit entries are written to SQLite via audit.py (not in-memory list)
  • 15-second hard timeout on every API call (FR-18)
  • 2-hour human-review guard prevents writes to flagged reactors (FR-19)

Tools (FR-17):
─────────────────────────────────────────────────────────────────
Tool                        Trigger condition
─────────────────────────────────────────────────────────────────
adjust_feed_rate            glucose_est < 0.5 or VCD growth slowing
initiate_temperature_shift  VCD_est > 8e6 and day > 6, target ∈ {33,37}°C
propagate_strategy          source titer > target titer by ≥18% at same day
flag_for_human_review       parameter outside range without rule coverage
log_decision                observation — no action
─────────────────────────────────────────────────────────────────
"""

import asyncio
import json
import logging
import os
import time
from typing import Optional

import tomllib
from openai import AsyncOpenAI, APIError

import kalman
import opc_writer
import rule_engine
from audit import AuditStore

logger = logging.getLogger("gpt_agent")

# ── Module wiring ─────────────────────────────────────────────────────────────

_audit: Optional[AuditStore] = None
_run_id: str = "run-unknown"
_cfg: Optional[dict] = None
_client: Optional[AsyncOpenAI] = None

# FR-15: trigger event — set by rule_engine via trigger_immediate()
_immediate_trigger: asyncio.Event = asyncio.Event()

# Human-review guard state: reactor_id → ts of flag_for_human_review
_human_review_flags: dict[str, float] = {}

# GPT-4o API timeout (FR-18)
_GPT_TIMEOUT_S = 15.0
# Human-review guard window (FR-19)
_HUMAN_FLAG_WINDOW_S = 2 * 3600.0


def configure(audit_store: AuditStore, run_id: str, cfg: dict) -> None:
    """Inject shared dependencies. Called once from main.py."""
    global _audit, _run_id, _cfg, _client
    _audit = audit_store
    _run_id = run_id
    _cfg = cfg
    _client = AsyncOpenAI(
        api_key=os.environ.get("OPENAI_API_KEY", ""),
        timeout=_GPT_TIMEOUT_S,
    )
    logger.info("gpt_agent configured (run_id=%s)", run_id)


def trigger_immediate() -> None:
    """
    FR-15: Call from rule_engine when a Critical event fires to wake the
    GPT-4o sweep immediately instead of waiting for the 30-minute timer.
    """
    _immediate_trigger.set()


def _is_human_flagged(reactor_id: str) -> bool:
    """
    FR-19: Return True if reactor has an active flag_for_human_review within
    the last 2 hours.
    """
    ts = _human_review_flags.get(reactor_id, 0.0)
    return (time.time() - ts) < _HUMAN_FLAG_WINDOW_S


# ── GPT-4o tool definitions ───────────────────────────────────────────────────
# Follows the same schema pattern as parent agent.py tools list.

_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "adjust_feed_rate",
            "description": (
                "Adjust the glucose feed rate setpoint for a reactor. "
                "Use when glucose_est < 0.5 g/L or VCD growth is slowing. "
                "Value in L/h. Will be validated against CPP limits before write."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor ID: R1, R2, R3, or R4"
                    },
                    "rate_L_per_h": {
                        "type": "number",
                        "description": "New feed rate in L/h (CPP: 0–5)"
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Clinical reasoning for this adjustment"
                    }
                },
                "required": ["reactor_id", "rate_L_per_h", "reasoning"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "initiate_temperature_shift",
            "description": (
                "Change the temperature setpoint for a reactor. "
                "Triggered when VCD_est > 8×10⁶ and day > 6. "
                "Target must be 33°C (productivity boost per López-Meza 2016) "
                "or 37°C (growth phase). Validated against CPP limit 39°C max."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor ID: R1, R2, R3, or R4"
                    },
                    "target_temp_c": {
                        "type": "number",
                        "description": "Target temperature in °C. Must be 33 or 37."
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Clinical reasoning for temperature shift"
                    }
                },
                "required": ["reactor_id", "target_temp_c", "reasoning"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "propagate_strategy",
            "description": (
                "Copy the feed strategy label from a high-performing reactor "
                "to a lower-performing one when the source titer exceeds target "
                "titer by ≥18%% at the same run day. Logged as a recommendation — "
                "does not change OPC-UA setpoints directly."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {
                        "type": "string",
                        "description": "Reactor with higher titer"
                    },
                    "target_id": {
                        "type": "string",
                        "description": "Reactor with lower titer"
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Rationale for strategy propagation"
                    }
                },
                "required": ["source_id", "target_id", "reasoning"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "flag_for_human_review",
            "description": (
                "Flag a reactor for human review when a parameter is outside "
                "normal range without rule engine coverage, or when the "
                "situation requires operator judgment. Sets a 2-hour guard that "
                "prevents automated writes to this reactor."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor to flag"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Detailed reason requiring human review"
                    }
                },
                "required": ["reactor_id", "reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "log_decision",
            "description": (
                "Log an observation or decision note to the audit trail "
                "without taking any setpoint action. Use for reasoning that "
                "does not yet warrant intervention."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor this observation relates to"
                    },
                    "note": {
                        "type": "string",
                        "description": "Observation or decision note"
                    }
                },
                "required": ["reactor_id", "note"]
            }
        }
    },
]


# ── Tool implementations ──────────────────────────────────────────────────────
# Each implementation follows the same pattern as parent agent.py tools but
# routes through opc_writer.py and audit.py instead of simulator state.

async def _tool_adjust_feed_rate(reactor_id: str, rate_L_per_h: float,
                                  reasoning: str, day: float) -> dict:
    """FR-17/FR-20: Adjust feed rate via opc_writer."""
    if _is_human_flagged(reactor_id):
        msg = (f"adjust_feed_rate blocked — {reactor_id} has active "
               f"flag_for_human_review (FR-19 guard)")
        logger.warning(msg)
        return {"blocked": True, "reason": msg}

    success = await opc_writer.set_feed_rate(
        reactor_id, rate_L_per_h,
        reasoning=f"[gpt_agent] {reasoning}",
        day=day,
        executed_by="gpt_agent",
    )
    if _audit:
        await _audit.write_audit(
            reactor_id, day, "gpt_adjust_feed",
            parameter="feed_rate",
            new_value=rate_L_per_h,
            reasoning=reasoning,
            severity="info",
            executed_by="gpt_agent",
        )
    return {"status": "executed" if success else "failed",
            "reactor_id": reactor_id,
            "feed_rate_L_per_h": rate_L_per_h}


async def _tool_initiate_temperature_shift(reactor_id: str, target_temp_c: float,
                                            reasoning: str, day: float) -> dict:
    """FR-17/FR-20: Apply temperature shift via opc_writer."""
    if _is_human_flagged(reactor_id):
        msg = (f"initiate_temperature_shift blocked — {reactor_id} has active "
               f"flag_for_human_review (FR-19 guard)")
        logger.warning(msg)
        return {"blocked": True, "reason": msg}

    # FR-17: target must be 33 or 37°C
    if target_temp_c not in (33.0, 37.0):
        return {"error": f"target_temp_c must be 33 or 37, got {target_temp_c}"}

    success = await opc_writer.set_temp_sp(
        reactor_id, target_temp_c,
        reasoning=f"[gpt_agent] {reasoning}",
        day=day,
        executed_by="gpt_agent",
    )
    if _audit:
        await _audit.write_audit(
            reactor_id, day, "gpt_temp_shift",
            parameter="temperature",
            new_value=target_temp_c,
            reasoning=reasoning,
            severity="info",
            executed_by="gpt_agent",
        )
    return {"status": "executed" if success else "failed",
            "reactor_id": reactor_id,
            "target_temp_c": target_temp_c}


async def _tool_propagate_strategy(source_id: str, target_id: str,
                                   reasoning: str, day: float) -> dict:
    """
    FR-17: Log a strategy propagation recommendation.
    Does not change OPC-UA setpoints directly — operator implements the
    feed schedule change. Logged to audit for traceability.
    """
    state_src = kalman.get_state(source_id)
    state_tgt = kalman.get_state(target_id)

    if state_src is None or state_tgt is None:
        return {"error": "One or more reactors not found in KF state"}

    src_titer = state_src.get("mAb_titer", 0.0)
    tgt_titer = state_tgt.get("mAb_titer", 0.0)

    if tgt_titer > 0 and src_titer > 0:
        delta_pct = (src_titer - tgt_titer) / tgt_titer * 100
    else:
        delta_pct = 0.0

    if _audit:
        await _audit.write_audit(
            target_id, day, "gpt_propagate_strategy",
            parameter="strategy",
            reasoning=(
                f"Propagate strategy from {source_id} to {target_id}. "
                f"Source titer={src_titer:.4f} g/L, target titer={tgt_titer:.4f} g/L "
                f"(delta={delta_pct:.1f}%). {reasoning}"
            ),
            severity="info",
            executed_by="gpt_agent",
        )
    return {
        "recommendation_logged": True,
        "source_id": source_id,
        "target_id": target_id,
        "titer_delta_pct": round(delta_pct, 1),
    }


async def _tool_flag_for_human_review(reactor_id: str, reason: str,
                                       day: float) -> dict:
    """FR-17: Flag reactor for human review and set 2-hour guard."""
    _human_review_flags[reactor_id] = time.time()
    # Also update rule_engine's shared map for consistency
    rule_engine.human_flags[reactor_id] = time.time()

    logger.warning("FLAG_HUMAN (gpt_agent) %s — %s", reactor_id, reason)
    if _audit:
        await _audit.write_audit(
            reactor_id, day, "gpt_flag_human",
            reasoning=reason,
            severity="critical",
            executed_by="gpt_agent",
        )
    return {"flagged": True, "reactor_id": reactor_id, "reason": reason}


async def _tool_log_decision(reactor_id: str, note: str, day: float) -> dict:
    """FR-17: Log an observation to audit without action."""
    logger.info("GPT_DECISION %s — %s", reactor_id, note)
    if _audit:
        await _audit.write_audit(
            reactor_id, day, "gpt_log_decision",
            reasoning=note,
            severity="info",
            executed_by="gpt_agent",
        )
    return {"logged": True, "reactor_id": reactor_id}


# ── Tool dispatcher ───────────────────────────────────────────────────────────
# Same dispatch pattern as parent agent.py — routes name → async handler.

async def _dispatch(name: str, arguments: dict, day: float) -> dict:
    """Route GPT-4o tool call to the correct async implementation."""
    try:
        if name == "adjust_feed_rate":
            return await _tool_adjust_feed_rate(
                arguments["reactor_id"],
                float(arguments["rate_L_per_h"]),
                arguments.get("reasoning", ""),
                day,
            )
        elif name == "initiate_temperature_shift":
            return await _tool_initiate_temperature_shift(
                arguments["reactor_id"],
                float(arguments["target_temp_c"]),
                arguments.get("reasoning", ""),
                day,
            )
        elif name == "propagate_strategy":
            return await _tool_propagate_strategy(
                arguments["source_id"],
                arguments["target_id"],
                arguments.get("reasoning", ""),
                day,
            )
        elif name == "flag_for_human_review":
            return await _tool_flag_for_human_review(
                arguments["reactor_id"],
                arguments.get("reason", ""),
                day,
            )
        elif name == "log_decision":
            return await _tool_log_decision(
                arguments["reactor_id"],
                arguments.get("note", ""),
                day,
            )
        else:
            return {"error": f"Unknown tool: {name}"}
    except Exception as exc:
        logger.exception("Tool dispatch error (%s): %s", name, exc)
        return {"error": str(exc)}


# ── Context builder ───────────────────────────────────────────────────────────

def _build_context(states: dict[str, dict]) -> str:
    """
    FR-16: Build context string for GPT-4o containing per-reactor state.
    Includes: day, reactor_id, strategy, VCD_est, glucose_est, lactate,
              viability, titer_est, temperature, last 3 anomalies,
              last 3 feed_events.
    """
    lines = ["Current bioreactor states:\n"]
    for rid, state in states.items():
        anomalies = state.get("anomalies", [])[-3:]
        feeds = state.get("feed_events", [])[-3:]
        lines.append(
            f"  {rid} [{state.get('strategy', 'unknown')}] — Day {state.get('day', 0):.1f}\n"
            f"    VCD_est={state.get('VCD', 0):.3f} ×10⁶/mL  "
            f"viability={state.get('viability', 0):.1f}%\n"
            f"    glucose_est={state.get('glucose', 0):.3f} g/L  "
            f"lactate={state.get('lactate', 0):.3f} g/L\n"
            f"    titer_est={state.get('mAb_titer', 0):.4f} g/L  "
            f"temp={state.get('temperature', 37):.2f}°C\n"
            f"    pH={state.get('pH', 7):.3f}  DO={state.get('DO', 50):.1f}%  "
            f"pCO2={state.get('pCO2', 35):.0f} mmHg\n"
            f"    status={state.get('status', 'nominal').upper()}\n"
            f"    anomalies(last 3)={anomalies}\n"
            f"    feed_events(last 3)={feeds}\n"
        )
    return "\n".join(lines)


# ── Single sweep ──────────────────────────────────────────────────────────────

async def _run_sweep() -> None:
    """
    Execute one GPT-4o strategic sweep across all reactors.

    FR-18: Hard 15-second timeout on the API call.
    FR-19: Blocks adjust_feed_rate and initiate_temperature_shift for reactors
           with active flag_for_human_review within last 2 hours.
    FR-20: All tool executions route through opc_writer.py.
    """
    if _client is None or _cfg is None:
        logger.error("gpt_agent not configured")
        return

    # Collect current EKF states
    states: dict[str, dict] = {}
    max_day = 0.0
    for reactor_id in list(kalman._filters.keys()):
        s = kalman.get_state(reactor_id)
        if s:
            states[reactor_id] = s
            max_day = max(max_day, s.get("day", 0.0))

    if not states:
        logger.debug("gpt_agent sweep skipped — no EKF states available")
        return

    context_str = _build_context(states)

    system_prompt = """You are BioReactorAgent — an autonomous AI agent for CHO
fed-batch bioreactor optimization in a GxP-regulated production facility.

You are running a strategic decision sweep. The rule engine handles fast
threshold corrections every 30 seconds. Your role is strategic decisions
beyond fixed rules.

GxP Operating Thresholds:
- pH: 6.8–7.2 (warn) | 6.5–7.5 (critical)
- DO: 30–60% saturation
- Temperature: 36.5–37.5°C operating | 33°C for productivity shift
- Glucose min: 0.9 g/L (0.5 g/L triggers you)
- Lactate max: 1.8 g/L
- VCD max: 20 ×10⁶ cells/mL | Viability min: 70%
- Osmolality max: 390 mOsm/kg | pCO2 max: 150 mmHg

Decision guidelines:
- adjust_feed_rate: use when glucose_est < 0.5 g/L OR VCD growth slowing
- initiate_temperature_shift: use when VCD_est > 8×10⁶ AND day > 6
  Target must be exactly 33°C (productivity boost) or 37°C (growth)
- propagate_strategy: when source titer exceeds target by ≥18%% at same day
- flag_for_human_review: anomalies outside rule engine coverage
- log_decision: observations not yet warranting action

IMPORTANT: Do NOT call adjust_feed_rate or initiate_temperature_shift for
reactors that are blocked (tool result will show "blocked": true — respect it).

Published reference:
- μmax = 0.043 h⁻¹ (López-Meza et al. 2016)
- Temp shift to 33°C increases titer ~25%
- Continuous feed can achieve >10 g/L titer

Always reason from the data. Log your reasoning."""

    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": (
                f"Perform a strategic review of all bioreactors.\n\n"
                f"{context_str}\n\n"
                f"Identify any strategic interventions needed beyond rule engine "
                f"coverage. Execute appropriate tool calls, then log a summary decision."
            ),
        },
    ]

    # Agentic tool-call loop (same pattern as parent agent.py run_agent)
    max_iterations = 20
    iteration = 0

    while iteration < max_iterations:
        iteration += 1
        try:
            # FR-18: 15-second hard timeout via AsyncOpenAI(timeout=_GPT_TIMEOUT_S)
            response = await _client.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                tools=_TOOLS,
                tool_choice="auto",
                temperature=0.1,
            )
        except asyncio.TimeoutError:
            logger.warning("gpt_agent: API call timed out after %ss — sweep aborted", _GPT_TIMEOUT_S)
            if _audit:
                await _audit.write_audit(
                    "ALL", max_day, "gpt_unavailable",
                    reasoning=f"GPT-4o API call timed out after {_GPT_TIMEOUT_S}s",
                    severity="warning",
                    executed_by="gpt_agent",
                )
            return
        except APIError as exc:
            logger.warning("gpt_agent: APIError — %s — sweep aborted", exc)
            if _audit:
                await _audit.write_audit(
                    "ALL", max_day, "gpt_unavailable",
                    reasoning=f"GPT-4o APIError: {exc}",
                    severity="warning",
                    executed_by="gpt_agent",
                )
            return

        msg = response.choices[0].message
        messages.append(msg)

        # Done
        if response.choices[0].finish_reason == "stop":
            logger.info("gpt_agent sweep complete — %s", (msg.content or "")[:120])
            break

        # Tool calls
        if response.choices[0].finish_reason == "tool_calls" and msg.tool_calls:
            tool_results = []
            for tc in msg.tool_calls:
                name = tc.function.name
                args = json.loads(tc.function.arguments)
                logger.info("gpt_agent tool_call: %s(%s)", name, args)
                result = await _dispatch(name, args, max_day)
                tool_results.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(result),
                })
            messages.extend(tool_results)

    else:
        logger.warning("gpt_agent reached max iterations without stop")


# ── Main run loop ─────────────────────────────────────────────────────────────

async def run() -> None:
    """
    FR-15: Run sweep every 30 minutes, or immediately when triggered by a
    Critical rule engine event via trigger_immediate().

    This coroutine runs indefinitely and is supervised by main.py.
    """
    gpt_loop_min = (_cfg or {}).get("timing", {}).get("gpt_loop_min", 30)
    gpt_loop_s = gpt_loop_min * 60
    logger.info("gpt_agent started — sweep interval=%dmin", gpt_loop_min)

    while True:
        # Wait for either the timer OR an immediate trigger
        try:
            await asyncio.wait_for(
                _immediate_trigger.wait(),
                timeout=gpt_loop_s,
            )
            triggered_by = "critical_event"
        except asyncio.TimeoutError:
            triggered_by = "timer"

        _immediate_trigger.clear()
        logger.info("gpt_agent sweep starting (trigger=%s)", triggered_by)

        try:
            await _run_sweep()
        except Exception as exc:
            logger.exception("gpt_agent sweep error: %s", exc)
            if _audit:
                try:
                    await _audit.write_audit(
                        "ALL", 0.0, "gpt_unavailable",
                        reasoning=f"Sweep exception: {exc}",
                        severity="warning",
                        executed_by="gpt_agent",
                    )
                except Exception:
                    pass
