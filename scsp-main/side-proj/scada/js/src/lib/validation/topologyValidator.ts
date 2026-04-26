import type {
  ValidationIssue,
  MaterialBalance,
  PlantGraph,
  GraphEdge,
  HazopDeviation,
} from '../../types'

// ── Adjacency helpers ─────────────────────────────────────────────────────────

function buildAdjacency(edges: GraphEdge[]) {
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    if (!incoming.has(edge.target)) incoming.set(edge.target, [])
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
  }
  return { outgoing, incoming }
}

const VESSEL_TYPES = new Set(['LiquidTank', 'ConicTank', 'Bioreactor', 'Fermenter', 'WfiGenerator', 'ChilledWaterUnit'])
const PROCESS_VESSEL_TYPES = new Set(['LiquidTank', 'Bioreactor', 'Fermenter', 'ChromatographyColumn', 'UfDfSkid'])
const IGNORABLE_TYPES = new Set(['Zone', 'Join', 'InstrumentLoop'])

// ── Check 1: Isolated elements ────────────────────────────────────────────────

function findIsolatedElements(graph: PlantGraph): ValidationIssue[] {
  const connectedIds = new Set<string>()
  for (const edge of graph.edges) {
    connectedIds.add(edge.source)
    connectedIds.add(edge.target)
  }
  return graph.nodes
    .filter(n => !IGNORABLE_TYPES.has(n.type) && !connectedIds.has(n.id))
    .map(n => ({
      id: `isolated-${n.id}`,
      severity: 'warning' as const,
      category: 'topology' as const,
      elementIds: [n.id],
      message: `${n.name} is not connected`,
      explanation: 'Equipment with no pipe connections cannot participate in any process flow.',
      suggestedFix: 'Add pipe connections to integrate this equipment into the flow path.',
      timestamp: new Date(),
    }))
}

// ── Check 2: Tanks without balanced inlets/outlets ────────────────────────────

function findUnbalancedTankConnections(graph: PlantGraph): ValidationIssue[] {
  const { incoming, outgoing } = buildAdjacency(graph.edges)
  const issues: ValidationIssue[] = []

  for (const node of graph.nodes) {
    if (!VESSEL_TYPES.has(node.type)) continue
    const inCount = (incoming.get(node.id) || []).length
    const outCount = (outgoing.get(node.id) || []).length

    if (inCount === 0 && outCount > 0) {
      issues.push({
        id: `no-inlet-${node.id}`,
        severity: 'error',
        category: 'topology',
        elementIds: [node.id],
        message: `${node.name} has no inlet`,
        explanation: 'A vessel with only outlets drains continuously and cannot sustain a process.',
        suggestedFix: 'Add at least one inlet pipe or a recirculation return line.',
        timestamp: new Date(),
      })
    } else if (outCount === 0 && inCount > 0) {
      issues.push({
        id: `no-outlet-${node.id}`,
        severity: 'error',
        category: 'topology',
        elementIds: [node.id],
        message: `${node.name} has no outlet`,
        explanation: 'A vessel with only inlets will overflow with no discharge path.',
        suggestedFix: 'Add an outlet, overflow, or harvest pipe.',
        timestamp: new Date(),
      })
    }
  }
  return issues
}

// ── Check 3: Opposing / conflicting pumps ─────────────────────────────────────

function findOpposingPumps(graph: PlantGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const pumps = graph.nodes.filter(n => n.type === 'Pump')

  const edgeMap = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!edgeMap.has(edge.source)) edgeMap.set(edge.source, [])
    edgeMap.get(edge.source)!.push(edge.target)
  }

  for (const pump of pumps) {
    // BFS from this pump's downstream — if we reach another pump without a tank buffer, flag it
    const visited = new Set<string>()
    const queue: string[] = [pump.id]
    visited.add(pump.id)

    while (queue.length > 0) {
      const current = queue.shift()!
      const currentNode = graph.nodes.find(n => n.id === current)

      // Stop at vessels — a buffer vessel between pumps is acceptable
      if (current !== pump.id && currentNode && VESSEL_TYPES.has(currentNode.type)) continue

      for (const next of edgeMap.get(current) || []) {
        if (visited.has(next)) continue
        visited.add(next)
        const nextNode = graph.nodes.find(n => n.id === next)

        if (nextNode?.type === 'Pump') {
          issues.push({
            id: `opposing-pumps-${pump.id}-${next}`,
            severity: 'warning',
            category: 'topology',
            elementIds: [pump.id, next],
            message: `${pump.name} and ${nextNode.name} are in series without a buffer vessel`,
            explanation:
              'Two pumps in direct series can cause pressure conflicts, cavitation, and seal damage.',
            suggestedFix:
              'Insert a buffer/surge tank between the pumps, or verify both pumps are not operating simultaneously.',
            timestamp: new Date(),
          })
        } else {
          queue.push(next)
        }
      }
    }
  }
  return issues
}

