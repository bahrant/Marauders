"""
kalman.py
=========
BioReactorAgent — Extended Kalman Filter (EKF) State Estimator
===============================================================
Implements FR-07 through FR-11.

Supersedes the ph_probe_kalman.py stub (copied to this directory for reference).
This module provides a full 6-state EKF for continuous estimation of unmeasured
bioreactor states between sparse offline measurements.

State vector per reactor (FR-07):
    x = [VCD, glucose, lactate, glutamine, ammonia, mAb_titer]

Process model (FR-08):
    Uses the ODE kinetic system from bioreactor_simulator.py as f(x, u).
    Jacobian ∂f/∂x computed numerically via finite differences (avoids
    analytical derivation on Arm CPU; computationally adequate at 500ms tick).

Correction step (FR-09):
    Fires on every measurement pushed to measurement_queue by opc_reader.py.
    Observation model maps measured parameters to state vector positions.

CER glucose soft sensor (FR-10):
    CER = vent_flow × [CO₂]_exhaust − sparge_flow × [CO₂]_inlet
    glucose_consumption_rate ≈ CER / RQ   (RQ = 1.0 for CHO on glucose)

Public API (FR-11):
    get_state(reactor_id) → dict   same shape as bioreactor_simulator._snapshot()
    run()                          asyncio task — consumes opc_reader.measurement_queue

Design notes
────────────
• Physical probes (pH, DO, temperature, agitation) are NOT part of the state
  vector — they are directly measured by the DCS and flow through opc_reader.
  The EKF estimates the metabolic states that are NOT continuously measured.
• The 'u' (input) vector carries current physical probe readings as environmental
  drivers of the ODE: temperature affects μ, agitation affects DO transfer.
• Offline assay measurements (VCD, glucose, lactate via offline analyser) trigger
  direct state vector corrections when pushed via the queue.
"""

import asyncio
import logging
import os
import time
from collections import defaultdict
from typing import Optional

import numpy as np
import tomllib

# Import kinetic model from the copy of bioreactor_simulator in this directory.
# bioreactor_simulator.py is copied here per KEY INSTRUCTIONS so the edge
# device is self-contained at /opt/bioreactor-agent/.
from bioreactor_simulator import (
    MU_MAX, KS, S_THRESHOLD, YX_S,
    ALPHA, BETA, Q_P_SCALE,
    THRESHOLDS,
)
import opc_reader

logger = logging.getLogger("kalman")

# ── EKF tuning constants ──────────────────────────────────────────────────────

# State indices
IDX_VCD       = 0
IDX_GLUCOSE   = 1
IDX_LACTATE   = 2
IDX_GLUTAMINE = 3
IDX_AMMONIA   = 4
IDX_TITER     = 5
N_STATES      = 6

# Process noise covariance Q — tuned per state uncertainty
# Higher Q → trust measurements more than model
Q_DIAG = np.array([
    0.05,    # VCD ×10⁶ cells/mL  — moderate: growth model has noise
    0.10,    # glucose g/L        — higher: feed events cause step changes
    0.05,    # lactate g/L        — moderate
    0.02,    # glutamine mM       — lower: slower dynamics
    0.02,    # ammonia mM         — lower: slower dynamics
    0.01,    # mAb_titer g/L      — low: titer accumulates monotonically
])

# Measurement noise covariance R per sensor type
# These reflect typical offline analyser accuracy
R_VCD       = 0.5    # ×10⁶ cells/mL   (haemocytometer/Vi-CELL)
R_GLUCOSE   = 0.08   # g/L              (YSI/BioProfile analyser)
R_LACTATE   = 0.05   # g/L
R_GLUTAMINE = 0.1    # mM
R_AMMONIA   = 0.05   # mM
R_TITER     = 0.2    # g/L              (HPLC/Protein A)

# CER soft sensor
RQ = 1.0   # Respiratory Quotient for CHO on glucose (FR-10)

# Finite difference step for numerical Jacobian
FD_STEP = 1e-5

# ODE integration timestep (seconds) — matches subscription interval
DT_S = 0.5  # 500ms

# Map parameter names from opc_reader to state vector indices
_PARAM_TO_IDX: dict[str, int] = {
    "VCD":       IDX_VCD,
    "glucose":   IDX_GLUCOSE,
    "lactate":   IDX_LACTATE,
    "glutamine": IDX_GLUTAMINE,
    "ammonia":   IDX_AMMONIA,
    "mAb_titer": IDX_TITER,
}

