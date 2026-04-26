import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
  Brush,
} from 'recharts'
import type { Reactor, ReactorTimeSeries } from '../../types'
import { REACTOR_COLORS, METRIC_THRESHOLDS } from '../../types'

interface TimeSeriesChartsProps {
  timeSeries: ReactorTimeSeries[]
  reactors: Reactor[]
  selectedReactorId: string | null
}

type MetricKey = 'pH' | 'dissolvedOxygen' | 'temperature' | 'viableCellDensity'

interface ChartConfig {
  key: MetricKey
  label: string
  unit: string
  domain: [number, number]
  thresholds: { min: number; max: number }
}

const CHART_CONFIGS: ChartConfig[] = [
  { key: 'pH', label: 'pH', unit: '', domain: [6.0, 8.0], thresholds: METRIC_THRESHOLDS.pH },
  { key: 'dissolvedOxygen', label: 'Dissolved Oxygen', unit: '%', domain: [0, 80], thresholds: METRIC_THRESHOLDS.dissolvedOxygen },
  { key: 'temperature', label: 'Temperature', unit: '°C', domain: [34, 39], thresholds: METRIC_THRESHOLDS.temperature },
  { key: 'viableCellDensity', label: 'Viable Cell Density', unit: '×10⁶/mL', domain: [0, 30], thresholds: METRIC_THRESHOLDS.viableCellDensity },
]

export function TimeSeriesCharts({ timeSeries, reactors, selectedReactorId }: TimeSeriesChartsProps) {
  const mergedData = mergeTimeSeriesData(timeSeries)
  const visibleReactors = selectedReactorId 
    ? reactors.filter(r => r.id === selectedReactorId)
    : reactors

  return (
    <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Process Trends</h2>
        <span className="text-xs text-slate-400">
          {selectedReactorId ? `Showing: ${selectedReactorId}` : 'All Reactors'}
        </span>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 min-h-0">
        {CHART_CONFIGS.map(config => (
          <MetricChart
            key={config.key}
            config={config}
            data={mergedData}
            visibleReactors={visibleReactors}
          />
        ))}
      </div>
    </div>
  )
}

interface MetricChartProps {
  config: ChartConfig
  data: MergedDataPoint[]
  visibleReactors: Reactor[]
}

function MetricChart({ config, data, visibleReactors }: MetricChartProps) {
  const formatXAxis = (timestamp: number) => {
    const date = new Date(timestamp)
    return `Day ${Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24))}`
  }

  const formatTooltipLabel = (timestamp: number) => {
    return new Date(timestamp).toLocaleString()
  }

  return (
    <div className="bg-slate-900/50 rounded-lg p-3">
      <h3 className="text-sm font-medium text-slate-300 mb-2">
        {config.label}
        {config.unit && <span className="text-slate-500 ml-1">({config.unit})</span>}
      </h3>
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatXAxis}
            tick={{ fill: '#64748b', fontSize: 10 }}
            stroke="#475569"
          />
          <YAxis
            domain={config.domain}
            tick={{ fill: '#64748b', fontSize: 10 }}
            stroke="#475569"
            width={35}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '8px',
            }}
            labelFormatter={formatTooltipLabel}
            labelStyle={{ color: '#94a3b8' }}
          />
          
          <ReferenceLine
            y={config.thresholds.min}
            stroke="#eab308"
            strokeDasharray="3 3"
            strokeOpacity={0.5}
          />
          <ReferenceLine
            y={config.thresholds.max}
            stroke="#eab308"
            strokeDasharray="3 3"
            strokeOpacity={0.5}
          />

          {visibleReactors.map(reactor => (
            <Line
              key={reactor.id}
              type="monotone"
              dataKey={`${reactor.id}_${config.key}`}
              stroke={REACTOR_COLORS[reactor.id]}
              strokeWidth={2}
              dot={false}
              name={reactor.name}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

interface MergedDataPoint {
  timestamp: number
  [key: string]: number
}

function mergeTimeSeriesData(timeSeries: ReactorTimeSeries[]): MergedDataPoint[] {
  const dataMap = new Map<number, MergedDataPoint>()

  timeSeries.forEach(({ reactorId, data }) => {
    data.forEach(point => {
      const timestamp = new Date(point.timestamp).getTime()
      const existing = dataMap.get(timestamp) || { timestamp }
      
      existing[`${reactorId}_pH`] = point.pH
      existing[`${reactorId}_dissolvedOxygen`] = point.dissolvedOxygen
      existing[`${reactorId}_temperature`] = point.temperature
      existing[`${reactorId}_viableCellDensity`] = point.viableCellDensity
      
      dataMap.set(timestamp, existing)
    })
  })

  return Array.from(dataMap.values()).sort((a, b) => a.timestamp - b.timestamp)
}