// ── Check 4: Dead legs ────────────────────────────────────────────────────────

function findDeadLegs(graph: PlantGraph): ValidationIssue[] {
  const { incoming, outgoing } = buildAdjacency(graph.edges)
  const terminusTypes = new Set(['HandValve', 'ControlValve', 'Join'])

  return graph.nodes
    .filter(n => terminusTypes.has(n.type))
    .filter(n => {
      const hasOut = (outgoing.get(n.id) || []).length > 0
      const hasIn = (incoming.get(n.id) || []).length > 0
      return hasIn && !hasOut
    })
    .map(n => ({
      id: `deadleg-${n.id}`,
      severity: 'warning' as const,
      category: 'topology' as const,
      elementIds: [n.id],
      message: `Potential dead leg at ${n.name}`,
      explanation:
        'Dead-leg pipe segments (no continuous flow) accumulate bioburden and resist CIP cleaning, posing a contamination risk.',
      suggestedFix:
        'Terminate at a vessel, add a flush/drain, or incorporate into the CIP return loop.',
      timestamp: new Date(),
    }))
}

// ── Check 5: Missing CIP paths ────────────────────────────────────────────────

function findMissingCIPPaths(graph: PlantGraph): ValidationIssue[] {
  const { incoming } = buildAdjacency(graph.edges)

  return graph.nodes
    .filter(n => PROCESS_VESSEL_TYPES.has(n.type))
    .filter(n => {
      if (n.properties?.cipPath) return false
      const inlets = incoming.get(n.id) || []
      return !inlets.some(srcId => {
        const src = graph.nodes.find(x => x.id === srcId)
        return src?.type === 'TransferPanel'
      })
    })
    .map(n => ({
      id: `no-cip-${n.id}`,
      severity: 'warning' as const,
      category: 'topology' as const,
      elementIds: [n.id],
      message: `${n.name} has no CIP supply identified`,
      explanation:
        'Process vessels must have validated CIP circuits to satisfy GMP cleaning requirements.',
      suggestedFix:
        'Add a CIP supply connection via a Transfer Panel and ensure a return path is present.',
      timestamp: new Date(),
    }))
}

// ── Material balance ──────────────────────────────────────────────────────────

export function computeMaterialBalance(graph: PlantGraph): MaterialBalance[] {
  const results: MaterialBalance[] = []
  const balanceableTypes = [...VESSEL_TYPES, 'Join']

  for (const node of graph.nodes) {
    if (!balanceableTypes.includes(node.type)) continue

    const inEdges = graph.edges.filter(e => e.target === node.id)
    const outEdges = graph.edges.filter(e => e.source === node.id)

    if (inEdges.length === 0 && outEdges.length === 0) continue

    const inflow = inEdges.reduce((s, e) => s + (e.flowRate ?? 1), 0)
    const outflow = outEdges.reduce((s, e) => s + (e.flowRate ?? 1), 0)
    const total = Math.max(inflow, outflow, 0.001)
    const discrepancyPct = (Math.abs(inflow - outflow) / total) * 100

    results.push({
      elementId: node.id,
      elementName: node.name,
      inflow,
      outflow,
      discrepancyPct,
      isBalanced: discrepancyPct <= 5,
    })
  }
  return results
}

// ── HAZOP catalog ─────────────────────────────────────────────────────────────

type HazopEntry = Omit<HazopDeviation, 'id' | 'engineerResponse'>