# Map parameter names to their R values
_PARAM_TO_R: dict[str, float] = {
    "VCD":       R_VCD,
    "glucose":   R_GLUCOSE,
    "lactate":   R_LACTATE,
    "glutamine": R_GLUTAMINE,
    "ammonia":   R_AMMONIA,
    "mAb_titer": R_TITER,
}


# ── Per-reactor EKF state ─────────────────────────────────────────────────────

class ReactorEKF:
    """
    Extended Kalman Filter for one reactor.

    State: x = [VCD, glucose, lactate, glutamine, ammonia, mAb_titer]
    """

    def __init__(self, reactor_id: str, strategy: str = "bolus") -> None:
        self.reactor_id = reactor_id
        self.strategy = strategy

        # Initial state estimate — seeding conditions from bioreactor_simulator
        self.x = np.array([
            0.5,    # VCD ×10⁶ cells/mL
            4.8,    # glucose g/L
            0.05,   # lactate g/L
            4.0,    # glutamine mM
            0.1,    # ammonia mM
            0.0,    # mAb_titer g/L
        ])

        # Initial state covariance — high uncertainty at start
        self.P = np.diag([1.0, 1.0, 0.5, 0.5, 0.2, 0.1])

        # Process noise
        self.Q = np.diag(Q_DIAG)

        # Current physical probe readings (from opc_reader, used as ODE inputs)
        self.temperature: float = 37.0
        self.pH: float = 7.0
        self.DO: float = 50.0
        self.agitation: float = 60.0
        self.offgas_CO2: float = 0.05   # fraction
        self.offgas_O2: float = 0.209   # fraction

        # Derived
        self.day: float = 0.0
        self.t_last_predict: float = time.time()
        self.feed_events: list = []

        # CER soft sensor state (FR-10)
        self._cer_glucose_rate: float = 0.0   # g/L per second

    # ── ODE process model f(x, u) ─────────────────────────────────────────

    def _f(self, x: np.ndarray, dt: float) -> np.ndarray:
        """
        FR-08: Discrete-time process model using kinetics from bioreactor_simulator.py.

        Integrates the CHO ODE system forward by dt seconds using Euler method.
        This mirrors the step() logic in CHOBioreactorSimulator but is vectorised
        for the EKF and operates in seconds rather than 24-hour steps.
        """
        VCD, glucose, lactate, glutamine, ammonia, titer = x

        # Clamp to physical bounds before kinetics
        VCD       = max(0.1, VCD)
        glucose   = max(0.0, glucose)
        lactate   = max(0.0, lactate)
        glutamine = max(0.0, glutamine)
        ammonia   = max(0.0, ammonia)
        titer     = max(0.0, titer)

        # ── Monod growth rate (from bioreactor_simulator._monod_growth_rate) ──
        effective_glucose = max(0.0, glucose - S_THRESHOLD)
        if effective_glucose > 0:
            mu = MU_MAX * (effective_glucose / (KS + effective_glucose))
        else:
            mu = 0.0
        # Temperature correction (López-Meza 2016)
        if self.temperature < 35.0:
            mu *= 0.85

        dt_h = dt / 3600.0   # convert seconds to hours for published kinetics

        # ── VCD ───────────────────────────────────────────────────────────────
        viability_est = max(0.5, min(1.0, 1.0 - 0.01 * max(0, lactate - 1.0)))
        death_rate = 0.04 * (1.0 - viability_est) ** 1.5
        dVCD = (mu - death_rate) * VCD * dt_h
        new_VCD = VCD + dVCD
        new_VCD = min(new_VCD, 20.0)

        # ── Glucose ───────────────────────────────────────────────────────────
        # Growth-only glucose consumption (death doesn't consume substrate)
        mu_growth = max(0.0, mu)
        glucose_consumed = (mu_growth * VCD * dt_h) / (YX_S * 1e-6)
        # Add CER-derived soft sensor contribution
        glucose_from_cer = self._cer_glucose_rate * dt
        new_glucose = max(0.0, glucose - glucose_consumed + glucose_from_cer)

        # ── Lactate ───────────────────────────────────────────────────────────
        if self.day < 6.0:
            dlactate = glucose_consumed * 0.4 * dt_h / dt_h  # already per dt_h
            dlactate *= dt_h
        else:
            dlactate = -0.15 * lactate * dt_h
        new_lactate = max(0.0, lactate + dlactate)

        # ── Glutamine ─────────────────────────────────────────────────────────
        new_glutamine = max(0.0, glutamine - 0.15 * mu * dt_h)

        # ── Ammonia ───────────────────────────────────────────────────────────
        new_ammonia = max(0.0, ammonia + 0.05 * mu * VCD * dt_h)

        # ── mAb titer (Luedeking-Piret from bioreactor_simulator) ─────────────
        VCD_cells_per_L = VCD * 1e9
        dX_step = mu * VCD_cells_per_L * dt_h
        dmAb_ug_per_L = ALPHA * dX_step + BETA * VCD_cells_per_L * dt_h
        dmAb = max(0.0, dmAb_ug_per_L * 1e-6 * Q_P_SCALE)
        if self.temperature < 35.0:
            dmAb *= 1.25
        new_titer = max(0.0, titer + dmAb)

        return np.array([
            new_VCD, new_glucose, new_lactate,
            new_glutamine, new_ammonia, new_titer
        ])

    def _jacobian(self, x: np.ndarray, dt: float) -> np.ndarray:
        """
        FR-08: Numerical Jacobian ∂f/∂x via forward finite differences.
        F_ij = (f_i(x + h·e_j) − f_i(x)) / h
        """
        f0 = self._f(x, dt)
        F = np.zeros((N_STATES, N_STATES))
        for j in range(N_STATES):
            x_pert = x.copy()
            x_pert[j] += FD_STEP
            f_pert = self._f(x_pert, dt)
            F[:, j] = (f_pert - f0) / FD_STEP
        return F

    # ── EKF predict step ─────────────────────────────────────────────────

    def predict(self, dt: float) -> None:
        """
        EKF time-update (predict step).
        Propagates state estimate and covariance forward using the nonlinear
        ODE model and its linearised Jacobian.
        """
        F = self._jacobian(self.x, dt)
        self.x = self._f(self.x, dt)
        self.P = F @ self.P @ F.T + self.Q
        self.day += dt / 86400.0    # accumulate simulated day counter

    # ── EKF correct step ─────────────────────────────────────────────────

    def correct(self, param: str, value: float) -> None:
        """
        FR-09: EKF measurement-update (correct step).
        Fires on each measurement from opc_reader.measurement_queue that maps
        to the state vector.

        H is a 1×N row vector selecting one state component.
        Standard Kalman gain + update equations.
        """
        idx = _PARAM_TO_IDX.get(param)
        if idx is None:
            return   # parameter doesn't map to state vector (e.g. pH, DO)

        R = _PARAM_TO_R.get(param, 0.5)

        # Observation matrix H (1 × N_STATES)
        H = np.zeros((1, N_STATES))
        H[0, idx] = 1.0

        # Innovation
        z = np.array([[value]])
        y = z - H @ self.x.reshape(-1, 1)

        # Innovation covariance
        S = H @ self.P @ H.T + np.array([[R]])

        # Kalman gain (N_STATES × 1)
        K = self.P @ H.T @ np.linalg.inv(S)

        # State update
        self.x = self.x + (K @ y).flatten()

        # Covariance update (Joseph form for numerical stability)
        I_KH = np.eye(N_STATES) - K @ H
        self.P = I_KH @ self.P @ I_KH.T + K * R @ K.T

        # Clamp to physical bounds after correction
        self.x[IDX_VCD]       = max(0.1, self.x[IDX_VCD])
        self.x[IDX_GLUCOSE]   = max(0.0, self.x[IDX_GLUCOSE])
        self.x[IDX_LACTATE]   = max(0.0, self.x[IDX_LACTATE])
        self.x[IDX_GLUTAMINE] = max(0.0, self.x[IDX_GLUTAMINE])
        self.x[IDX_AMMONIA]   = max(0.0, self.x[IDX_AMMONIA])
        self.x[IDX_TITER]     = max(0.0, self.x[IDX_TITER])

    # ── CER glucose soft sensor ───────────────────────────────────────────

    def update_cer(self,
                   vent_flow: float,
                   offgas_co2_frac: float,
                   sparge_flow: float,
                   inlet_co2_frac: float = 0.0004) -> None:
        """
        FR-10: Carbon Evolution Rate (CER) based glucose soft sensor.

        CER = vent_flow [L/h] × [CO₂]_exhaust [fraction]
              − sparge_flow [L/h] × [CO₂]_inlet [fraction]
        glucose_consumption_rate ≈ CER / RQ    (RQ = 1.0 for CHO)

        Converts to g/L per second for use in the ODE.
        Molecular weight of glucose: 180 g/mol
        CO₂ molar volume at 37°C ≈ 25.3 L/mol
        Glucose concentration per unit CER approximated from stoichiometry:
            C₆H₁₂O₆ + 6O₂ → 6CO₂ + 6H₂O
            1 mol glucose → 6 mol CO₂
        glucose_rate [mol/L/s] = CER [mol/L/s] / 6
        glucose_rate [g/L/s]   = glucose_rate × 180
        """
        cer_L_per_h = (vent_flow * offgas_co2_frac
                       - sparge_flow * inlet_co2_frac)
        cer_mol_per_L_per_s = max(0.0, cer_L_per_h / 25.3 / 3600.0)
        glucose_mol_per_L_per_s = cer_mol_per_L_per_s / 6.0
        self._cer_glucose_rate = -glucose_mol_per_L_per_s * 180.0  # g/L/s consumed

    # ── Snapshot (FR-11) ──────────────────────────────────────────────────

    def snapshot(self) -> dict:
        """
        FR-11: Return current state estimate in the same dict shape produced by
        bioreactor_simulator._snapshot(). Downstream modules call get_state()
        which wraps this.
        """
        VCD, glucose, lactate, glutamine, ammonia, titer = self.x

        # Derive viability estimate from metabolite state
        lactate_loss  = 0.6 * max(0.0, lactate - 1.0)
        ammonia_loss  = 0.7 * max(0.0, ammonia - 4.0)
        senescence    = 1.5 if self.day > 8.0 else 0.0
        viability_est = max(0.0, min(100.0,
                            98.0 - (lactate_loss + ammonia_loss + senescence) * self.day))

        # Derive estimated status from THRESHOLDS
        status = "nominal"
        anomalies = []

        checks = [
            ("VCD",       VCD,       THRESHOLDS["VCD"]["min"],       THRESHOLDS["VCD"]["max"]),
            ("glucose",   glucose,   THRESHOLDS["glucose"]["min"],   THRESHOLDS["glucose"]["max"]),
            ("lactate",   lactate,   THRESHOLDS["lactate"]["min"],   THRESHOLDS["lactate"]["max"]),
            ("viability", viability_est, THRESHOLDS["viability"]["min"], THRESHOLDS["viability"]["max"]),
            # Physical probes read directly from opc_reader — included for completeness
            ("pH",        self.pH,        THRESHOLDS["pH"]["min"],        THRESHOLDS["pH"]["max"]),
            ("DO",        self.DO,        THRESHOLDS["DO"]["min"],        THRESHOLDS["DO"]["max"]),
            ("temperature", self.temperature, THRESHOLDS["temperature"]["min"], THRESHOLDS["temperature"]["max"]),
        ]
        for name, value, lo, hi in checks:
            if value < lo:
                sev = "CRITICAL" if value < lo * 0.9 else "WARNING"
                anomalies.append({
                    "parameter": name, "value": round(value, 3),
                    "limit": f">{lo}", "type": "below_min", "severity": sev,
                })
                if sev == "CRITICAL":
                    status = "critical"
                elif status == "nominal":
                    status = "warning"
            elif value > hi:
                sev = "CRITICAL" if value > hi * 1.1 else "WARNING"
                anomalies.append({
                    "parameter": name, "value": round(value, 3),
                    "limit": f"<{hi}", "type": "above_max", "severity": sev,
                })
                if sev == "CRITICAL":
                    status = "critical"
                elif status == "nominal":
                    status = "warning"

        return {
            "reactor_id":  self.reactor_id,
            "day":         round(self.day, 2),
            "VCD":         round(float(VCD), 3),
            "viability":   round(float(viability_est), 1),
            "glucose":     round(float(glucose), 3),
            "lactate":     round(float(lactate), 3),
            "glutamine":   round(float(glutamine), 3),
            "ammonia":     round(float(ammonia), 3),
            "pH":          round(self.pH, 3),
            "DO":          round(self.DO, 1),
            "temperature": round(self.temperature, 2),
            "agitation":   round(self.agitation, 1),
            "osmolality":  300.0,   # not in EKF state — estimated elsewhere
            "pCO2":        round(self.offgas_CO2 * 760.0, 1),  # frac → mmHg approx
            "mAb_titer":   round(float(titer), 4),
            "status":      status,
            "anomalies":   anomalies,
            "feed_events": list(self.feed_events),
            "timestamp":   time.strftime("%Y-%m-%dT%H:%M:%S"),
            "strategy":    self.strategy,
        }


