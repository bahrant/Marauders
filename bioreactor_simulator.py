"""
bioreactor_simulator.py
=======================
CHO Fed-Batch Bioreactor Simulator for mAb Production
Based on published kinetic parameters from peer-reviewed literature.

Primary kinetic model sources:
- López-Meza et al. (2016) Cytotechnology 68(4):1287-1300
  DOI: 10.1007/s10616-015-9889-2 | PMC: PMC4960177
  → Monod growth kinetics + Luedeking-Piret mAb production model
  → μmax = 0.043 h⁻¹, Ks = 0.929 g/L, [S]t = 0.58 g/L (r-CHO at 33°C)
  → α = 7.65×10⁻⁷ µg/cell, β = 7.68×10⁻⁸ µg/cell/h (Luedeking-Piret)

- Frontiers Bioeng. Biotech. (2023) DOI: 10.3389/fbioe.2023.1112349
  → Perfusion titer benchmarks: 4.46–16.19 g/L over 11–16 day runs
  → Glucose maintained >5 mM, lactate <20 mM (1.8 g/L toxic threshold)

- MDPI Fermentation (2024) DOI: 10.3390/fermentation10070352
  → 15L fed-batch: pH 6.8–7.2, DO 30–60%, temp 36.5–37.5°C
  → VCD peak ~17×10⁶ cells/mL, daily sampling

- PMC9843118 (2023) Progress in Fed-Batch CHO Culture
  → Bolus feed strategy: days 3, 5, 7, 9 at 5% initial volume
  → Glucose depletion drives feed timing decisions
  → Continuous feed → titer >10 g/L possible

- PLOS ONE (2015) DOI: 10.1371/journal.pone.0136815
  → pH 7.0 ± 0.05, DO 50% air saturation, agitation 60–120 RPM
  → Lactate inhibition above 20 mM, ammonia inhibition modeled
"""

import numpy as np
import random
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from typing import Optional

# ─── Published Kinetic Parameters (López-Meza et al. 2016) ───────────────────
MU_MAX       = 0.043     # h⁻¹  Maximum specific growth rate (r-CHO at 33°C)
KS           = 0.929     # g/L  Monod saturation constant for glucose
S_THRESHOLD  = 0.58      # g/L  Minimum glucose for growth (threshold)
YX_S         = 1.8e6     # cells/mL per g/L  Yield coefficient (cells per glucose)
ALPHA        = 7.65e-7   # µg/cell  Luedeking-Piret growth-associated constant
BETA         = 7.68e-8   # µg/cell/h  Luedeking-Piret non-growth-associated constant

# ─── Process Thresholds (ISO / GxP / published limits) ───────────────────────
THRESHOLDS = {
    "pH":            {"min": 6.8,  "max": 7.2,   "unit": ""},
    "DO":            {"min": 30.0, "max": 60.0,   "unit": "% sat"},
    "temperature":   {"min": 36.5, "max": 37.5,   "unit": "°C"},
    "VCD":           {"min": 0.5,  "max": 20.0,   "unit": "×10⁶ cells/mL"},
    "glucose":       {"min": 0.9,  "max": 28.0,   "unit": "mM (5–155 mM normal)"},
    "lactate":       {"min": 0.0,  "max": 1.8,    "unit": "g/L (toxic >20mM)"},
    "viability":     {"min": 70.0, "max": 100.0,  "unit": "%"},
    "mAb_titer":     {"min": 0.0,  "max": 16.0,   "unit": "g/L"},
    "osmolality":    {"min": 280,  "max": 390,    "unit": "mOsm/kg"},
    "pCO2":          {"min": 0,    "max": 150,    "unit": "mmHg"},
}

# ─── Feed Strategy Config ─────────────────────────────────────────────────────
FEED_DAYS   = [3, 5, 7, 9]   # Bolus feed days (PMC9843118)
FEED_VOLUME = 0.05            # 5% of initial culture volume per bolus
GLUCOSE_FEED_CONCENTRATION = 400  # g/L concentrated glucose solution
FEED_GLUCOSE_BOOST = 2.0     # g/L glucose added per feed event


