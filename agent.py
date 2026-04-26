"""
agent.py
========
BioReactorAgent — GPT-4o Autonomous Agent Loop
================================================
Autonomous CHO fed-batch bioreactor optimization agent.
Uses OpenAI GPT-4o with function calling (required by SCSP
Autonomous Labs track rules).

Integrates with:
  - bioreactor_simulator.py  (CHO kinetics, 4 parallel reactors)
  - ph_probe_kalman.py       (Kalman filter sensor validation)
  - api.py                   (FastAPI endpoint layer)

Run standalone:
    python agent.py

Run via dashboard:
    streamlit run dashboard.py
"""

from openai import OpenAI
import json
import os
from dotenv import load_dotenv
from datetime import datetime
from bioreactor_simulator import CHOBioreactorSimulator, THRESHOLDS
from ph_probe_kalman import PHProbeKalman

load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# ── Simulation state (shared across agent calls) ───────────────────────────────
_simulator: CHOBioreactorSimulator = None
_kalman_filters: dict = {}      # reactor_id → PHProbeKalman
_audit_log: list = []           # all agent decisions logged here
_intervention_count: int = 0

# ── Tool definitions for GPT-4o ───────────────────────────────────────────────
tools = [
    {
        "type": "function",
        "function": {
            "name": "sample_all_reactors",
            "description": (
                "Advance all bioreactors by one time step and return current "
                "probe readings for VCD, viability, glucose, lactate, pH, DO, "
                "temperature, agitation, osmolality, pCO2, and mAb titer across "
                "all parallel reactors."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_kalman_estimate",
            "description": (
                "Get the Kalman-filtered pH estimate and fault status for a "
                "specific reactor. Returns confidence score, fault type if "
                "detected, and recommendation. Use this before acting on any "
                "pH reading to validate the probe is healthy."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor ID e.g. R1, R2, R3, R4"
                    }
                },
                "required": ["reactor_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "trigger_feed",
            "description": (
                "Trigger a glucose feed bolus for a specific reactor. "
                "Use when glucose drops below 0.9 g/L (Monod threshold). "
                "Logs intervention to audit trail."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor to feed"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reasoning for this intervention"
                    }
                },
                "required": ["reactor_id", "reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "apply_temperature_shift",
            "description": (
                "Apply a deliberate temperature downshift to 33°C for a "
                "specific reactor to boost mAb specific productivity. "
                "Based on López-Meza et al. 2016: higher titer at 33°C vs 37°C. "
                "Only call once per reactor, typically around day 7."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor to apply temp shift"
                    },
                    "reason": {
                        "type": "string",
                        "description": "Reasoning for this intervention"
                    }
                },
                "required": ["reactor_id", "reason"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "flag_anomaly",
            "description": (
                "Flag a parameter exceedance or process anomaly to the audit "
                "trail with severity level and recommended corrective action. "
                "Use for any GxP threshold violation or probe fault."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reactor_id": {
                        "type": "string",
                        "description": "Reactor where anomaly was detected"
                    },
                    "parameter": {
                        "type": "string",
                        "description": "Parameter name e.g. pH, lactate, DO"
                    },
                    "value": {
                        "type": "number",
                        "description": "Current measured value"
                    },
                    "threshold": {
                        "type": "string",
                        "description": "GxP limit that was violated e.g. >1.8 g/L"
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["WARNING", "CRITICAL"],
                        "description": "Severity level"
                    },
                    "recommendation": {
                        "type": "string",
                        "description": "Recommended corrective action"
                    }
                },
                "required": [
                    "reactor_id", "parameter", "value",
                    "threshold", "severity", "recommendation"
                ]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "generate_compliance_report",
            "description": (
                "Generate a structured GxP compliance report summarizing all "
                "reactor states, anomalies detected, interventions performed, "
                "titer projections, and overall PASS/FAIL status. Call this "
                "after completing a full monitoring sweep."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "include_audit_trail": {
                        "type": "boolean",
                        "description": "Whether to include full audit trail in report",
                        "default": True
                    }
                },
                "required": []
            }
        }
    },
]


# ── Tool implementations ───────────────────────────────────────────────────────