# ── Module-level state ────────────────────────────────────────────────────────

_filters: dict[str, ReactorEKF] = {}   # reactor_id → ReactorEKF


def get_state(reactor_id: str) -> Optional[dict]:
    """
    FR-11: Return the current EKF state estimate for a reactor.
    Returns None if the reactor is not yet initialised.
    All downstream modules (rule_engine, gpt_agent) call this method only.
    """
    ekf = _filters.get(reactor_id)
    if ekf is None:
        return None
    return ekf.snapshot()


def _load_config() -> dict:
    config_path = os.path.join(os.path.dirname(__file__), "config.toml")
    with open(config_path, "rb") as f:
        return tomllib.load(f)


def _init_filters(cfg: dict) -> None:
    """Create one ReactorEKF per configured reactor."""
    global _filters
    reactors_cfg = cfg.get("reactors", {})
    for reactor_id, reactor_cfg in reactors_cfg.items():
        strategy = reactor_cfg.get("feed_strategy", "bolus")
        _filters[reactor_id] = ReactorEKF(reactor_id, strategy)
        logger.info("EKF initialised for %s (strategy=%s)", reactor_id, strategy)


# ── Main run loop ─────────────────────────────────────────────────────────────

async def run() -> None:
    """
    FR-08/FR-09/FR-10: Consume measurement_queue from opc_reader and maintain
    EKF state for all reactors.

    Two interleaved tasks:
      1. Periodic predict step every DT_S seconds (time update)
      2. Correct step on every measurement queue item (measurement update)

    The predict step runs on a timer; the correct step is driven by push
    notifications so it fires at irregular intervals matching OPC-UA events.
    """
    cfg = _load_config()
    _init_filters(cfg)

    # Run predict timer and queue consumer concurrently
    await asyncio.gather(
        _predict_loop(),
        _correction_loop(),
    )


