# BioReactorAgent

**SCSP AI+ Hackathon 2026 — Autonomous Labs track — Team Marauders**

An autonomous AI agent for CHO fed-batch monoclonal antibody production. GPT-4.1 makes process control decisions across 4 parallel bioreactors, validated by a Kalman-filtered probe layer, all driven by a calibrated kinetic simulator and surfaced through a live React + JointJS+ SCADA dashboard. **Production-grade edge compute stack** (Orange Pi Zero 2 + OPC-UA) bridges the demo to real plant hardware.

## Team

| Member | Role |
|---|---|
| Saheb Ajmani | Bioprocess kinetics, agent integration, backend API |
| Bahran Temesgen | OPC-UA + SBC edge stack, EKF state estimator, Kalman fault detection, P&ID SCADA |
| Jayani Tripathi | React dashboard, lab setup builder, frontend architecture |

## Track

**Autonomous Laboratories.** We picked the "AI agent that automates a piece of the scientific process" prompt. Our piece: pilot-plant CHO fed-batch monitoring and intervention — the work a process engineer does by walking lab benches at 7am every day.

## What we built

A four-layer system that takes a real workflow (manual fed-batch monitoring) and replaces the human-in-the-loop with a GPT-4.1 agent making auditable decisions. Designed to run in two modes: **simulation mode** (this demo) and **production mode** (real plant via OPC-UA, all code in `SBCInterconnect/`).

### Layer 1 — Calibrated bioreactor simulator
- Monod growth kinetics + Luedeking-Piret antibody production, calibrated to López-Meza et al. 2016 (r-CHO research clone) with industrial high-producer scaling
- 4 parallel reactors running 4 strategies: control / temp shift / continuous feed / continuous + shift
- Death phase driven by viability decline, lactate inhibition, ammonia toxicity, senescence past day 8
- Final titers: R1 (control) 1.91 g/L, R4 (best strategy) 2.37 g/L — **1.24× improvement** in our calibrated model, directionally consistent with literature

### Layer 2 — GPT-4.1 autonomous agent
- 6 tools: `sample_all_reactors`, `get_kalman_estimate`, `trigger_feed`, `apply_temperature_shift`, `flag_anomaly`, `generate_compliance_report`
- Replay-mode execution: agent reviews each simulated day's snapshot and decides interventions
- Every decision logged with the LLM's natural-language reasoning (cites specific values, references published kinetics, justifies threshold violations)
- Graceful fallback to rule-based event derivation if API unavailable — demo never breaks

### Layer 3 — Production edge compute stack (`SBCInterconnect/`)
The simulator demonstrates *what* the agent does. The SBC stack demonstrates *how it deploys to real hardware*. ~3000 lines of production Python designed for an Orange Pi Zero 2 connected to a real DCS:

- **`opc_reader.py`** — `asyncua.Client` with username/password auth, 500 ms push-notification subscriptions to plant tags (pH, DO, temperature, agitation, off-gas CO₂/O₂). Reconnect backoff 1→2→4→8→16→60 s. No polling.
- **`opc_writer.py`** — single validated exit point for setpoint writes. Validates against `[cpp_limits]` from `config.toml`, captures `pre_value` via `get_latest()`, logs to audit *before* writing, handles `Bad_NotWritable` server responses.
- **`kalman.py`** — Extended Kalman Filter with state vector `[VCD, glucose, lactate, glutamine, ammonia, mAb_titer]`. Process model from the bioreactor ODE system. Numerical Jacobian via finite differences. **CER-based glucose soft sensor** uses off-gas CO₂ to estimate glucose continuously between offline assays (every 4-24h). RQ = 1.0 for CHO on glucose.
- **`rule_engine.py`** — deterministic 30-second tick. 11 threshold-driven rules with explicit corrective actions (e.g. `pH < 6.8 → set_pH_sp(7.0)`, `lactate > 1.8 → halve feed rate + flag_human`). Audit row written before any OPC-UA call (NFR-02).
- **`gpt_agent.py`** — strategic GPT-4 layer above the rule engine. 30-min sweep + immediate trigger on critical rule events. 5 tools (`adjust_feed_rate`, `initiate_temperature_shift`, `propagate_strategy`, `flag_for_human_review`, `log_decision`). 15-second hard timeout, suppresses actions on reactors with active human-review flags within last 2 hours.
- **`audit.py`** — append-only `aiosqlite` SQLite store at `/opt/bioreactor-agent/data/audit.db`. Two tables (`snapshots`, `audit_log`), no DELETE accessible to app code. GxP-compliant.
- **`heartbeat.py`** — dual independent watchdog: systemd `WATCHDOG=1` every ≤30 s + OPC-UA heartbeat node every 15 s for the DCS to monitor agent liveness.
- **`main.py`** — `asyncio` supervisor with per-task crash-restart and 10 s backoff (NFR-03). One task crashing does not affect others.
- **`bioreactor-agent.service`** — hardened systemd unit. `Type=notify`, `WatchdogSec=60`, `User=bioagent` (unprivileged), `MemoryMax=300M`, `CPUQuota=30%`, `NoNewPrivileges`, `ProtectSystem=strict`. Targets <10% sustained CPU on Orange Pi Zero 2.