const HAZOP_CATALOG: Record<string, HazopEntry[]> = {
  Pump: [
    { guideword: 'NO', parameter: 'Flow', riskLevel: 'high', cause: 'Pump failure, cavitation, blocked inlet', consequence: 'Loss of process flow, downstream vessel drains' },
    { guideword: 'MORE', parameter: 'Flow', riskLevel: 'medium', cause: 'Valve position error, pump over-speed', consequence: 'Tank overflow, pressure surge, line rupture' },
    { guideword: 'REVERSE', parameter: 'Flow', riskLevel: 'critical', cause: 'Check valve failure during pump shutdown', consequence: 'Back-contamination of upstream vessel, pump damage' },
    { guideword: 'LESS', parameter: 'Flow', riskLevel: 'medium', cause: 'Partial blockage, wear, cavitation', consequence: 'Under-processing, concentration errors' },
  ],
  LiquidTank: [
    { guideword: 'MORE', parameter: 'Level', riskLevel: 'medium', cause: 'Inlet valve fails open, outlet blocked', consequence: 'Tank overflow, product loss, floor contamination' },
    { guideword: 'NO', parameter: 'Level', riskLevel: 'high', cause: 'Outlet fails open, inlet blocked', consequence: 'Empty vessel, downstream pump cavitation' },
    { guideword: 'MORE', parameter: 'Temperature', riskLevel: 'high', cause: 'Cooling failure, exothermic reaction', consequence: 'Product degradation, pressure build-up' },
  ],
  Bioreactor: [
    { guideword: 'NO', parameter: 'Agitation', riskLevel: 'critical', cause: 'Agitator motor failure, seal failure', consequence: 'Oxygen depletion, cell death, batch loss' },
    { guideword: 'MORE', parameter: 'Dissolved Oxygen', riskLevel: 'medium', cause: 'Aeration rate too high, demand drops', consequence: 'Foam generation, cell mechanical damage, filter blockage' },
    { guideword: 'NO', parameter: 'Dissolved Oxygen', riskLevel: 'critical', cause: 'Sparger blocked, agitator failure, air supply loss', consequence: 'Anaerobic conditions, cell death, batch loss' },
    { guideword: 'LESS', parameter: 'pH', riskLevel: 'high', cause: 'CO₂ accumulation, base supply failure', consequence: 'Cell stress, reduced productivity, potential cell death' },
    { guideword: 'MORE', parameter: 'pH', riskLevel: 'high', cause: 'Acid supply failure, base excess', consequence: 'Cell stress, product quality impact' },
    { guideword: 'LESS', parameter: 'Temperature', riskLevel: 'medium', cause: 'Heating failure, chilled water excess', consequence: 'Reduced growth rate, extended culture duration' },
  ],
  ControlValve: [
    { guideword: 'MORE', parameter: 'Open', riskLevel: 'high', cause: 'Actuator failure, control signal loss (fail-open)', consequence: 'Uncontrolled flow rate, vessel overflow' },
    { guideword: 'NO', parameter: 'Open', riskLevel: 'high', cause: 'Actuator failure, valve seized (fail-closed)', consequence: 'Loss of flow, process interruption' },
  ],
  ChromatographyColumn: [
    { guideword: 'MORE', parameter: 'Pressure', riskLevel: 'high', cause: 'Column fouling, overpacking, blocked outlet', consequence: 'Column damage, resin compression, bed cracking' },
    { guideword: 'OTHER THAN', parameter: 'Buffer', riskLevel: 'critical', cause: 'Wrong buffer connected, cross-contamination', consequence: 'Column regeneration failure, product loss' },
  ],
  UfDfSkid: [
    { guideword: 'MORE', parameter: 'TMP', riskLevel: 'high', cause: 'Retentate valve too closed, blocked permeate', consequence: 'Membrane fouling, flux loss, membrane rupture' },
    { guideword: 'NO', parameter: 'Permeate', riskLevel: 'high', cause: 'Membrane blockage, failed TMP control', consequence: 'Concentration factor error, product loss' },
  ],
}

export function generateHazopDeviations(elementType: string, elementId: string): HazopDeviation[] {
  const entries = HAZOP_CATALOG[elementType] ?? HAZOP_CATALOG['LiquidTank']
  return entries.map((entry, i) => ({
    ...entry,
    id: `hazop-${elementId}-${i}`,
    engineerResponse: '',
  }))
}

// ── Main validation entry point ───────────────────────────────────────────────

export interface ValidationOptions {
  deadLegThreshold?: number
  skipCIPCheck?: boolean
}

export function validatePlant(graph: PlantGraph, options: ValidationOptions = {}): ValidationIssue[] {
  if (graph.nodes.length === 0) return []

  const issues: ValidationIssue[] = [
    ...findIsolatedElements(graph),
    ...findUnbalancedTankConnections(graph),
    ...findOpposingPumps(graph),
    ...findDeadLegs(graph),
  ]

  if (!options.skipCIPCheck) {
    issues.push(...findMissingCIPPaths(graph))
  }

  // Material balance discrepancies > 5%
  const balances = computeMaterialBalance(graph)
  for (const bal of balances) {
    if (!bal.isBalanced) {
      issues.push({
        id: `balance-${bal.elementId}`,
        severity: bal.discrepancyPct > 20 ? 'error' : 'warning',
        category: 'balance',
        elementIds: [bal.elementId],
        message: `${bal.elementName}: ${bal.discrepancyPct.toFixed(1)}% material-balance discrepancy`,
        explanation: `Inflow (${bal.inflow.toFixed(2)}) vs outflow (${bal.outflow.toFixed(2)}) differ by more than 5%, indicating a process imbalance.`,
        suggestedFix:
          'Review valve positions, flow rates, and recirculation ratios to reach steady-state balance.',
        timestamp: new Date(),
      })
    }
  }

  const severityOrder: Record<string, number> = { error: 0, warning: 1, info: 2 }
  return issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
}
