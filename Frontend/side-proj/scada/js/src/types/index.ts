export type ReactorStatus = 'PASS' | 'WARN' | 'CRITICAL'

export interface ReactorMetrics {
  pH: number
  dissolvedOxygen: number
  temperature: number
  viableCellDensity: number
  antibodyTiter: number
}

export interface Reactor {
  id: string
  name: string
  status: ReactorStatus
  metrics: ReactorMetrics
  position: { x: number; y: number }
  zone: string
  anomalies?: unknown[]
  strategy?: string
}

export interface DataPoint {
  timestamp: Date
  pH: number
  dissolvedOxygen: number
  temperature: number
  viableCellDensity: number
}

export interface ReactorTimeSeries {
  reactorId: string
  data: DataPoint[]
}

export interface AgentAction {
  id: string
  timestamp: Date
  reactorId: string
  action: string
  reasoning: string
  severity: 'info' | 'warning' | 'critical'
  parameters?: Record<string, number>
}

export interface Zone {
  id: string
  name: string
  classification: string
  bounds: { x: number; y: number; width: number; height: number }
}

export interface Facility {
  zones: Zone[]
  dimensions: { width: number; height: number }
}

export interface MetricThresholds {
  pH: { min: number; max: number; optimal: number }
  dissolvedOxygen: { min: number; max: number; optimal: number }
  temperature: { min: number; max: number; optimal: number }
  viableCellDensity: { min: number; max: number; optimal: number }
}

export const METRIC_THRESHOLDS: MetricThresholds = {
  pH: { min: 6.8, max: 7.4, optimal: 7.0 },
  dissolvedOxygen: { min: 30, max: 60, optimal: 45 },
  temperature: { min: 35.5, max: 37.5, optimal: 36.5 },
  viableCellDensity: { min: 0, max: 25, optimal: 15 },
}

export const REACTOR_COLORS: Record<string, string> = {
  'BR-001': '#3b82f6',
  'BR-002': '#8b5cf6',
  'BR-003': '#06b6d4',
  'BR-004': '#f97316',
}

// ── Validation types (FR1) ─────────────────────────────────────────────────────

export type ValidationSeverity = 'error' | 'warning' | 'info'
export type ValidationCategory = 'topology' | 'balance' | 'hazop'

export interface ValidationIssue {
  id: string
  severity: ValidationSeverity
  category: ValidationCategory
  elementIds: string[]
  message: string
  explanation: string
  suggestedFix: string
  timestamp: Date
}

export interface MaterialBalance {
  elementId: string
  elementName: string
  inflow: number
  outflow: number
  discrepancyPct: number
  isBalanced: boolean
}

export interface HazopDeviation {
  id: string
  guideword: string
  parameter: string
  cause: string
  consequence: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  engineerResponse: string
}

// ── Equipment types (FR3) ──────────────────────────────────────────────────────

export type EquipmentScale = 'lab' | 'pilot' | 'production'

export interface EquipmentProperties {
  workingVolume?: number    // L
  maxVolume?: number        // L
  kLa?: number             // h^-1
  doSetpoint?: number      // %
  agitatorPower?: number   // W/m^3
  impellerSpeed?: number   // RPM
  heatTransferArea?: number // m^2
  uValue?: number          // W/(m^2·K)
  residenceTime?: number   // h
  headspace?: number       // L
  spargeRate?: number      // L/min
  scale?: EquipmentScale
  cipPath?: boolean
  sipPath?: boolean
  zoneClassification?: string // ISO 5, ISO 7, ISO 8
}

// ── Simulation types (FR2) ─────────────────────────────────────────────────────

export interface SimulationConfig {
  dt: number          // seconds per step
  solver: 'euler' | 'rk4'
  muMax: number       // h^-1 max growth rate
  Ks: number          // g/L substrate saturation constant
  kLa: number         // h^-1 oxygen transfer coeff
  yield_: number      // g_biomass/g_substrate (yield_ to avoid reserved word)
  speedMultiplier: number
}

export interface ElementSimState {
  level?: number           // % fill
  volume?: number          // L
  temperature?: number     // °C
  pH?: number
  dissolvedOxygen?: number // % saturation
  biomass?: number         // g/L
  substrate?: number       // g/L
  product?: number         // g/L (antibody titer in mg/L)
  pressure?: number        // bar
  flowRateIn?: number      // L/h
  flowRateOut?: number     // L/h
}

export interface SimulationState {
  time: number  // seconds elapsed
  elements: Record<string, ElementSimState>
  links: Record<string, { flowRate: number; isActive: boolean }>
}

// ── Graph serialization (for validation) ──────────────────────────────────────

export interface GraphNode {
  id: string
  type: string
  name: string
  properties: EquipmentProperties
  simState?: ElementSimState
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  flowRate?: number
}

export interface PlantGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  plantName: string
}
