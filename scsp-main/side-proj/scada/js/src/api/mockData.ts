import type {
  Reactor,
  ReactorTimeSeries,
  DataPoint,
  AgentAction,
  Facility,
  ReactorStatus,
  METRIC_THRESHOLDS,
} from '../types'

const THRESHOLDS = {
  pH: { min: 6.8, max: 7.4, optimal: 7.0 },
  dissolvedOxygen: { min: 30, max: 60, optimal: 45 },
  temperature: { min: 35.5, max: 37.5, optimal: 36.5 },
  viableCellDensity: { min: 0, max: 25, optimal: 15 },
}

function randomInRange(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

function determineStatus(metrics: Reactor['metrics']): ReactorStatus {
  const { pH, dissolvedOxygen, temperature } = metrics

  const pHCritical = pH < 6.5 || pH > 7.6
  const doCritical = dissolvedOxygen < 20 || dissolvedOxygen > 70
  const tempCritical = temperature < 34 || temperature > 39

  if (pHCritical || doCritical || tempCritical) return 'CRITICAL'

  const pHWarn = pH < THRESHOLDS.pH.min || pH > THRESHOLDS.pH.max
  const doWarn = dissolvedOxygen < THRESHOLDS.dissolvedOxygen.min || dissolvedOxygen > THRESHOLDS.dissolvedOxygen.max
  const tempWarn = temperature < THRESHOLDS.temperature.min || temperature > THRESHOLDS.temperature.max

  if (pHWarn || doWarn || tempWarn) return 'WARN'

  return 'PASS'
}

function generateReactorMetrics(baseDay: number, reactorIndex: number): Reactor['metrics'] {
  const growthPhase = Math.min(baseDay / 14, 1)
  
  const pHDrift = reactorIndex === 3 ? -0.3 : (Math.random() - 0.5) * 0.2
  const doDrift = reactorIndex === 1 ? -8 : (Math.random() - 0.5) * 5
  
  return {
    pH: 7.0 + pHDrift + (Math.random() - 0.5) * 0.1,
    dissolvedOxygen: 45 + doDrift + (Math.random() - 0.5) * 3,
    temperature: 36.5 + (Math.random() - 0.5) * 0.3,
    viableCellDensity: growthPhase * 20 + (Math.random() - 0.5) * 2,
    antibodyTiter: growthPhase * growthPhase * 800 + (Math.random() - 0.5) * 50,
  }
}

export function generateReactors(dayOfRun: number = 7): Reactor[] {
  const reactorConfigs = [
    { id: 'BR-001', name: 'Bioreactor 1', zone: 'cleanroom-a', position: { x: 150, y: 120 } },
    { id: 'BR-002', name: 'Bioreactor 2', zone: 'cleanroom-a', position: { x: 350, y: 120 } },
    { id: 'BR-003', name: 'Bioreactor 3', zone: 'cleanroom-b', position: { x: 150, y: 280 } },
    { id: 'BR-004', name: 'Bioreactor 4', zone: 'cleanroom-b', position: { x: 350, y: 280 } },
  ]

  return reactorConfigs.map((config, index) => {
    const metrics = generateReactorMetrics(dayOfRun, index)
    return {
      ...config,
      metrics,
      status: determineStatus(metrics),
    }
  })
}

export function generateTimeSeries(dayOfRun: number = 7): ReactorTimeSeries[] {
  const reactorIds = ['BR-001', 'BR-002', 'BR-003', 'BR-004']
  const hoursPerPoint = 4
  const totalPoints = Math.floor((dayOfRun * 24) / hoursPerPoint)

  return reactorIds.map((reactorId, reactorIndex) => {
    const data: DataPoint[] = []
    
    let pH = 7.0
    let dissolvedOxygen = 45
    let temperature = 36.5
    let viableCellDensity = 0.5

    for (let i = 0; i < totalPoints; i++) {
      const dayFraction = (i * hoursPerPoint) / 24
      const growthRate = Math.exp(-0.5 * Math.pow((dayFraction - 10) / 5, 2))

      pH += (Math.random() - 0.52) * 0.02
      if (reactorIndex === 3 && dayFraction > 5) pH -= 0.005

      dissolvedOxygen += (Math.random() - 0.5) * 1
      dissolvedOxygen = Math.max(25, Math.min(65, dissolvedOxygen))
      if (reactorIndex === 1 && dayFraction > 4) dissolvedOxygen -= 0.3

      temperature += (Math.random() - 0.5) * 0.1
      temperature = Math.max(35, Math.min(38, temperature))

      viableCellDensity += growthRate * 0.3 + (Math.random() - 0.5) * 0.1
      viableCellDensity = Math.max(0, viableCellDensity)

      const timestamp = new Date()
      timestamp.setDate(timestamp.getDate() - dayOfRun)
      timestamp.setHours(timestamp.getHours() + i * hoursPerPoint)

      data.push({
        timestamp,
        pH: Math.round(pH * 100) / 100,
        dissolvedOxygen: Math.round(dissolvedOxygen * 10) / 10,
        temperature: Math.round(temperature * 10) / 10,
        viableCellDensity: Math.round(viableCellDensity * 10) / 10,
      })
    }

    return { reactorId, data }
  })
}

const ACTION_TEMPLATES = [
  { action: 'Adjusted feed rate', reasoning: 'Glucose levels dropping below optimal range. Increasing feed rate by {value}% to maintain cell growth.' },
  { action: 'Modified pH setpoint', reasoning: 'pH trending {direction}. Adjusting CO2 sparging to bring pH back to target range of 6.8-7.4.' },
  { action: 'Increased agitation', reasoning: 'Dissolved oxygen falling below 35%. Increasing impeller speed to improve oxygen transfer.' },
  { action: 'Temperature adjustment', reasoning: 'Temperature deviation detected. Adjusting heating jacket to maintain 36.5°C ± 0.5°C.' },
  { action: 'Nutrient bolus added', reasoning: 'VCD growth rate slowing. Adding amino acid supplement to support continued exponential growth.' },
  { action: 'Process alert generated', reasoning: 'Multiple parameters approaching threshold limits. Flagging for operator review.' },
  { action: 'Anti-foam addition', reasoning: 'Foam level sensor triggered. Administering anti-foam agent to prevent overflow.' },
  { action: 'Harvest timing updated', reasoning: 'Based on VCD and titer trends, optimal harvest window predicted in {value} hours.' },
]

export function generateAgentActions(count: number = 20): AgentAction[] {
  const actions: AgentAction[] = []
  const reactorIds = ['BR-001', 'BR-002', 'BR-003', 'BR-004']
  const now = new Date()

  for (let i = 0; i < count; i++) {
    const template = ACTION_TEMPLATES[Math.floor(Math.random() * ACTION_TEMPLATES.length)]
    const reactorId = reactorIds[Math.floor(Math.random() * reactorIds.length)]
    const minutesAgo = i * 15 + Math.floor(Math.random() * 10)
    
    const timestamp = new Date(now.getTime() - minutesAgo * 60 * 1000)
    const value = Math.floor(Math.random() * 10) + 1
    const direction = Math.random() > 0.5 ? 'upward' : 'downward'

    let severity: AgentAction['severity'] = 'info'
    if (template.action.includes('alert')) severity = 'critical'
    else if (template.action.includes('adjustment') || template.action.includes('Modified')) severity = 'warning'

    actions.push({
      id: `action-${i}-${Date.now()}`,
      timestamp,
      reactorId,
      action: template.action,
      reasoning: template.reasoning.replace('{value}', String(value)).replace('{direction}', direction),
      severity,
      parameters: { value },
    })
  }

  return actions.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

export function generateFacility(): Facility {
  return {
    dimensions: { width: 500, height: 400 },
    zones: [
      {
        id: 'cleanroom-a',
        name: 'Cleanroom Suite A',
        classification: 'ISO 7',
        bounds: { x: 50, y: 50, width: 400, height: 130 },
      },
      {
        id: 'cleanroom-b',
        name: 'Cleanroom Suite B',
        classification: 'ISO 7',
        bounds: { x: 50, y: 200, width: 400, height: 130 },
      },
      {
        id: 'corridor',
        name: 'Clean Corridor',
        classification: 'ISO 8',
        bounds: { x: 50, y: 180, width: 400, height: 20 },
      },
    ],
  }
}
