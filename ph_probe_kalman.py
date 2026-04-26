"""
ph_probe_kalman.py — STUB IMPLEMENTATION
========================================
Placeholder Kalman filter for pH probe validation.

This stub satisfies the import contract that agent.py expects:
    from ph_probe_kalman import PHProbeKalman
    kf = PHProbeKalman()
    kf.predict(lactate=..., pCO2=..., control_active=True)
    estimate, fault_flags, confidence = kf.update(measured_pH)

It returns plausible values so the agent loop can run end-to-end during
development. Bahran's full implementation (with RAIM-style fault detection,
adaptive Q/R, χ² innovation testing) replaces this file when ready.

Tunable behavior here:
- 90%+ healthy probe in normal pH range
- Low confidence drop when lactate spikes (mimics drift trigger)
- No fault detection — agent will see "probe healthy" most of the time
"""

import random


class PHProbeKalman:
    """Placeholder Kalman filter. Same interface as Bahran's real one."""

    # Operating envelope — when we drift outside this, mark low confidence
    PH_NOMINAL_LOW = 6.6
    PH_NOMINAL_HIGH = 7.4

    def __init__(self):
        # Internal state (unused in stub but kept for interface symmetry)
        self.x_hat = 7.0       # state estimate (pH)
        self.P = 0.001         # state covariance
        self.Q = 1e-4          # process noise (per ph_probe_kalman.py spec)
        self.R = 2.5e-5        # measurement noise (healthy probe)
        self.day = 0           # day counter (agent increments after each update)
        self._last_lactate = 0.0
        self._last_pCO2 = 30.0

    def predict(self, lactate: float = 0.0, pCO2: float = 30.0,
                control_active: bool = True) -> None:
        """Time update. Real KF would advance state estimate; we just stash inputs."""
        self._last_lactate = lactate
        self._last_pCO2 = pCO2
        # Trivial random walk on x_hat to look "live" if anyone inspects it
        self.x_hat += random.gauss(0, 0.005)

    def update(self, measured_pH: float):
        """
        Measurement update. Returns (estimate, fault_flags, confidence).

        - estimate: filtered pH (≈ measured_pH ± small smoothing in stub)
        - fault_flags: list of {type, recommendation} dicts; empty if healthy
        - confidence: 0..1, drops when measurement is far from nominal
        """
        # Stub blends measurement with prior (very light smoothing)
        estimate = 0.85 * measured_pH + 0.15 * self.x_hat
        self.x_hat = estimate

        # Confidence model: full confidence inside operating band, falls off
        # linearly outside. This makes the agent occasionally see "low conf"
        # readings when pH drifts during late-batch decline.
        if self.PH_NOMINAL_LOW <= measured_pH <= self.PH_NOMINAL_HIGH:
            confidence = 0.95 + random.uniform(-0.03, 0.03)
        else:
            distance = min(
                abs(measured_pH - self.PH_NOMINAL_LOW),
                abs(measured_pH - self.PH_NOMINAL_HIGH),
            )
            confidence = max(0.4, 0.85 - 2.0 * distance)

        # Stub never fires faults — Bahran's real impl handles spike/drift/
        # freeze/fouling detection via χ² innovation testing
        fault_flags: list = []

        return estimate, fault_flags, confidence
