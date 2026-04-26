import type { SimulationConfig, SimulationState, ElementSimState, PlantGraph } from '../../types'

export const DEFAULT_SIM_CONFIG: SimulationConfig = {
  dt: 1,
  solver: 'euler',
  muMax: 0.4,
  Ks: 0.2,
  kLa: 200,
  yield_: 0.5,
  speedMultiplier: 1,
}

// ── Kinetic models ─────────────────────────────────────────────────────────────

export function monodGrowth(muMax: number, Ks: number, substrate: number): number {
  if (substrate <= 0) return 0
  return muMax * substrate / (Ks + substrate)
}

// kLa in h^-1, Cstar in mg/L, co2 in mg/L → returns mg/L/h
export function oxygenTransferRate(kLa: number, Cstar: number, co2: number): number {
  return kLa * Math.max(0, Cstar - co2)
}

// Returns g/L/h
export function oxygenUptakeRate(mu: number, biomass: number, Yo2 = 0.5): number {
  return (mu * biomass) / Yo2
}

// ── ODE right-hand side for a single bioreactor ───────────────────────────────

function bioreactorRHS(
  state: ElementSimState,
  config: SimulationConfig,
  flowIn: number,
  flowOut: number,
  kLaOverride?: number,
): Partial<ElementSimState> {
  const X = Math.max(0, state.biomass ?? 0.5)        // g/L
  const S = Math.max(0, state.substrate ?? 5.0)       // g/L
  const DO = Math.max(0, Math.min(100, state.dissolvedOxygen ?? 40))
  const V = Math.max(1, state.volume ?? 100)           // L
  const currentPH = state.pH ?? 7.0

  const Cstar = 8.0 // mg/L DO saturation at 37°C
  const co2_mgL = (DO / 100) * Cstar

  const kLa = kLaOverride ?? config.kLa  // h^-1
  const mu = monodGrowth(config.muMax, config.Ks, S)  // h^-1

  // Derivatives in per-hour units
  const OTR_h = oxygenTransferRate(kLa, Cstar, co2_mgL)
  const OUR_h = oxygenUptakeRate(mu, X)

  const dX_h = mu * X - (flowOut / V) * X
  const dS_h = -(mu * X) / config.yield_ + (flowIn / V) * 5.0 - (flowOut / V) * S
  const dDO_mgL_h = OTR_h - OUR_h - (flowOut / V) * co2_mgL
  const dDO_pct_h = (dDO_mgL_h / Cstar) * 100
  const dPH_h = -0.002 * OUR_h    // pH drifts down with metabolic activity
  const dV_h = flowIn - flowOut

  // Convert h^-1 → s^-1 for dt in seconds
  const h = config.dt / 3600

  return {
    biomass: Math.max(0, X + dX_h * h),
    substrate: Math.max(0, S + dS_h * h),
    dissolvedOxygen: Math.max(0, Math.min(100, DO + dDO_pct_h * h)),
    pH: Math.max(5.5, Math.min(8.5, currentPH + dPH_h * h)),
    volume: Math.max(0, V + dV_h * h),
    // Titer (product) grows proportionally to biomass
    product: Math.max(0, (state.product ?? 0) + 0.001 * X * h * 1000),
    temperature: state.temperature ?? 37,
  }
}

// ── Flow solver ───────────────────────────────────────────────────────────────

