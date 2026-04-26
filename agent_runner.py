"""
agent_runner.py — REPLAY-MODE GPT-4.1 INTEGRATION
==================================================
Runs the BioReactorAgent in "replay mode" over a pre-computed simulator
history. Used by api.py /api/run to populate the agent_log with real
GPT-4.1 tool calls instead of derived events.

Why replay mode (not closed-loop)?
- Simulator already ran when /api/run was hit. Agent decisions logged in
  retrospect tell the same story for a demo.
- Deterministic-ish: same seed + same prompt -> similar (not identical)
  decisions every time.
- Fast: 14 GPT-4.1 calls (~$0.20-0.30 per run) vs hundreds for closed-loop.
- Demo-safe: no per-tick API latency.

What this gives you to show judges:
- "Every event in the agent_log was decided by GPT-4.1 using these 6 tools"
- Per-event reasoning strings the LLM actually wrote
- Full audit trail with model/tool/args/result for compliance story

Public entry point:
    run_agent_for_run(history: dict, run_id: str) -> list[dict]

Returns events in the same shape as api.py's _derive_agent_log:
    [{id, reactorId, day, action, reasoning, severity, parameters}, ...]
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime

from openai import OpenAI
from dotenv import load_dotenv

# Reuse tool definitions + system-prompt building from agent.py.
# We do NOT call agent.run_agent() — that runs in live mode and mutates
# the simulator. We re-implement the loop here for replay semantics.
from agent import tools as AGENT_TOOLS

load_dotenv()

# Single shared client — initialized lazily so import never fails on
# missing API key (lets api.py start up; failures show at /api/run time).
_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "OPENAI_API_KEY not set in .env — cannot run agent. "
                "Falling back to derived events."
            )
        _client = OpenAI(api_key=api_key)
    return _client


# ── Replay-mode tool dispatcher ─────────────────────────────────────────────
# Tools in agent.py mutate simulator state and step it forward. In replay
# mode the simulator has already run — we just record what the agent
# decides and feed back fake-but-plausible tool results so the LLM keeps
# reasoning. Each handler returns (tool_result_payload, optional_event).

def _handle_sample_all_reactors(args, day, snapshot):
    """Return current readings for all reactors at this simulated day."""
    payload = {rid: _compact_snap(snap, day) for rid, snap in snapshot.items()}
    return payload, None


def _handle_get_kalman_estimate(args, day, snapshot):
    """Stub Kalman result — full version comes from Bahran's real filter."""
    rid = args.get("reactor_id", "R1")
    snap = snapshot.get(rid)
    if snap is None:
        return {"error": f"Reactor {rid} not found"}, None
    payload = {
        "reactor_id":      rid,
        "raw_pH":          round(snap["pH"], 4),
        "kalman_estimate": round(snap["pH"] + 0.005, 4),  # near-passthrough
        "confidence":      0.95,
        "fault_detected":  False,
        "fault_flags":     [],
        "recommendation":  "Probe healthy — trust measurement.",
    }
    return payload, None


def _handle_trigger_feed(args, day, snapshot):
    rid = args["reactor_id"]
    reason = args.get("reason", "")
    snap = snapshot.get(rid, {})
    glucose_after = round(snap.get("glucose", 0) + 2.0, 3)
    payload = {
        "status":         "executed",
        "reactor_id":     rid,
        "glucose_before": snap.get("glucose"),
        "glucose_after":  glucose_after,
    }
    event = {
        "id":        f"evt-{uuid.uuid4().hex[:8]}",
        "reactorId": rid,
        "day":       day,
        "action":    "Bolus feed executed",
        "reasoning": reason,
        "severity":  "info",
        "parameters": {"glucose_before": snap.get("glucose"),
                       "glucose_after":  glucose_after},
    }
    return payload, event


def _handle_apply_temperature_shift(args, day, snapshot):
    rid = args["reactor_id"]
    reason = args.get("reason", "")
    snap = snapshot.get(rid, {})
    payload = {
        "status":      "executed",
        "reactor_id":  rid,
        "temp_before": snap.get("temperature"),
        "temp_target": 33.0,
    }
    event = {
        "id":        f"evt-{uuid.uuid4().hex[:8]}",
        "reactorId": rid,
        "day":       day,
        "action":    "Temperature shift initiated",
        "reasoning": reason,
        "severity":  "info",
        "parameters": {"temp_before": snap.get("temperature"),
                       "temp_target": 33.0},
    }
    return payload, event


def _handle_flag_anomaly(args, day, snapshot):
    severity_in = (args.get("severity") or "WARNING").upper()
    severity_out = "critical" if severity_in == "CRITICAL" else "warning"
    payload = {"logged": True}
    event = {
        "id":        f"evt-{uuid.uuid4().hex[:8]}",
        "reactorId": args["reactor_id"],
        "day":       day,
        "action":    f"Flagged {args.get('parameter', 'anomaly')}",
        "reasoning": args.get("recommendation", ""),
        "severity":  severity_out,
        "parameters": {args.get("parameter", "value"): args.get("value")},
    }
    return payload, event


def _handle_compliance_report(args, day, snapshot):
    return {"report_generated": datetime.now().isoformat(), "status": "ok"}, None


_HANDLERS = {
    "sample_all_reactors":        _handle_sample_all_reactors,
    "get_kalman_estimate":        _handle_get_kalman_estimate,
    "trigger_feed":               _handle_trigger_feed,
    "apply_temperature_shift":    _handle_apply_temperature_shift,
    "flag_anomaly":               _handle_flag_anomaly,
    "generate_compliance_report": _handle_compliance_report,
}


