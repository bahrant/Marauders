"""
api.py — BioReactorAgent backend API

Two layers of endpoints:

[Playback API — new]   Caches a full simulation server-side, frontend ticks
                        through it for live-feeling demo playback.
    POST /api/run                            create a run, returns run_id
    GET  /api/run/<run_id>/snapshot?day=X    all reactors at day X
    GET  /api/run/<run_id>/timeseries?up_to_day=X
    GET  /api/run/<run_id>/agent_log?up_to_day=X
    GET  /api/runs                           list active runs

[Legacy API — kept for backward compat with joint.js demo + existing tests]
    GET  /api/health
    POST /api/simulate
    GET  /api/readings
    POST /api/step
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import random
import re
import uuid
import traceback
from datetime import datetime
from bioreactor_simulator import CHOBioreactorSimulator

app = Flask(__name__)
CORS(app)  # allow frontend on localhost:5173

# ─── In-memory run cache ─────────────────────────────────────────────────────
# run_id → {config, history, summary, agent_log, created_at}
RUNS = {}

# Legacy global simulator for /api/simulate /api/readings /api/step
_legacy_simulator = None


# ─── Agent log derivation ────────────────────────────────────────────────────
def _derive_agent_log(history):
    """
    Turn raw simulator history (anomalies + feed events per snapshot) into
    an agent-style activity log. Each (reactor, parameter, type) pair fires
    once at first occurrence — mimics real agent behavior of flagging,
    intervening, then monitoring instead of re-flagging every tick.
    """
    events = []
    seen_feeds = set()
    seen_anomalies = set()

    # Reasoning templates for nicer agent-voice strings
    def _reason_glucose_low(v, lim):
        return (f"Glucose at {v} g/L, below floor {lim}. "
                f"Triggering bolus feed to restore growth substrate.")

    def _reason_lactate_high(v, lim):
        return (f"Lactate {v} g/L exceeding toxic threshold {lim}. "
                f"Reducing feed rate, monitoring for metabolic shift.")

    def _reason_ph(v, lim):
        return (f"pH at {v}, outside operating band {lim}. "
                f"Adjusting CO2 sparge / base addition.")

    def _reason_do(v, lim):
        return (f"DO at {v}% sat ({lim} target). "
                f"Modulating agitation and O2 overlay.")

    def _reason_temp(v, lim):
        return (f"Temperature {v}°C, outside band {lim}. "
                f"Adjusting jacket setpoint.")

    def _reason_pco2(v, lim):
        return (f"pCO2 at {v} mmHg above ceiling {lim}. "
                f"Increasing stripping, reviewing scale-up effects.")

    def _reason_viability(v, lim):
        return (f"Viability dropped to {v}%, below {lim}. "
                f"Flagging culture health, recommending harvest review.")

    def _reason_osmo(v, lim):
        return (f"Osmolality {v} mOsm/kg above ceiling {lim}. "
                f"Reducing feed volume to limit osmotic stress.")

    def _reason_default(p, v, lim):
        return f"{p} = {v} (limit {lim}). Logging excursion."

    REASON = {
        "glucose":     _reason_glucose_low,
        "lactate":     _reason_lactate_high,
        "pH":          _reason_ph,
        "DO":          _reason_do,
        "temperature": _reason_temp,
        "pCO2":        _reason_pco2,
        "viability":   _reason_viability,
        "osmolality":  _reason_osmo,
    }

    # Feed events: simulator stores them in an accumulating list shared across
    # all snapshots (every snapshot's feed_events field references the final
    # full list). So we can't trust snap['day'] for feed timing — parse the
    # day out of the feed string itself ("Day 3: Bolus feed..."). For each
    # reactor, take the union of all feed strings ever observed.
    feed_re = re.compile(r"Day\s+(\d+)\s*:")
    for rid, snapshots in history.items():
        feed_strings = set()
        for snap in snapshots:
            feed_strings.update(snap.get("feed_events", []) or [])
        for fe in sorted(feed_strings, key=lambda s: (int(feed_re.match(s).group(1)) if feed_re.match(s) else 999)):
            m = feed_re.match(fe)
            actual_day = float(m.group(1)) if m else 0.0
            events.append({
                "id": f"evt-{uuid.uuid4().hex[:8]}",
                "reactorId": rid,
                "day": actual_day,
                "action": "Bolus feed executed" if "Bolus" in fe else "Continuous feed triggered",
                "reasoning": fe,
                "severity": "info",
                "parameters": {},
            })

    # Anomalies + temp shifts: snap['day'] IS reliable here because the
    # simulator reassigns state.anomalies = [] at the start of each step, so
    # historical snapshots keep their own anomaly snapshots intact.
    for rid, snapshots in history.items():
        for snap in snapshots:
            day = snap["day"]

            # Temperature shift events — first time temp drops below 35°C
            if snap.get("temperature", 37.0) < 35.0:
                key = (rid, "temp_shift", "scheduled")
                if key not in seen_anomalies:
                    seen_anomalies.add(key)
                    events.append({
                        "id": f"evt-{uuid.uuid4().hex[:8]}",
                        "reactorId": rid,
                        "day": day,
                        "action": "Temperature shift initiated",
                        "reasoning": (f"Setpoint changed 37°C → 33°C per protocol "
                                      f"(boosts specific productivity per López-Meza 2016)."),
                        "severity": "info",
                        "parameters": {"temperature": snap["temperature"]},
                    })

            # Anomaly detections — first occurrence per (parameter, type)
            for anom in snap.get("anomalies", []):
                key = (rid, anom["parameter"], anom["type"])
                if key in seen_anomalies:
                    continue
                seen_anomalies.add(key)

                reason_fn = REASON.get(anom["parameter"])
                if reason_fn:
                    reasoning = reason_fn(anom["value"], anom["limit"])
                else:
                    reasoning = _reason_default(anom["parameter"], anom["value"], anom["limit"])

                events.append({
                    "id": f"evt-{uuid.uuid4().hex[:8]}",
                    "reactorId": rid,
                    "day": day,
                    "action": f"Flagged {anom['parameter']} {anom['type'].replace('_', ' ')}",
                    "reasoning": reasoning,
                    "severity": "critical" if anom["severity"] == "CRITICAL" else "warning",
                    "parameters": {anom["parameter"]: anom["value"]},
                })

    # Sort by simulated day so the agent feed reads chronologically
    events.sort(key=lambda e: (e["day"], e["reactorId"]))
    return events


# ─── Health ──────────────────────────────────────────────────────────────────
@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "healthy",
        "service": "bioreactor-agent-api",
        "version": "2.0.0",
        "active_runs": len(RUNS),
        "timestamp": datetime.now().isoformat(),
    })


# ─── Playback API ────────────────────────────────────────────────────────────
@app.route("/api/run", methods=["POST"])
def create_run():
    """
    Create a new simulation run. Runs full simulation server-side and caches
    history + derived agent log keyed by run_id. Frontend polls snapshot/
    timeseries/agent_log endpoints to play it back.

    Accepts the same JSON config as /api/simulate (backward compatible).
    Returns:
      { success, run_id, run_days, n_reactors, reactor_ids, summary, created_at }
    """
    data = request.get_json() or {}

    n_reactors = int(data.get("n_reactors", 4))
    run_days   = int(data.get("run_days", 14))
    temp_shift = bool(data.get("temperatureShift", data.get("temp_shift", True)))
    seed       = data.get("seed", 42)

    random.seed(int(seed))

    try:
        sim = CHOBioreactorSimulator(n_reactors=n_reactors, run_days=run_days, temp_shift=temp_shift)
        history   = sim.run_full_simulation()
        summary   = sim.get_titer_summary()
        agent_log = _derive_agent_log(history)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e), "traceback": traceback.format_exc()}), 500

    run_id = f"run_{uuid.uuid4().hex[:8]}"
    RUNS[run_id] = {
        "run_id":     run_id,
        "config":     {"n_reactors": n_reactors, "run_days": run_days,
                       "temp_shift": temp_shift, "seed": seed},
        "history":    history,
        "summary":    summary,
        "agent_log":  agent_log,
        "created_at": datetime.now().isoformat(),
    }

    return jsonify({
        "success":     True,
        "run_id":      run_id,
        "run_days":    run_days,
        "n_reactors":  n_reactors,
        "reactor_ids": list(history.keys()),
        "summary":     summary,
        "agent_log_total": len(agent_log),
        "created_at":  RUNS[run_id]["created_at"],
    })


@app.route("/api/run/<run_id>/snapshot", methods=["GET"])
def get_snapshot(run_id):
    """Return all reactor states at simulated `day` (snaps to nearest prior day)."""
    if run_id not in RUNS:
        return jsonify({"success": False, "error": "Run not found"}), 404

    day = float(request.args.get("day", 0))
    history = RUNS[run_id]["history"]

    snaps_at_day = {}
    for rid, snaps in history.items():
        chosen = None
        for s in snaps:
            if s["day"] <= day:
                chosen = s
            else:
                break
        if chosen is None and snaps:
            chosen = snaps[0]
        snaps_at_day[rid] = chosen

    return jsonify({
        "success":   True,
        "run_id":    run_id,
        "day":       day,
        "snapshots": snaps_at_day,
    })


@app.route("/api/run/<run_id>/timeseries", methods=["GET"])
def get_timeseries(run_id):
    """Return time series data for all reactors from day 0 to up_to_day."""
    if run_id not in RUNS:
        return jsonify({"success": False, "error": "Run not found"}), 404

    up_to_day = float(request.args.get("up_to_day", 999))
    history = RUNS[run_id]["history"]
    ts = {rid: [s for s in snaps if s["day"] <= up_to_day] for rid, snaps in history.items()}

    return jsonify({
        "success":    True,
        "run_id":     run_id,
        "up_to_day":  up_to_day,
        "timeseries": ts,
    })


@app.route("/api/run/<run_id>/agent_log", methods=["GET"])
def get_agent_log(run_id):
    """Return agent activity events that occurred up to up_to_day (chronological)."""
    if run_id not in RUNS:
        return jsonify({"success": False, "error": "Run not found"}), 404

    up_to_day = float(request.args.get("up_to_day", 999))
    log = RUNS[run_id]["agent_log"]

    return jsonify({
        "success":   True,
        "run_id":    run_id,
        "up_to_day": up_to_day,
        "events":    [e for e in log if e["day"] <= up_to_day],
    })


@app.route("/api/runs", methods=["GET"])
def list_runs():
    return jsonify({
        "success": True,
        "runs": [
            {
                "run_id":      r["run_id"],
                "config":      r["config"],
                "created_at":  r["created_at"],
                "reactor_ids": list(r["history"].keys()),
                "agent_events": len(r["agent_log"]),
            }
            for r in RUNS.values()
        ],
    })


# ─── Legacy endpoints (backward compatibility) ──────────────────────────────
@app.route("/api/simulate", methods=["POST"])
def simulate():
    """Run a one-shot simulation, return full history + summary (no run_id)."""
    global _legacy_simulator
    data = request.get_json() or {}

    n_reactors = int(data.get("n_reactors", 4))
    run_days   = int(data.get("run_days", 14))
    temp_shift = bool(data.get("temperatureShift", data.get("temp_shift", True)))
    seed       = data.get("seed")

    if seed is not None:
        random.seed(int(seed))

    try:
        _legacy_simulator = CHOBioreactorSimulator(
            n_reactors=n_reactors, run_days=run_days, temp_shift=temp_shift,
        )
        history = _legacy_simulator.run_full_simulation()
        summary = _legacy_simulator.get_titer_summary()
        readings = _legacy_simulator.get_current_readings()
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e),
                        "traceback": traceback.format_exc()}), 500

    return jsonify({
        "success":          True,
        "simulation_id":    f"sim_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        "parameters":       {"n_reactors": n_reactors, "run_days": run_days,
                             "temp_shift": temp_shift, "seed": seed},
        "summary":          summary,
        "current_readings": readings,
        "history":          history,
        "metadata": {
            "total_steps": run_days * n_reactors,
            "model":       "CHO Fed-Batch mAb Production (López-Meza 2016 + industrial qP scaling)",
            "timestamp":   datetime.now().isoformat(),
        },
    })


@app.route("/api/readings", methods=["GET"])
def get_readings():
    global _legacy_simulator
    if _legacy_simulator is None:
        try:
            _legacy_simulator = CHOBioreactorSimulator(n_reactors=4, run_days=14)
            _legacy_simulator.run_full_simulation()
        except Exception as e:
            traceback.print_exc()
            return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({
        "success":          True,
        "current_readings": _legacy_simulator.get_current_readings(),
        "timestamp":        datetime.now().isoformat(),
    })


@app.route("/api/step", methods=["POST"])
def step_simulation():
    global _legacy_simulator
    data = request.get_json() or {}
    reactor_id = data.get("reactor_id", "R1")

    if _legacy_simulator is None:
        try:
            _legacy_simulator = CHOBioreactorSimulator(n_reactors=4, run_days=14)
            _legacy_simulator.run_full_simulation()
        except Exception as e:
            traceback.print_exc()
            return jsonify({"success": False, "error": str(e)}), 500

    try:
        state    = _legacy_simulator.step(reactor_id)
        snapshot = _legacy_simulator._snapshot(state)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

    return jsonify({
        "success":    True,
        "reactor_id": reactor_id,
        "state":      snapshot,
        "timestamp":  datetime.now().isoformat(),
    })


if __name__ == "__main__":
    print("Starting BioReactor Agent API on http://localhost:5000")
    print("Playback endpoints:")
    print("  POST /api/run")
    print("  GET  /api/run/<run_id>/snapshot?day=X")
    print("  GET  /api/run/<run_id>/timeseries?up_to_day=X")
    print("  GET  /api/run/<run_id>/agent_log?up_to_day=X")
    print("  GET  /api/runs")
    print("Legacy: /api/health /api/simulate /api/readings /api/step")
    print("CORS enabled for localhost frontend.")
    app.run(host="0.0.0.0", port=5001, debug=True)