function computeFlows(
  graph: PlantGraph,
  prevLinks: SimulationState['links'],
): SimulationState['links'] {
  const newLinks: SimulationState['links'] = {}

  // Process edges topologically: pumps drive flow, others pass through
  for (const edge of graph.edges) {
    const sourceNode = graph.nodes.find(n => n.id === edge.source)
    let flowRate = 0

    if (sourceNode?.type === 'Pump') {
      const rpm = sourceNode.properties?.impellerSpeed ?? 120
      flowRate = Math.max(0, rpm / 400) * 10  // L/h
    } else if (sourceNode?.type === 'ControlValve') {
      // Average inbound flow * valve openness — simplified pass-through
      const upInflow = graph.edges
        .filter(e => e.target === edge.source)
        .reduce((s, e) => s + (newLinks[e.id]?.flowRate ?? prevLinks[e.id]?.flowRate ?? 0), 0)
      flowRate = upInflow
    } else if (sourceNode?.type === 'HandValve') {
      const upInflow = graph.edges
        .filter(e => e.target === edge.source)
        .reduce((s, e) => s + (newLinks[e.id]?.flowRate ?? prevLinks[e.id]?.flowRate ?? 0), 0)
      flowRate = upInflow
    } else if (sourceNode?.type === 'Join') {
      const upInflow = graph.edges
        .filter(e => e.target === edge.source)
        .reduce((s, e) => s + (newLinks[e.id]?.flowRate ?? prevLinks[e.id]?.flowRate ?? 0), 0)
      flowRate = upInflow
    } else {
      // Gravity / pressure driven from level
      const srcNode = graph.nodes.find(n => n.id === edge.source)
      const level = srcNode?.simState?.level ?? 50
      flowRate = (level / 100) * 5
    }

    newLinks[edge.id] = { flowRate: Math.max(0, flowRate), isActive: flowRate > 0.01 }
  }
  return newLinks
}

// ── Euler integration step ────────────────────────────────────────────────────

export function eulerStep(
  state: SimulationState,
  graph: PlantGraph,
  config: SimulationConfig,
): SimulationState {
  const newLinks = computeFlows(graph, state.links)
  const newElements: Record<string, ElementSimState> = {}

  for (const node of graph.nodes) {
    const cur = state.elements[node.id] ?? {}
    const inFlow = graph.edges
      .filter(e => e.target === node.id)
      .reduce((s, e) => s + (newLinks[e.id]?.flowRate ?? 0), 0)
    const outFlow = graph.edges
      .filter(e => e.source === node.id)
      .reduce((s, e) => s + (newLinks[e.id]?.flowRate ?? 0), 0)

    const props = node.properties ?? {}
    const maxVol = (props.maxVolume ?? (props.workingVolume ?? 100) * 1.5)

    if (node.type === 'Bioreactor' || node.type === 'Fermenter') {
      const derived = bioreactorRHS(cur, config, inFlow, outFlow, props.kLa)
      const vol = derived.volume ?? cur.volume ?? (props.workingVolume ?? 100)
      newElements[node.id] = {
        ...cur,
        ...derived,
        level: Math.min(100, (vol / maxVol) * 100),
        flowRateIn: inFlow,
        flowRateOut: outFlow,
      }
    } else if (node.type === 'LiquidTank' || node.type === 'ConicTank' || node.type === 'WfiGenerator') {
      const vol = cur.volume ?? (props.workingVolume ?? 100)
      const dt_h = config.dt / 3600
      const newVol = Math.max(0, vol + (inFlow - outFlow) * dt_h)
      newElements[node.id] = {
        ...cur,
        volume: newVol,
        level: Math.min(100, (newVol / maxVol) * 100),
        flowRateIn: inFlow,
        flowRateOut: outFlow,
      }
    } else {
      // Passthrough elements: centrifuge, chromatography column, etc.
      newElements[node.id] = { ...cur, flowRateIn: inFlow, flowRateOut: outFlow }
    }
  }

  return {
    time: state.time + config.dt,
    elements: newElements,
    links: newLinks,
  }
}

// ── 4th-order Runge–Kutta ─────────────────────────────────────────────────────