def _compact_snap(snap, day):
    """Trim simulator snapshot to fields the agent needs (saves tokens)."""
    return {
        "reactor_id": snap.get("reactor_id"),
        "day":        day,
        "strategy":   snap.get("strategy"),
        "VCD":        snap.get("VCD"),
        "viability":  snap.get("viability"),
        "glucose":    snap.get("glucose"),
        "lactate":    snap.get("lactate"),
        "ammonia":    snap.get("ammonia"),
        "pH":         snap.get("pH"),
        "DO":         snap.get("DO"),
        "temperature": snap.get("temperature"),
        "osmolality": snap.get("osmolality"),
        "pCO2":       snap.get("pCO2"),
        "mAb_titer":  snap.get("mAb_titer"),
        "status":     snap.get("status"),
    }


# ── System prompt for replay mode ───────────────────────────────────────────
SYSTEM_PROMPT = """You are BioReactorAgent — an autonomous AI agent for CHO
fed-batch bioreactor optimization in a GxP-regulated pilot plant.

You are reviewing one day's snapshot of 4 parallel reactors. For this day:
1. Examine the snapshot for any GxP threshold violations
2. For any reactor with low pH confidence concerns, call get_kalman_estimate
   to validate the probe before acting on the pH reading
3. Call trigger_feed if glucose drops near 0.9 g/L (Monod threshold)
4. Call apply_temperature_shift around day 7-8 to boost mAb titer
5. Call flag_anomaly for any GxP threshold violation (lactate >1.8, DO out
   of band, pCO2 >150, osmolality >390, viability <70%)

GxP Thresholds:
- pH: 6.8 – 7.2 | DO: 30 – 60% | Temperature: 36.5 – 37.5°C
- Glucose min: 0.9 g/L | Lactate max: 1.8 g/L
- Viability min: 70% | Osmolality max: 390 mOsm/kg | pCO2 max: 150 mmHg

Published kinetics:
- Temp shift to 33°C boosts titer ~25% (López-Meza 2016)
- Lactate >1.8 g/L is toxic (Frontiers 2025)

Be decisive. Make at most 4 tool calls per day (one per reactor that
needs intervention). Do NOT call generate_compliance_report — that's
done at the end of the run, not per day.

Your reasoning is logged to a GxP audit trail. Be precise and cite the
specific value that triggered each decision."""


def _run_one_day(day: int, snapshot: dict) -> list[dict]:
    """
    Send one day's snapshot to GPT-4.1, dispatch its tool calls, return
    the agent_log events those tool calls generated.
    """
    client = _get_client()
    events: list[dict] = []

    user_msg = (
        f"Day {day} snapshot:\n"
        f"{json.dumps({rid: _compact_snap(s, day) for rid, s in snapshot.items()}, indent=2)}\n\n"
        f"Decide what interventions are needed for day {day}. "
        f"Skip reactors that look healthy."
    )

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user",   "content": user_msg},
    ]

    # Allow up to 3 iterations per day so the agent can call kalman before
    # acting (rare but happens for borderline pH cases). Hard cap prevents
    # runaway loops.
    for iteration in range(3):
        response = client.chat.completions.create(
            model="gpt-4.1",
            messages=messages,
            tools=AGENT_TOOLS,
            tool_choice="auto",
            temperature=0.1,
        )
        choice = response.choices[0]
        msg = choice.message
        messages.append(msg)

        if choice.finish_reason == "stop" or not msg.tool_calls:
            break

        # Dispatch each tool call, capture events, feed results back
        for tool_call in msg.tool_calls:
            try:
                args = json.loads(tool_call.function.arguments)
            except json.JSONDecodeError:
                args = {}
            handler = _HANDLERS.get(tool_call.function.name)
            if handler is None:
                payload = {"error": f"unknown tool: {tool_call.function.name}"}
                event = None
            else:
                payload, event = handler(args, day, snapshot)
            if event is not None:
                events.append(event)
            messages.append({
                "role":         "tool",
                "tool_call_id": tool_call.id,
                "content":      json.dumps(payload),
            })

    return events


# ── Public entry point ─────────────────────────────────────────────────────
def run_agent_for_run(history: dict, run_id: str) -> list[dict]:
    """
    Replay the GPT-4.1 agent across the pre-computed simulator history
    and return all agent events in chronological order.

    Parameters
    ----------
    history : dict
        Output of CHOBioreactorSimulator.run_full_simulation() — a dict
        of {reactor_id: [snapshot_per_day, ...]}.
    run_id : str
        Run identifier (used for logging only, not API calls).

    Returns
    -------
    list of event dicts in the same shape as api.py's _derive_agent_log:
        [{id, reactorId, day, action, reasoning, severity, parameters}, ...]
    """
    if not history:
        return []

    # Determine number of days from first reactor's history
    first_rid = next(iter(history))
    n_days = len(history[first_rid])
    all_events: list[dict] = []

    print(f"[AGENT] {run_id}: invoking GPT-4.1 for {n_days} simulated days...")

    for day_idx in range(n_days):
        # Build the per-day snapshot: {R1: state_at_day_idx, R2: ..., ...}
        snapshot = {
            rid: snaps[day_idx]
            for rid, snaps in history.items()
            if day_idx < len(snaps)
        }
        if not snapshot:
            continue
        # Use the snapshot's own day field if present, else day_idx + 1
        day_value = snapshot[first_rid].get("day", day_idx + 1)

        try:
            day_events = _run_one_day(day_value, snapshot)
            all_events.extend(day_events)
        except Exception as e:
            print(f"[AGENT] {run_id}: day {day_value} failed: {e}")
            # On API failure, skip the day rather than aborting the whole run
            continue

    all_events.sort(key=lambda e: (e["day"], e["reactorId"]))
    print(f"[AGENT] {run_id}: GPT-4.1 produced {len(all_events)} events")
    return all_events
