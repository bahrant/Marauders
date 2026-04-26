BioReactorAgent — Hardware Integration



KEY INSTRUCTIONS: FOR LOGIC/CODE/REQURIREMENTS proposed within   kalman.py, rule_engine.py, and agent.py below -  THAT OVERLAP WITH CURRENT IMPLEMENTATIONS WITHIN PARENT DIRECTORY,BIOREACTORSIM. DEFER TO PARENT FOLDER IMPLEMNTATION AND REVISE THIS FILE ACCORDINGLY. COPY FILE(S) IN SBCINTERCONNECT DIRECTORY IF NEEDED.


THIS FOLDER WILL SUPPORT ALL THE FILES FOR THE APPLICATIOND DESCRIBED BELOW 

Software Design Document
Version: 1.0
Scope: Edge compute stack running on Orange Pi Zero 2. Defines all new modules required to connect api.py to a live bioreactor DCS via OPC-UA.

1. Context
The existing system (bioreactor_simulator.py + api.py + React frontend) is complete. This document covers the seven new Python modules that replace the simulator as the data source in production, without changing the API surface or frontend.

[Bioreactor Probes]
        │ 4-20mA / HART
        ▼
[Plant Controller — DCS]
  Sartorius MFCS / Siemens PCS7 / Emerson DeltaV
        │ OPC-UA TCP (port 4840)
        ▼
[Orange Pi Zero 2]  ←── this document
  opc_reader.py       reads probe data
  kalman.py           estimates unmeasured states
  rule_engine.py      fast threshold corrections
  agent.py        strategic decisions
  opc_writer.py       validated setpoint writes
  audit.py            persistent audit trail
  heartbeat.py        watchdog signals
        │ HTTP localhost:5000
        ▼
[api.py — unchanged]
        │ HTTP localhost:5000
        ▼
[React Frontend — unchanged]

2. Interface Contract
The hardware integration stack MUST produce data in the same JSON shapes that api.py currently reads from the RUNS dict. In production, api.py reads from audit.db instead. No other component changes.

ReactorSnapshot (per reactor, per tick):

reactor_id, day, VCD, viability, glucose, lactate, glutamine, ammonia,
pH, DO, temperature, agitation, osmolality, pCO2, mAb_titer,
status, anomalies[], feed_events[], timestamp, strategy

AgentLogEvent (per agent action):

id, reactorId, day, action, reasoning, severity, parameters{}

3. Module Specifications
opc_reader.py
Purpose: Single interface between the DCS and the rest of the system. All probe data enters through this module.

FR-01 SHALL connect to the OPC-UA server at the endpoint specified in config.toml using asyncua.Client with username/password authentication.

FR-02 For each reactor, SHALL create a 500ms OPC-UA subscription using subscribe_data_change(). Subscriptions use push notifications — polling is not permitted.

FR-03 SHALL subscribe to the following nodes per reactor: pH, dissolved oxygen (%), temperature (°C), agitation (RPM), off-gas CO₂ (%), off-gas O₂ (%). Additional nodes may be subscribed via config without code changes.

FR-04 On receipt of a data-change notification, SHALL push (reactor_id, parameter, value, server_timestamp) to a module-level asyncio.Queue consumed by kalman.py.

FR-05 SHALL expose get_latest(reactor_id, parameter) → float returning the most recently received value for any subscribed node. Returns None if no value has yet been received.

FR-06 On connection loss, SHALL log a connection_lost event and attempt reconnection with backoff: 1s → 2s → 4s → 8s → 16s → 60s (ceiling). SHALL set a module-level is_connected: bool flag consumed by opc_writer.py.

kalman.py
Purpose: Maintains best-estimate state for all reactors between sparse offline measurements. Provides continuous titer and glucose estimates.

FR-07 SHALL implement an Extended Kalman Filter (EKF) with state vector per reactor:

x = [VCD, glucose, lactate, glutamine, ammonia, mAb_titer]

FR-08 The predict step SHALL use the ODE system from bioreactor_simulator.py as the process model f(x, u). The Jacobian ∂f/∂x SHALL be computed numerically via finite differences.