def sample_all_reactors() -> dict:
    """Advance simulation one step and return all reactor readings."""
    global _simulator, _kalman_filters

    if _simulator is None:
        return {"error": "Simulator not initialized. Call init_simulation first."}

    readings = {}
    for rid in _simulator.states.keys():
        state = _simulator.step(rid)
        readings[rid] = {
            "reactor_id":  rid,
            "day":         round(state.day, 2),
            "strategy":    _simulator.strategies.get(rid, {}).get("label", "Unknown"),
            "VCD":         round(state.VCD, 3),
            "viability":   round(state.viability, 1),
            "glucose":     round(state.glucose, 3),
            "lactate":     round(state.lactate, 3),
            "glutamine":   round(state.glutamine, 3),
            "ammonia":     round(state.ammonia, 3),
            "pH":          round(state.pH, 3),
            "DO":          round(state.DO, 1),
            "temperature": round(state.temperature, 2),
            "agitation":   round(state.agitation, 1),
            "osmolality":  round(state.osmolality, 1),
            "pCO2":        round(state.pCO2, 1),
            "mAb_titer":   round(state.mAb_titer, 4),
            "status":      state.status,
            "anomalies":   state.anomalies,
            "feed_events": state.feed_events,
        }

    print(f"\n[SAMPLE] Day {list(readings.values())[0]['day']:.1f} — "
          f"sampled {len(readings)} reactors")
    return readings


def get_kalman_estimate(reactor_id: str) -> dict:
    """Get Kalman-filtered pH estimate and fault status for a reactor."""
    global _simulator, _kalman_filters

    if _simulator is None:
        return {"error": "Simulator not initialized."}

    if reactor_id not in _kalman_filters:
        _kalman_filters[reactor_id] = PHProbeKalman()

    state = _simulator.states.get(reactor_id)
    if state is None:
        return {"error": f"Reactor {reactor_id} not found."}

    kf = _kalman_filters[reactor_id]
    kf.predict(
        lactate=state.lactate,
        pCO2=state.pCO2,
        control_active=True
    )
    estimate, fault_flags, confidence = kf.update(state.pH)
    kf.day += 1

    result = {
        "reactor_id":      reactor_id,
        "raw_pH":          round(state.pH, 4),
        "kalman_estimate": round(float(estimate), 4),
        "confidence":      round(confidence, 3),
        "fault_detected":  len(fault_flags) > 0,
        "fault_flags":     fault_flags,
        "recommendation":  fault_flags[0]["recommendation"] if fault_flags
                           else "Probe healthy — trust measurement.",
    }

    status = "⚠️  FAULT" if fault_flags else "✓  HEALTHY"
    print(f"[KALMAN] {reactor_id} pH: raw={state.pH:.3f} → "
          f"estimate={estimate:.3f} | conf={confidence:.3f} | {status}")
    return result


def trigger_feed(reactor_id: str, reason: str) -> dict:
    """Trigger a glucose bolus feed for a reactor."""
    global _simulator, _intervention_count, _audit_log

    if _simulator is None:
        return {"error": "Simulator not initialized."}

    state = _simulator.states.get(reactor_id)
    if state is None:
        return {"error": f"Reactor {reactor_id} not found."}

    glucose_before = state.glucose
    _simulator.states[reactor_id].glucose += 2.0
    _intervention_count += 1

    entry = {
        "timestamp":      datetime.now().isoformat(),
        "day":            round(state.day, 2),
        "type":           "INTERVENTION",
        "reactor_id":     reactor_id,
        "action":         "feed_bolus",
        "glucose_before": round(glucose_before, 3),
        "glucose_after":  round(state.glucose, 3),
        "reason":         reason,
    }
    _audit_log.append(entry)

    print(f"[FEED]   {reactor_id} — glucose {glucose_before:.2f} → "
          f"{state.glucose:.2f} g/L | {reason}")
    return {
        "status":            "executed",
        "reactor_id":        reactor_id,
        "glucose_before":    round(glucose_before, 3),
        "glucose_after":     round(state.glucose, 3),
        "intervention_id":   _intervention_count,
    }


def apply_temperature_shift(reactor_id: str, reason: str) -> dict:
    """Apply temperature downshift to 33°C for a reactor."""
    global _simulator, _intervention_count, _audit_log

    if _simulator is None:
        return {"error": "Simulator not initialized."}

    state = _simulator.states.get(reactor_id)
    if state is None:
        return {"error": f"Reactor {reactor_id} not found."}

    temp_before = state.temperature
    _simulator.strategies[reactor_id]["temp_shift_day"] = int(state.day)
    _intervention_count += 1

    entry = {
        "timestamp":   datetime.now().isoformat(),
        "day":         round(state.day, 2),
        "type":        "INTERVENTION",
        "reactor_id":  reactor_id,
        "action":      "temperature_shift",
        "temp_before": round(temp_before, 2),
        "temp_target": 33.0,
        "reason":      reason,
    }
    _audit_log.append(entry)

    print(f"[TEMP]   {reactor_id} — shift {temp_before:.1f}°C → 33.0°C | {reason}")
    return {
        "status":          "executed",
        "reactor_id":      reactor_id,
        "temp_before":     round(temp_before, 2),
        "temp_target":     33.0,
        "intervention_id": _intervention_count,
    }