async def _predict_loop() -> None:
    """Periodic EKF predict step — runs every DT_S seconds."""
    while True:
        await asyncio.sleep(DT_S)
        for reactor_id, ekf in _filters.items():
            # Update physical probe readings from opc_reader latest cache
            pH = opc_reader.get_latest(reactor_id, "pH")
            if pH is not None:
                ekf.pH = pH
            DO = opc_reader.get_latest(reactor_id, "DO")
            if DO is not None:
                ekf.DO = DO
            temp = opc_reader.get_latest(reactor_id, "temperature")
            if temp is not None:
                ekf.temperature = temp
            agit = opc_reader.get_latest(reactor_id, "agitation")
            if agit is not None:
                ekf.agitation = agit
            co2 = opc_reader.get_latest(reactor_id, "offgas_CO2")
            if co2 is not None:
                ekf.offgas_CO2 = co2

            # FR-10: update CER soft sensor
            # Vent and sparge flows are not in OPC subscriptions by default;
            # use fixed typical values unless extended in config.
            # Real deployment would subscribe opc_vent_flow / opc_sparge_flow.
            vent_flow = opc_reader.get_latest(reactor_id, "vent_flow") or 10.0   # L/h
            sparge_flow = opc_reader.get_latest(reactor_id, "sparge_flow") or 5.0
            if co2 is not None:
                ekf.update_cer(
                    vent_flow=vent_flow,
                    offgas_co2_frac=co2,
                    sparge_flow=sparge_flow,
                )

            ekf.predict(DT_S)