FR-09 The correct step SHALL execute whenever opc_reader.py pushes a new measurement. The observation model SHALL map available measured parameters to their corresponding state vector positions.

FR-10 SHALL implement a CER-based glucose soft sensor:

CER = (vent_flow × [CO₂]_exhaust) − (sparge_flow × [CO₂]_inlet)
glucose_consumption_rate ≈ CER / RQ   (RQ = 1.0 for CHO on glucose)

This provides a continuous glucose estimate between offline assay samples (every 4–24h).

FR-11 SHALL expose get_state(reactor_id) → ReactorState returning the current state estimate in the same format as bioreactor_simulator._snapshot(). All downstream modules consume state from this method only.

rule_engine.py
Purpose: Fast, deterministic threshold evaluation executing corrective setpoint writes within one tick cycle. No GPT-4o involvement.

FR-12 SHALL evaluate all reactor states on a 30-second tick. Evaluation completes synchronously within the tick.

FR-13 SHALL implement the following rules:

Condition	Severity	Action
pH < 6.8 or pH > 7.2	Warning	opc_writer.set_pH_sp(reactor, 7.0)
pH < 6.5 or pH > 7.5	Critical	flag_human — no auto-correct
DO < 30%	Warning	opc_writer.set_agitation_sp(reactor, current + 20)
DO > 60%	Warning	opc_writer.set_agitation_sp(reactor, current − 15)
DO < 20%	Critical	flag_human
temperature > 37.6°C	Warning	opc_writer.set_temp_sp(reactor, 37.0)
temperature > 39°C	Critical	flag_human
lactate > 1.8 g/L	Critical	opc_writer.set_feed_rate(reactor, current × 0.5) + flag_human
viability < 70%	Critical	flag_human
glucose_est < 0.9 g/L (continuous strategy only)	Warning	opc_writer.set_feed_rate(reactor, current + 0.5)
pCO₂ > 150 mmHg	Warning	opc_writer.increase_stripping(reactor)
osmolality > 390 mOsm/kg	Warning	opc_writer.set_feed_rate(reactor, current × 0.8)
FR-14 For every rule that fires, an AgentLogEvent record SHALL be written to audit.py BEFORE the corresponding opc_writer call is made.

gpt_agent.py
Purpose: Strategic decisions beyond the rule engine's fixed rules. Runs at low frequency.

FR-15 SHALL execute a sweep every 30 minutes, or immediately when triggered by any Critical-severity rule engine event.

FR-16 SHALL construct a context object for each reactor containing: day, reactor_id, strategy, VCD_est, glucose_est, lactate, viability, titer_est, temperature, last 3 anomalies, last 3 feed_events.

FR-17 SHALL call openai.chat.completions.create(model="gpt-4o") with the following tools:

Tool	Trigger condition
adjust_feed_rate(reactor_id, rate_L_per_h)	glucose_est < 0.5 g/L or VCD growth slowing
initiate_temperature_shift(reactor_id, target_temp_c)	VCD_est > 8×10⁶ and day > 6 and target in [33, 37]°C
propagate_strategy(source_id, target_id)	Source titer > target titer by ≥ 18% at same day
flag_for_human_review(reactor_id, reason)	Any parameter outside normal range without rule engine coverage
log_decision(reactor_id, note)	Observation — no action
FR-18 SHALL enforce a 15-second hard timeout on the API call. On timeout or APIError, SHALL log gpt_unavailable and return. The rule engine loop continues uninterrupted.

FR-19 SHALL NOT call adjust_feed_rate or initiate_temperature_shift on any reactor with an active flag_for_human_review within the last 2 hours.

FR-20 All tool-call executions route through opc_writer.py. gpt_agent.py does not write OPC-UA nodes directly.

opc_writer.py
Purpose: Single validated exit point for all OPC-UA setpoint writes. No other module writes to OPC-UA directly.

FR-21 SHALL accept (reactor_id, parameter, value) and resolve the target OPC-UA node path from config.toml.

FR-22 Before writing, SHALL validate value against [cpp_limits] in config.toml. A value outside CPP bounds SHALL log a constraint_block event to audit.py and return without writing.

FR-23 SHALL read the current live value via opc_reader.get_latest() and record it as pre_value in the audit entry.