@dataclass
class ReactorState:
    """
    Full state of a single bioreactor at a given time point.
    All values are grounded in published fed-batch CHO culture ranges.
    """
    reactor_id: str
    day: float
    hour: float

    # Cell culture parameters
    VCD: float          # Viable cell density ×10⁶ cells/mL
    viability: float    # Cell viability %
    
    # Metabolites
    glucose: float      # g/L (initial ~4.8 g/L, PMC4960177)
    lactate: float      # g/L (toxic >1.8 g/L / 20 mM, Frontiers 2025)
    glutamine: float    # mM
    ammonia: float      # mM (inhibitory >5 mM)
    
    # Physical probes
    pH: float           # setpoint 7.0 ± 0.05 (PLOS ONE 2015)
    DO: float           # % air saturation, setpoint 50%
    temperature: float  # °C, setpoint 37.0 → possible shift to 33°C
    agitation: float    # RPM, 60–120 (PLOS ONE 2015)
    osmolality: float   # mOsm/kg, target <390 (Frontiers 2023)
    pCO2: float         # mmHg, concern >150 in large-scale (Frontiers 2023)
    
    # Product
    mAb_titer: float    # g/L, target >3 g/L fed-batch, up to 16 g/L perfusion
    
    # Status
    status: str         # "nominal" | "warning" | "critical"
    anomalies: list     = field(default_factory=list)
    feed_events: list   = field(default_factory=list)
    timestamp: str      = field(default_factory=lambda: datetime.now().isoformat())