async def _correction_loop() -> None:
    """
    FR-09: Dequeue measurements from opc_reader.measurement_queue and apply
    EKF correction step for any parameter that maps to the state vector.

    Physical probe parameters (pH, DO, temperature, agitation) are stored on
    the EKF object for use in the process model but do NOT trigger a state
    vector correction (they are not EKF state variables).
    """
    while True:
        reactor_id, parameter, value, _server_ts = \
            await opc_reader.measurement_queue.get()

        ekf = _filters.get(reactor_id)
        if ekf is None:
            opc_reader.measurement_queue.task_done()
            continue

        # Physical probes: update EKF input fields only
        if parameter == "pH":
            ekf.pH = value
        elif parameter == "DO":
            ekf.DO = value
        elif parameter == "temperature":
            ekf.temperature = value
        elif parameter == "agitation":
            ekf.agitation = value
        elif parameter == "offgas_CO2":
            ekf.offgas_CO2 = value
        elif parameter == "offgas_O2":
            ekf.offgas_O2 = value
        elif parameter in _PARAM_TO_IDX:
            # Offline analyser result — apply state correction
            ekf.correct(parameter, value)
            logger.debug(
                "EKF correct %s.%s=%.3f → state=%s",
                reactor_id, parameter, value,
                [round(v, 3) for v in ekf.x]
            )

        opc_reader.measurement_queue.task_done()