The interface contract: same `ReactorSnapshot` and `AgentLogEvent` JSON shapes as the simulator. **In production, `api.py` reads from `audit.db` instead of the in-memory `RUNS` dict — no other component changes.** Frontend is mode-agnostic.

### Layer 4 — Live demo dashboard
- React 18 + Vite + JointJS+ with three views: Reactor Grid, P&ID schematic, Lab Setup builder
- Lab Setup: drag-and-drop equipment palette with topology + GMP CIP validation rules
- 14-day simulation plays back in ~28 seconds of UI time

## Architecture

```
Production mode (real plant)                     Simulation mode (this demo)
──────────────────────────                        ───────────────────────────
[Bioreactor probes]                               [bioreactor_simulator.py]
    │ 4-20mA / HART                                    │
    ▼                                                  │
[DCS — Sartorius MFCS / Siemens PCS7 /                 │
       Emerson DeltaV / Honeywell Experion]            │
    │ OPC-UA TCP :4840                                 │
    ▼                                                  │
[Orange Pi Zero 2  (SBCInterconnect/)]                 │
  opc_reader → kalman EKF → rule_engine →              │
  gpt_agent → opc_writer → audit.db                    │
    │ HTTP localhost:5000                              │
    ▼                                                  │
[api.py reads audit.db]              ◄──── same JSON shapes ───►   [api.py reads RUNS dict]
    │                                                              │
    ▼                                                              ▼
[React frontend — unchanged across modes]
```


## Datasets, APIs, and references

- **OpenAI GPT-4.1** — agent reasoning and tool calls
- **López-Meza et al. 2016** *In Silico Approach to Determine Optimum Specific Productivity for r-CHO* — source for μmax (0.043 h⁻¹), Yx/s, Luedeking-Piret α/β, validated against published time courses
- **Frontiers Bioeng. Biotechnol. 2023** — industrial high-producer titers (4–8 g/L), source for our Q_P_SCALE bridging factor
- **PMC 9843118** — continuous feed optimization, ≥10 g/L titer benchmarks
- **JointJS+** (commercial trial) — SCADA P&ID schematic rendering
- **Recharts, lucide-react, Tailwind** — dashboard UI

## How to run it

### Prerequisites
- Python 3.10+
- Node.js 18+
- OpenAI API key (for live agent decisions; rule-based fallback otherwise)
- JointJS+ trial token (for the P&ID view; dashboard works without it)

### Backend (this repo)
```bash
git clone https://github.com/bahrant/Marauders.git
cd Marauders
pip install flask flask-cors openai python-dotenv numpy

# Set your OpenAI key
echo 'OPENAI_API_KEY=sk-proj-your-key-here' > .env

# Run the API on port 5001 (dodges macOS AirPlay on 5000)
python3 api.py
```

API serves on `http://localhost:5001`. Health check: `GET /api/health`.

### Frontend (separate repo)
```bash
git clone https://github.com/jayanitripathi/scsp.git
cd scsp/side-proj/scada/js

# JointJS+ trial token (required for P&ID view)
export JOINTJS_NPM_TOKEN="jjs-your-token-here"

# Point frontend at backend on port 5001
echo 'VITE_API_BASE=http://localhost:5001' > .env.local

npm install
npm run dev
```

Dashboard opens at `http://localhost:5173`.