def flag_anomaly(reactor_id: str, parameter: str, value: float,
                 threshold: str, severity: str, recommendation: str) -> dict:
    """Flag a GxP anomaly to the audit trail."""
    global _audit_log

    entry = {
        "timestamp":      datetime.now().isoformat(),
        "type":           f"ANOMALY_{severity}",
        "reactor_id":     reactor_id,
        "parameter":      parameter,
        "value":          value,
        "threshold":      threshold,
        "severity":       severity,
        "recommendation": recommendation,
    }
    _audit_log.append(entry)

    icon = "🔴" if severity == "CRITICAL" else "⚠️ "
    print(f"[ALERT]  {icon} {reactor_id} — {parameter}={value} "
          f"(limit {threshold}) [{severity}]")
    return {"logged": True, "entry": entry}


def generate_compliance_report(include_audit_trail: bool = True) -> dict:
    """Generate a structured compliance report for the current run."""
    global _simulator, _audit_log, _intervention_count

    if _simulator is None:
        return {"error": "Simulator not initialized."}

    reactor_summaries = {}
    overall_status = "PASS"

    for rid, state in _simulator.states.items():
        anomalies = state.anomalies
        if state.status == "critical":
            overall_status = "FAIL"
        elif state.status == "warning" and overall_status == "PASS":
            overall_status = "WARNING"

        reactor_summaries[rid] = {
            "strategy":    _simulator.strategies.get(rid, {}).get("label", "Unknown"),
            "current_day": round(state.day, 1),
            "VCD":         round(state.VCD, 3),
            "viability":   round(state.viability, 1),
            "glucose":     round(state.glucose, 3),
            "lactate":     round(state.lactate, 3),
            "pH":          round(state.pH, 3),
            "DO":          round(state.DO, 1),
            "temperature": round(state.temperature, 2),
            "mAb_titer":   round(state.mAb_titer, 4),
            "status":      state.status.upper(),
            "anomalies":   anomalies,
        }

    report = {
        "report_generated":  datetime.now().isoformat(),
        "overall_status":    overall_status,
        "n_reactors":        len(_simulator.states),
        "interventions":     _intervention_count,
        "reactor_summaries": reactor_summaries,
        "titer_ranking": sorted(
            [(rid, round(s.mAb_titer, 4)) for rid, s in _simulator.states.items()],
            key=lambda x: x[1], reverse=True
        ),
    }

    if include_audit_trail:
        report["audit_trail"] = _audit_log

    print(f"\n[REPORT] Generated — overall status: {overall_status} | "
          f"{_intervention_count} interventions logged")
    return report


# ── Tool dispatcher ────────────────────────────────────────────────────────────

def dispatch_tool(name: str, arguments: dict) -> dict:
    """Route tool call from GPT-4o to the correct implementation."""
    dispatch_map = {
        "sample_all_reactors":        lambda a: sample_all_reactors(),
        "get_kalman_estimate":        lambda a: get_kalman_estimate(**a),
        "trigger_feed":               lambda a: trigger_feed(**a),
        "apply_temperature_shift":    lambda a: apply_temperature_shift(**a),
        "flag_anomaly":               lambda a: flag_anomaly(**a),
        "generate_compliance_report": lambda a: generate_compliance_report(**a),
    }
    handler = dispatch_map.get(name)
    if handler is None:
        return {"error": f"Unknown tool: {name}"}
    return handler(arguments)


# ── Agent loop ─────────────────────────────────────────────────────────────────

def init_simulation(n_reactors: int = 4, run_days: int = 14):
    """Initialize the bioreactor simulator and Kalman filters."""
    global _simulator, _kalman_filters, _audit_log, _intervention_count
    _simulator = CHOBioreactorSimulator(
        n_reactors=n_reactors,
        run_days=run_days,
        temp_shift=True
    )
    _kalman_filters = {f"R{i}": PHProbeKalman() for i in range(1, n_reactors + 1)}
    _audit_log = []
    _intervention_count = 0
    print(f"[INIT]   Simulator ready — {n_reactors} reactors, {run_days}-day run")