export function rk4Step(
  state: SimulationState,
  graph: PlantGraph,
  config: SimulationConfig,
): SimulationState {
  // k1
  const s1 = eulerStep(state, graph, config)
  // k2 — midpoint
  const midConfig: SimulationConfig = { ...config, dt: config.dt / 2 }
  const s2 = eulerStep(state, graph, midConfig)
  // k3 — midpoint from s2
  const s3 = eulerStep(s2, graph, midConfig)
  // k4 — full step from s3
  const s4 = eulerStep(s3, graph, config)

  // Combine: (k1 + 2*k2 + 2*k3 + k4) / 6
  const combined: SimulationState = { time: state.time + config.dt, elements: {}, links: {} }
  for (const id of Object.keys(state.elements)) {
    const e0 = state.elements[id]
    const e1 = s1.elements[id] ?? e0
    const e2 = s2.elements[id] ?? e0
    const e3 = s3.elements[id] ?? e0
    const e4 = s4.elements[id] ?? e0
    const avg = (k: keyof ElementSimState) => {
      const vals = [e1[k], e2[k], e3[k], e4[k]] as (number | undefined)[]
      const defined = vals.filter(v => v !== undefined) as number[]
      if (defined.length === 0) return e0[k]
      return (defined[0] + 2 * defined[1] + 2 * defined[2] + defined[3]) / 6
    }
    combined.elements[id] = {
      ...e0,
      biomass: avg('biomass') as number | undefined,
      substrate: avg('substrate') as number | undefined,
      dissolvedOxygen: avg('dissolvedOxygen') as number | undefined,
      pH: avg('pH') as number | undefined,
      volume: avg('volume') as number | undefined,
      level: avg('level') as number | undefined,
      product: avg('product') as number | undefined,
    }
  }
  combined.links = s4.links
  return combined
}

// ── Initial state factory ─────────────────────────────────────────────────────

export function createInitialState(graph: PlantGraph): SimulationState {
  const elements: Record<string, ElementSimState> = {}
  const links: Record<string, { flowRate: number; isActive: boolean }> = {}

  for (const node of graph.nodes) {
    const props = node.properties ?? {}
    elements[node.id] = {
      level: 50,
      volume: props.workingVolume,
      temperature: 37,
      pH: 7.0,
      dissolvedOxygen: 40,
      biomass: (node.type === 'Bioreactor' || node.type === 'Fermenter') ? 0.5 : undefined,
      substrate: (node.type === 'Bioreactor' || node.type === 'Fermenter') ? 5.0 : undefined,
      product: 0,
      pressure: 1.0,
    }
  }

  for (const edge of graph.edges) {
    links[edge.id] = { flowRate: 0, isActive: false }
  }

  return { time: 0, elements, links }
}

// ── Export utilities ──────────────────────────────────────────────────────────

export function formatSimTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m`
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${s}s`
}