### Quick verification (no frontend)
```bash
python3 -c "
from api import app
c = app.test_client()
r = c.post('/api/run', json={'n_reactors':4,'run_days':14,'seed':42}).json
print('events:', r['agent_log_total'])
print('R4 titer:', r['summary']['R4']['final_titer_g_per_L'], 'g/L')
"
```

Expected: `events: 30-50 | R4 titer: ~2.37 g/L`. First run takes ~2-3 min while GPT-4.1 reasons through 14 simulated days; subsequent calls hit the cached run instantly.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  React Dashboard (Reactor Grid · P&ID · Lab Setup)              │
│  http://localhost:5173                                          │
└────────────────────────────┬────────────────────────────────────┘
                             │ REST + 2s polling
┌────────────────────────────▼────────────────────────────────────┐
│  Flask API   :5001                                              │
│  POST /api/run        →  spawns simulation + agent              │
│  GET  /snapshot       →  reactor state at sim day X             │
│  GET  /timeseries     →  cumulative chart data                  │
│  GET  /agent_log      →  GPT-4.1 events for this run            │
└──────────┬───────────────────────────────────┬──────────────────┘
           │                                   │
┌──────────▼──────────────┐       ┌────────────▼─────────────────┐
│  bioreactor_simulator   │       │  agent_runner (GPT-4.1)      │
│  Monod + Luedeking-     │       │  6 tools, audit-logged       │
│  Piret + 4 strategies   │       │  with natural-language       │
│                         │       │  reasoning                   │
└─────────────────────────┘       └────────────┬─────────────────┘
                                               │
                                  ┌────────────▼─────────────────┐
                                  │  ph_probe_kalman             │
                                  │  Bahran's RAIM-style filter  │
                                  └──────────────────────────────┘
```

## Key files

| File | Purpose |
|---|---|
| `bioreactor_simulator.py` | Calibrated CHO kinetics, 4 reactors, 14-day fed-batch |
| `agent.py` | 6 tool definitions + standalone live-mode agent loop |
| `agent_runner.py` | Replay-mode integration: GPT-4.1 across pre-computed history |
| `ph_probe_kalman.py` | Probe validation (stub here; full EKF in `SBCInterconnect/kalman.py`) |
| `api.py` | Flask API — playback endpoints + legacy compatibility |
| `SBCInterconnect/` | Production edge compute stack — see folder for module-level details |

## Honest results

We measured what we built; we report what we measured.

| Reactor | Strategy | Final titer (g/L) | vs R1 control |
|---|---|---|---|
| R1 | Bolus only | 1.91 | 1.00× (baseline) |
| R2 | Bolus + temp shift | 2.20 | 1.16× |
| R3 | Continuous feed | 2.05 | 1.07× |
| R4 | Continuous + temp shift | 2.37 | **1.24×** |

These numbers are stable across seeds (seeds 7, 42, 123, 2026 all produce ranges within ±0.05 g/L). Strategy ordering is consistent. The +24% R4-vs-R1 improvement is smaller than top-line industrial numbers (which use proprietary high-producer clones with qP > 30 pg/cell/day) but matches the directional behavior in our reference papers given r-CHO baseline kinetics.

## What we didn't ship

In the interest of being direct about scope:

- **Live SBC ↔ demo integration**: The SBC stack in `SBCInterconnect/` is designed and written but is not wired into the live dashboard for this submission. The interface contract (same JSON shapes) means the swap is mechanical — point `api.py` at `audit.db` instead of `RUNS` — but tonight's demo runs in simulation mode for stability. Production-mode end-to-end is the obvious post-hackathon milestone.
- **Closed-loop agent**: The replay agent (`agent_runner.py`) reviews snapshots and decides what *would* be done rather than steering the simulator step-by-step. The SBC stack runs closed-loop natively in production mode.
- **Multi-product transfer**: Kinetics fit r-CHO; would need re-fitting per product line for real deployment.
- **Live OPC-UA demo**: We do not have a Sartorius MFCS / Siemens PCS7 / Emerson DeltaV simulator running tonight. The OPC-UA client (`opc_reader.py`) is verified against the asyncua library and standard CHO node naming conventions but has not been integration-tested against vendor hardware.

## License & credits

Code is open for the hackathon judging period. JointJS+ used under trial license. CHO kinetic constants from López-Meza 2016 (academic citation). OpenAI GPT-4.1 via paid API.