FR-24 SHALL check opc_reader.is_connected before any write. If disconnected, SHALL log write_skipped_disconnected and return without throwing.

FR-25 SHALL record the OPC-UA server response status code in the audit entry. Bad_NotWritable SHALL be logged as write_rejected.

audit.py
Purpose: Append-only persistent store. In production, api.py reads from this instead of the RUNS in-memory dict. No API changes.

FR-26 SHALL maintain a SQLite database at /opt/bioreactor-agent/data/audit.db with two tables:

CREATE TABLE snapshots (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL,
    reactor_id  TEXT NOT NULL,
    day         REAL NOT NULL,
    VCD         REAL, viability REAL, glucose REAL, lactate REAL,
    glutamine   REAL, ammonia REAL, pH REAL, DO REAL,
    temperature REAL, agitation REAL, osmolality REAL, pCO2 REAL,
    mAb_titer   REAL, status TEXT, anomalies TEXT, feed_events TEXT,
    strategy    TEXT, timestamp TEXT
);

CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL,
    reactor_id  TEXT NOT NULL,
    day         REAL NOT NULL,
    action_type TEXT NOT NULL,
    parameter   TEXT,
    pre_value   REAL,
    new_value   REAL,
    unit        TEXT,
    reasoning   TEXT,
    severity    TEXT,
    executed_by TEXT DEFAULT 'BioReactorAgent v1.0',
    timestamp   REAL NOT NULL
);

FR-27 All writes SHALL use aiosqlite (non-blocking). A snapshot or audit entry write SHALL complete before the corresponding OPC-UA write is attempted.

FR-28 No row in either table SHALL be deletable through any method accessible to application code.

heartbeat.py
Purpose: Signals liveness to two independent monitoring systems.

FR-29 SHALL notify the systemd watchdog via sdnotify.SystemdNotifier().notify("WATCHDOG=1") every ≤ 30 seconds (WatchdogSec = 60s in the unit file).

FR-30 SHALL write an incrementing integer counter to the OPC-UA heartbeat node configured in config.toml every 15 seconds. The DCS monitors this node to detect agent failure.

FR-31 A failed OPC-UA heartbeat write SHALL NOT stop the systemd notification. The two watchdog mechanisms are fully independent.

4. Configuration
config.toml

[opc_ua]
endpoint  = "opc.tcp://192.168.1.100:4840"
username  = "bioagent"

[timing]
fast_loop_s  = 30
gpt_loop_min = 30
heartbeat_s  = 15

[cpp_limits]
pH_min         = 6.5
pH_max         = 7.5
do_min         = 15.0
temp_max       = 39.0
agitation_max  = 400

[reactors.R1]
opc_pH_sp      = "ns=2;s=BR1.pH_setpoint"
opc_temp_sp    = "ns=2;s=BR1.temperature_setpoint"
opc_agit_sp    = "ns=2;s=BR1.agitation_setpoint"
opc_feed_rate  = "ns=2;s=BR1.feed_rate"
opc_heartbeat  = "ns=2;s=Agent.heartbeat"
# R2, R3, R4 follow same pattern

.env

OPENAI_API_KEY=sk-...
OPC_UA_PASSWORD=...

5. Deployment
Platform: Orange Pi Zero 2, Armbian Minimal (Debian Bookworm), Python 3.11

systemd unit: bioreactor-agent.service

Type=notify
WatchdogSec=60
Restart=on-failure
RestartSec=10s
Network:

eth0 — static IP on DCS process subnet (OPC-UA)
wlan0 — internet (OpenAI API)
6. Non-Functional Requirements
ID	Requirement	Target
NFR-01	Detection to OPC-UA setpoint write	≤ 60 seconds
NFR-02	Audit write before OPC-UA write	Always — no exceptions
NFR-03	One task crash must not affect others	Per-task exception handler with 10s backoff restart
NFR-04	Sustained CPU — Orange Pi Zero 2	< 10%
NFR-05	RAM footprint	< 300 MB
NFR-06	GPT-4o response timeout	15 seconds hard limit
NFR-07	api.py endpoint shapes	Unchanged — no frontend modifications required