export function generatePythonScript(graph: PlantGraph, config: SimulationConfig): string {
  const bioreactors = graph.nodes.filter(n => n.type === 'Bioreactor' || n.type === 'Fermenter')
  const nodeNames = bioreactors.map(n => n.name.replace(/\s+/g, '_').toLowerCase())

  const paramBlock = bioreactors.map((n, i) => {
    const p = n.properties
    return `    # ${n.name}
    'V_${nodeNames[i]}': ${p.workingVolume ?? 100},   # L working volume
    'kLa_${nodeNames[i]}': ${p.kLa ?? config.kLa},   # h^-1 oxygen transfer coefficient`
  }).join('\n')

  return `"""
Auto-generated simulation script from SCADA Lab Setup
Plant: ${graph.plantName}
Generated: ${new Date().toISOString()}

Dependencies: numpy, scipy
Install: pip install numpy scipy
"""

import numpy as np
from scipy.integrate import solve_ivp
import matplotlib.pyplot as plt

# ── Process parameters ────────────────────────────────────────────────────────

PARAMS = {
    # Kinetics (Monod model)
    'mu_max': ${config.muMax},    # h^-1  maximum specific growth rate
    'Ks':     ${config.Ks},      # g/L   substrate saturation constant
    'Y_xs':   ${config.yield_},  # g/g   biomass yield on substrate
    'Y_o2':   0.5,               # g/g   oxygen yield

    # Oxygen transfer
    'kLa':    ${config.kLa},     # h^-1  volumetric oxygen transfer coeff
    'C_star': 8.0,               # mg/L  DO saturation at 37°C

${paramBlock}
}

# ── Equipment nodes ───────────────────────────────────────────────────────────
NODES = ${JSON.stringify(graph.nodes.map(n => ({ id: n.id, type: n.type, name: n.name, volume: n.properties.workingVolume })), null, 2)}

# ── ODE system ────────────────────────────────────────────────────────────────

def monod(mu_max, Ks, S):
    """Monod specific growth rate [h^-1]"""
    return mu_max * S / (Ks + max(S, 1e-9))

def bioreactor_odes(t, y, p, F_in, F_out, C_feed=5.0):
    """
    State vector y = [X, S, DO, V]  per bioreactor
      X    g/L  viable cell density (biomass)
      S    g/L  substrate (glucose) concentration
      DO   %    dissolved oxygen saturation
      V    L    culture volume
    """
    X, S, DO, V = max(y[0], 0), max(y[1], 0), max(y[2], 0), max(y[3], 1)
    mu = monod(p['mu_max'], p['Ks'], S)

    co2_mgL = DO / 100 * p['C_star']
    OTR = p['kLa'] * (p['C_star'] - co2_mgL)   # mg/L/h
    OUR = mu * X / p['Y_o2'] * 1000            # mg/L/h (converted)

    dX = mu * X - (F_out / V) * X
    dS = -(mu / p['Y_xs']) * X + (F_in / V) * C_feed - (F_out / V) * S
    dDO_mgL = OTR - OUR - (F_out / V) * co2_mgL
    dDO = dDO_mgL / p['C_star'] * 100          # convert to %
    dV = F_in - F_out

    return [dX, dS, dDO, dV]

# ── Simulation ─────────────────────────────────────────────────────────────────

def run_simulation(t_end=24, F_in=5.0, F_out=5.0):
    """Run simulation for t_end hours."""
    y0 = [0.5, 5.0, 40.0, PARAMS.get('V_${nodeNames[0] ?? 'vessel'}', 100)]
    t_span = (0, t_end)
    t_eval = np.linspace(0, t_end, t_end * 60)  # 1-minute resolution

    sol = solve_ivp(
        lambda t, y: bioreactor_odes(t, y, PARAMS, F_in, F_out),
        t_span, y0, t_eval=t_eval,
        method='RK45', rtol=1e-4, atol=1e-6,
        dense_output=True
    )

    if not sol.success:
        print(f"Solver failed: {sol.message}")
        return sol

    t = sol.t
    X, S, DO, V = sol.y

    # ── Plot results ───────────────────────────────────────────────────────────
    fig, axes = plt.subplots(2, 2, figsize=(12, 8))
    fig.suptitle('${graph.plantName} — Bioreactor Simulation')

    axes[0, 0].plot(t, X, 'b-', label='Biomass (g/L)')
    axes[0, 0].set(xlabel='Time (h)', ylabel='g/L', title='Viable Cell Density')
    axes[0, 0].legend(); axes[0, 0].grid(True, alpha=0.3)

    axes[0, 1].plot(t, S, 'g-', label='Substrate (g/L)')
    axes[0, 1].set(xlabel='Time (h)', ylabel='g/L', title='Substrate Concentration')
    axes[0, 1].legend(); axes[0, 1].grid(True, alpha=0.3)

    axes[1, 0].plot(t, DO, 'c-', label='DO (%)')
    axes[1, 0].axhline(y=40, color='r', linestyle='--', alpha=0.5, label='Setpoint')
    axes[1, 0].set(xlabel='Time (h)', ylabel='% saturation', title='Dissolved Oxygen')
    axes[1, 0].legend(); axes[1, 0].grid(True, alpha=0.3)

    axes[1, 1].plot(t, V, 'm-', label='Volume (L)')
    axes[1, 1].set(xlabel='Time (h)', ylabel='L', title='Culture Volume')
    axes[1, 1].legend(); axes[1, 1].grid(True, alpha=0.3)

    plt.tight_layout()
    plt.savefig('simulation_results.png', dpi=150)
    plt.show()
    print(f"Final state: X={X[-1]:.2f} g/L, S={S[-1]:.2f} g/L, DO={DO[-1]:.1f}%")
    return sol

if __name__ == '__main__':
    run_simulation(t_end=72, F_in=2.0, F_out=2.0)
`
}

export function exportToJSON(graph: PlantGraph, simState: SimulationState | null): string {
  return JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    plant: graph,
    simulationState: simState,
    metadata: {
      tool: 'SCADA Lab Setup',
      format: 'BioReactorAgent PlantGraph v1',
    },
  }, null, 2)
}