def run_agent(n_steps: int = 3, autonomy: str = "full_auto") -> str:
    """
    Run the autonomous agent loop for n_steps monitoring cycles.

    Each step:
    1. Agent samples all reactors
    2. Agent validates pH via Kalman filter
    3. Agent identifies anomalies and intervention opportunities
    4. Agent executes or recommends interventions
    5. Agent logs everything to audit trail
    6. Agent generates compliance report

    Parameters
    ----------
    n_steps : int
        Number of monitoring cycles to run (each advances simulation 1 day)
    autonomy : str
        'full_auto'    — agent acts without approval
        'suggest_only' — agent recommends, returns suggestions
        'monitor_only' — agent monitors and alerts only
    """
    global _simulator

    if _simulator is None:
        init_simulation()

    print(f"\n{'='*65}")
    print(f"  BioReactorAgent — {n_steps}-step monitoring sweep")
    print(f"  Autonomy: {autonomy} | Reactors: {len(_simulator.states)}")
    print(f"  Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"{'='*65}")

    system_prompt = f"""You are BioReactorAgent — an autonomous AI agent for CHO
fed-batch bioreactor optimization in a GxP-regulated pilot plant.

Your mission across {n_steps} monitoring cycles:
1. Sample all reactors each cycle using sample_all_reactors
2. Validate pH readings using get_kalman_estimate before acting on them
3. Flag any GxP threshold violations using flag_anomaly
4. Trigger feed boluses when glucose approaches 0.9 g/L (Monod threshold)
5. Apply temperature shifts around day 7 to boost mAb titer
6. After all cycles complete, generate a full compliance report

GxP Thresholds:
- pH: 6.8 – 7.2 | DO: 30 – 60% | Temperature: 36.5 – 37.5°C
- Glucose min: 0.9 g/L | Lactate max: 1.8 g/L
- VCD max: 20 ×10⁶ cells/mL | Viability min: 70%
- Osmolality max: 390 mOsm/kg | pCO2 max: 150 mmHg

Autonomy level: {autonomy}
{"Execute all decisions automatically and log to audit trail."
 if autonomy == "full_auto"
 else "Return recommendations only — do not execute interventions."}

Published kinetics reference:
- μmax = 0.043 h⁻¹ (López-Meza et al. 2016)
- Temp shift to 33°C increases titer ~25% (López-Meza et al. 2016)
- Continuous feed can achieve >10 g/L titer (PMC9843118)
- Lactate >1.8 g/L is toxic (Frontiers 2025)

Be systematic, precise, and always validate probes before intervening.
Your decisions are logged to a GxP audit trail — reason clearly."""

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": (
            f"Run {n_steps} complete monitoring cycles across all reactors. "
            f"Validate probes, detect anomalies, execute interventions as "
            f"appropriate, then generate a full compliance report."
        )}
    ]

    # ── Agentic loop ───────────────────────────────────────────────────────────
    max_iterations = n_steps * 20  # safety ceiling
    iteration = 0

    while iteration < max_iterations:
        iteration += 1

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=tools,
            tool_choice="auto",
            temperature=0.1,  # low temp for deterministic process decisions
        )

        msg = response.choices[0].message
        messages.append(msg)

        # ── Done ──────────────────────────────────────────────────────────────
        if response.choices[0].finish_reason == "stop":
            return msg.content or "Agent sweep complete."

        # ── Tool calls ────────────────────────────────────────────────────────
        if response.choices[0].finish_reason == "tool_calls":
            tool_results = []
            for tool_call in msg.tool_calls:
                name      = tool_call.function.name
                arguments = json.loads(tool_call.function.arguments)
                result    = dispatch_tool(name, arguments)
                tool_results.append({
                    "role":         "tool",
                    "tool_call_id": tool_call.id,
                    "content":      json.dumps(result),
                })
            messages.append({
                "role":    "user",
                "content": tool_results,
            })

    return "Agent reached maximum iterations — partial sweep complete."


# ── Standalone entry point ─────────────────────────────────────────────────────

if __name__ == "__main__":
    init_simulation(n_reactors=4, run_days=14)
    report_text = run_agent(n_steps=3, autonomy="full_auto")

    print(f"\n{'='*65}")
    print("  COMPLIANCE REPORT")
    print(f"{'='*65}")
    print(report_text)

    print(f"\n{'='*65}")
    print(f"  AUDIT TRAIL ({len(_audit_log)} entries)")
    print(f"{'='*65}")
    for entry in _audit_log:
        print(f"  [{entry['type']}] Day {entry.get('day', '?')} | "
              f"{entry.get('reactor_id', '')} | "
              f"{entry.get('action', entry.get('parameter', ''))}")