class CHOBioreactorSimulator:
    """
    Simulates CHO fed-batch cell culture kinetics for mAb production.
    
    Uses Monod growth model (López-Meza et al. 2016) and Luedeking-Piret
    product formation model. Four parallel reactors with varied feed
    strategies to demonstrate optimization across experimental arms.
    """

    def __init__(self, n_reactors: int = 4, run_days: int = 14, temp_shift: bool = True):
        self.n_reactors = n_reactors
        self.run_days = run_days
        self.temp_shift = temp_shift
        self.dt = 24.0  # hours per time step (daily sampling, as per published protocols)

        # Initialize 4 reactors with slightly different feed strategies
        # mimicking a real parallel DoE optimization run
        self.strategies = {
            "R1": {"feed": "bolus",      "temp_shift_day": None, "label": "Control"},
            "R2": {"feed": "bolus",      "temp_shift_day": 7,    "label": "Temp Shift D7"},
            "R3": {"feed": "continuous", "temp_shift_day": None, "label": "Continuous Feed"},
            "R4": {"feed": "continuous", "temp_shift_day": 7,    "label": "Continuous + Shift"},
        }

        # Initialize reactor states (seeding conditions from published protocols)
        self.states = {}
        for i in range(1, n_reactors + 1):
            rid = f"R{i}"
            self.states[rid] = ReactorState(
                reactor_id=rid,
                day=0,
                hour=0,
                VCD=0.5,          # 0.5×10⁶ cells/mL seeding density (PMC9843118)
                viability=98.0,   # High viability at inoculation
                glucose=4.8,      # g/L CD Opti CHO medium (PMC4960177)
                lactate=0.05,     # g/L baseline
                glutamine=4.0,    # mM initial
                ammonia=0.1,      # mM baseline
                pH=7.10,          # pH 7.0 ± 0.05 (PLOS ONE 2015)
                DO=50.0,          # 50% air saturation (PLOS ONE 2015)
                temperature=37.0, # 37°C initial (temperature shift applied later)
                agitation=60.0,   # 60 RPM at inoculation (PLOS ONE 2015)
                osmolality=300,   # mOsm/kg baseline
                pCO2=35.0,        # mmHg baseline
                mAb_titer=0.0,
                status="nominal",
            )

        self.history = {rid: [] for rid in self.states}

    def _monod_growth_rate(self, glucose: float, temp: float) -> float:
        """
        Monod growth rate with threshold substrate concentration.
        López-Meza et al. 2016: threshold [S]t = 0.58 g/L for r-CHO.
        Temperature correction applied for temp shift strategy.
        """
        effective_glucose = max(0, glucose - S_THRESHOLD)
        if effective_glucose <= 0:
            return 0.0
        mu = MU_MAX * (effective_glucose / (KS + effective_glucose))
        # Temperature shift to 33°C reduces growth rate ~15% but boosts titer
        # (López-Meza et al. 2016: higher titer at 33°C vs 37°C)
        if temp < 35.0:
            mu *= 0.85
        return mu

    def _luedeking_piret_production(self, mu: float, VCD: float) -> float:
        """
        Luedeking-Piret mAb production rate.
        López-Meza et al. 2016:
        d[mAb]/dt = α·d[X]/dt + β·[X]
        α = 7.65×10⁻⁷ µg/cell, β = 7.68×10⁻⁸ µg/cell/h
        Convert from µg/cell to g/L using VCD (×10⁶ cells/mL = ×10⁹ cells/L)
        """
        VCD_cells_per_L = VCD * 1e9  # ×10⁶ cells/mL → cells/L
        dX_dt = mu * VCD_cells_per_L * self.dt
        dmAb_dt = (ALPHA * dX_dt + BETA * VCD_cells_per_L) * 1e-9  # convert µg to g
        return max(0, dmAb_dt)

    def _apply_feed(self, state: ReactorState, strategy: str) -> tuple:
        """
        Apply feed based on strategy. Returns (new_glucose, feed_event_str or None).
        Bolus: days 3,5,7,9 (PMC9843118) | Continuous: daily if glucose < 2 g/L
        """
        day = int(state.day)
        feed_event = None

        if strategy == "bolus":
            if day in FEED_DAYS and state.day % 1 < 0.1:
                new_glucose = state.glucose + FEED_GLUCOSE_BOOST
                feed_event = f"Day {day}: Bolus feed — glucose +{FEED_GLUCOSE_BOOST} g/L"
                return new_glucose, feed_event

        elif strategy == "continuous":
            if state.glucose < 2.0:
                boost = 1.5
                new_glucose = state.glucose + boost
                feed_event = f"Day {day}: Continuous feed triggered (glucose {state.glucose:.2f} g/L) — +{boost} g/L"
                return new_glucose, feed_event

        return state.glucose, None

    def step(self, reactor_id: str):
        """Advance one reactor by one time step (24h)."""
        state = self.states[reactor_id]
        strategy_config = self.strategies.get(reactor_id, self.strategies["R1"])

        # ── Temperature shift ──────────────────────────────────────────────
        target_temp = 37.0
        if strategy_config["temp_shift_day"] and state.day >= strategy_config["temp_shift_day"]:
            target_temp = 33.0
        state.temperature = target_temp + random.gauss(0, 0.15)

        # ── Growth kinetics (Monod) ────────────────────────────────────────
        mu = self._monod_growth_rate(state.glucose, state.temperature)
        dX = mu * state.VCD * self.dt
        state.VCD = min(state.VCD + dX + random.gauss(0, 0.08), 20.0)
        state.VCD = max(0.1, state.VCD)

        # ── Glucose consumption ────────────────────────────────────────────
        # Yield coefficient Yx/s: cells per g/L glucose consumed
        glucose_consumed = dX / (YX_S * 1e-6)  # Convert to g/L
        glucose_consumed = max(0, glucose_consumed + random.gauss(0, 0.05))

        # ── Feed application ───────────────────────────────────────────────
        new_glucose, feed_event = self._apply_feed(state, strategy_config["feed"])
        state.glucose = max(0, new_glucose - glucose_consumed)
        if feed_event:
            state.feed_events.append(feed_event)

        # ── Lactate dynamics ───────────────────────────────────────────────
        # Lactate increases with glucose consumption, peaks then shifts
        # Metabolic shift: lactate consumption after day 5-7 (PMC5656727)
        if state.day < 6:
            dlactate = glucose_consumed * 0.4 + random.gauss(0, 0.03)
        else:
            dlactate = -0.05 * state.lactate + random.gauss(0, 0.02)  # consumption phase
        state.lactate = max(0, state.lactate + dlactate)

        # ── Glutamine / Ammonia ────────────────────────────────────────────
        state.glutamine = max(0, state.glutamine - 0.15 * mu + random.gauss(0, 0.05))
        state.ammonia += 0.05 * mu * state.VCD + random.gauss(0, 0.02)
        state.ammonia = max(0, state.ammonia)

        # ── pH control ────────────────────────────────────────────────────
        # CO2 sparging / base addition maintains pH setpoint
        # Lactate accumulation pushes pH down; controller corrects
        ph_drift = -0.01 * state.lactate + random.gauss(0, 0.02)
        state.pH = np.clip(state.pH + ph_drift, 6.75, 7.35)

        # ── Dissolved oxygen ───────────────────────────────────────────────
        # Agitation increases to meet O2 demand as VCD rises (PLOS ONE 2015)
        state.agitation = min(120, 60 + state.VCD * 3)
        do_drift = random.gauss(0, 1.5) - 0.1 * state.VCD
        state.DO = np.clip(state.DO + do_drift, 20.0, 70.0)

        # ── Osmolality ─────────────────────────────────────────────────────
        # Feed additions increase osmolality; target <390 mOsm/kg
        state.osmolality = np.clip(
            300 + state.day * 3 + random.gauss(0, 5),
            280, 420
        )

        # ── pCO2 accumulation ──────────────────────────────────────────────
        # Rises over culture duration, especially in large-scale (Frontiers 2023)
        state.pCO2 = np.clip(
            35 + state.day * 8 + state.VCD * 2 + random.gauss(0, 5),
            20, 200
        )

        # ── Viability decay ────────────────────────────────────────────────
        # Lactate inhibition and ammonia accumulation drive viability down
        viability_loss = 0.3 * max(0, state.lactate - 1.0) + 0.5 * max(0, state.ammonia - 4.0)
        state.viability = max(0, min(100, state.viability - viability_loss + random.gauss(0, 0.3)))

        # ── mAb titer (Luedeking-Piret) ────────────────────────────────────
        dmAb = self._luedeking_piret_production(mu, state.VCD)
        # Temperature shift boosts specific productivity (López-Meza et al. 2016)
        if state.temperature < 35.0:
            dmAb *= 1.25
        state.mAb_titer = max(0, state.mAb_titer + dmAb)

        # ── Advance time ───────────────────────────────────────────────────
        state.day += self.dt / 24.0
        state.hour += self.dt
        state.timestamp = datetime.now().isoformat()

        # ── Anomaly detection ──────────────────────────────────────────────
        state.anomalies = []
        state.status = "nominal"
        self._check_anomalies(state)

        # Save to history
        self.history[reactor_id].append(self._snapshot(state))
        return state

    def _check_anomalies(self, state: ReactorState):
        """Flag parameter exceedances against GxP thresholds."""
        checks = [
            ("pH",          state.pH,          6.8, 7.2),
            ("DO",          state.DO,          30.0, 60.0),
            ("temperature", state.temperature, 36.5, 37.5),
            ("glucose",     state.glucose,     0.9,  28.0),
            ("lactate",     state.lactate,     0.0,  1.8),
            ("viability",   state.viability,   70.0, 100.0),
            ("osmolality",  state.osmolality,  280,  390),
            ("pCO2",        state.pCO2,        0,    150),
        ]
        for name, value, lo, hi in checks:
            if value < lo:
                severity = "CRITICAL" if value < lo * 0.9 else "WARNING"
                state.anomalies.append({
                    "parameter": name, "value": round(value, 3),
                    "limit": f">{lo}", "type": "below_min", "severity": severity
                })
                if severity == "CRITICAL":
                    state.status = "critical"
                elif state.status == "nominal":
                    state.status = "warning"
            elif value > hi:
                severity = "CRITICAL" if value > hi * 1.1 else "WARNING"
                state.anomalies.append({
                    "parameter": name, "value": round(value, 3),
                    "limit": f"<{hi}", "type": "above_max", "severity": severity
                })
                if severity == "CRITICAL":
                    state.status = "critical"
                elif state.status == "nominal":
                    state.status = "warning"

    def _snapshot(self, state: ReactorState) -> dict:
        """Return a JSON-serializable snapshot of reactor state."""
        return {
            "reactor_id":  state.reactor_id,
            "day":         round(state.day, 2),
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
            "timestamp":   state.timestamp,
            "strategy":    self.strategies.get(state.reactor_id, {}).get("label", "Unknown"),
        }

    def get_current_readings(self) -> dict:
        """Get current state snapshot for all reactors — used by the agent."""
        return {
            rid: self._snapshot(state)
            for rid, state in self.states.items()
        }

    def run_full_simulation(self) -> dict:
        """Run complete simulation for all reactors over full run duration."""
        print(f"\nRunning {self.run_days}-day fed-batch simulation across {self.n_reactors} reactors...")
        for day in range(self.run_days):
            for rid in self.states:
                self.step(rid)
        return self.history

    def get_titer_summary(self) -> dict:
        """
        Summary of final titers across reactors.
        Expected range: 3–8 g/L fed-batch (Frontiers 2023).
        """
        return {
            rid: {
                "final_titer_g_per_L": round(state.mAb_titer, 3),
                "peak_VCD": round(max(
                    [s["VCD"] for s in self.history[rid]] or [0]
                ), 2),
                "strategy": self.strategies.get(rid, {}).get("label", "Unknown"),
                "run_day": round(state.day, 1),
            }
            for rid, state in self.states.items()
        }


# ─── Standalone test ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    sim = CHOBioreactorSimulator(n_reactors=4, run_days=14)
    history = sim.run_full_simulation()

    print("\n" + "="*60)
    print("FINAL TITER SUMMARY (14-day fed-batch)")
    print("="*60)
    summary = sim.get_titer_summary()
    for rid, data in summary.items():
        print(f"  {rid} [{data['strategy']}]: {data['final_titer_g_per_L']} g/L | Peak VCD: {data['peak_VCD']} ×10⁶ cells/mL")

    print("\nCurrent readings snapshot:")
    import json
    readings = sim.get_current_readings()
    for rid, reading in readings.items():
        print(f"\n  {rid} — Day {reading['day']} | Status: {reading['status'].upper()}")
        print(f"       VCD: {reading['VCD']} ×10⁶/mL | Titer: {reading['mAb_titer']} g/L")
        print(f"       pH: {reading['pH']} | DO: {reading['DO']}% | Glucose: {reading['glucose']} g/L")
        if reading['anomalies']:
            for a in reading['anomalies']:
                print(f"       ⚠️  {a['severity']}: {a['parameter']} = {a['value']} (limit {a['limit']})")
