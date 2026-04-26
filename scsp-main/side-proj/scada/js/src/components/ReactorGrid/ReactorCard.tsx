import type { Reactor, ReactorStatus } from '../../types'
import { REACTOR_COLORS } from '../../types'

interface ReactorCardProps {
  reactor: Reactor
  isSelected: boolean
  onSelect: (id: string) => void
}

const STATUS_CONFIG: Record<ReactorStatus, { bg: string; text: string; border: string; pulse?: boolean }> = {
  PASS: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/50' },
  WARN: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/50' },
  CRITICAL: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/50', pulse: true },
}

export function ReactorCard({ reactor, isSelected, onSelect }: ReactorCardProps) {
  const statusConfig = STATUS_CONFIG[reactor.status]
  const accentColor = REACTOR_COLORS[reactor.id] || '#3b82f6'

  return (
    <div
      onClick={() => onSelect(reactor.id)}
      className={`
        relative cursor-pointer rounded-lg border-2 p-4 transition-all duration-200
        ${isSelected ? 'ring-2 ring-blue-500/50 scale-[1.02] border-blue-500/50' : 'hover:scale-[1.01]'}
        ${statusConfig.pulse ? 'animate-pulse-critical' : ''}
        bg-slate-800 border-slate-700 hover:border-slate-600 hover:bg-slate-800/80
      `}
    >
      <div
        className="absolute top-0 left-0 w-1 h-full rounded-l-lg"
        style={{ backgroundColor: accentColor }}
      />

      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-white">{reactor.name}</h3>
          <p className="text-xs text-slate-400">{reactor.id}</p>
        </div>
        <span className={`px-2 py-1 rounded text-xs font-bold ${statusConfig.bg} ${statusConfig.text}`}>
          {reactor.status}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-sm">
        <MetricDisplay
          label="pH"
          value={reactor.metrics.pH.toFixed(2)}
          status={getMetricStatus(reactor.metrics.pH, 6.8, 7.4)}
        />
        <MetricDisplay
          label="DO"
          value={`${reactor.metrics.dissolvedOxygen.toFixed(1)}%`}
          status={getMetricStatus(reactor.metrics.dissolvedOxygen, 30, 60)}
        />
        <MetricDisplay
          label="Temp"
          value={`${reactor.metrics.temperature.toFixed(1)}°C`}
          status={getMetricStatus(reactor.metrics.temperature, 35.5, 37.5)}
        />
        <MetricDisplay
          label="VCD"
          value={`${reactor.metrics.viableCellDensity.toFixed(1)}`}
          unit="×10⁶/mL"
          status="neutral"
        />
      </div>

      <div className="mt-3 pt-3 border-t border-slate-700">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-400">Antibody Titer</span>
          <span className="font-semibold text-white">
            {reactor.metrics.antibodyTiter.toFixed(0)} mg/L
          </span>
        </div>
      </div>
    </div>
  )
}

interface MetricDisplayProps {
  label: string
  value: string
  unit?: string
  status: 'good' | 'warn' | 'critical' | 'neutral'
}

function MetricDisplay({ label, value, unit, status }: MetricDisplayProps) {
  const statusColors = {
    good: 'text-green-400',
    warn: 'text-yellow-400',
    critical: 'text-red-400',
    neutral: 'text-slate-300',
  }

  return (
    <div className="flex flex-col">
      <span className="text-xs text-slate-500">{label}</span>
      <span className={`font-mono font-semibold ${statusColors[status]}`}>
        {value}
        {unit && <span className="text-xs text-slate-500 ml-1">{unit}</span>}
      </span>
    </div>
  )
}

function getMetricStatus(value: number, min: number, max: number): 'good' | 'warn' | 'critical' {
  const criticalMargin = (max - min) * 0.3
  if (value < min - criticalMargin || value > max + criticalMargin) return 'critical'
  if (value < min || value > max) return 'warn'
  return 'good'
}
