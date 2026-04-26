import type { Reactor } from '../../types'
import { REACTOR_COLORS } from '../../types'

interface ExperimentListProps {
  reactors: Reactor[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onViewPID: (id: string) => void
}

export function ExperimentList({ reactors, selectedId, onSelect, onViewPID }: ExperimentListProps) {
  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <h2 className="text-lg font-semibold text-white">Active Experiments</h2>
        <p className="text-xs text-slate-500">Click to select, double-click for P&ID</p>
      </div>
      
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {reactors.map(reactor => (
          <ExperimentCard
            key={reactor.id}
            reactor={reactor}
            isSelected={selectedId === reactor.id}
            onSelect={() => onSelect(selectedId === reactor.id ? null : reactor.id)}
            onViewPID={() => onViewPID(reactor.id)}
          />
        ))}
      </div>

      <div className="p-3 border-t border-slate-700">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <StatusSummary reactors={reactors} status="PASS" label="Normal" color="bg-green-500" />
          <StatusSummary reactors={reactors} status="WARN" label="Warning" color="bg-yellow-500" />
          <StatusSummary reactors={reactors} status="CRITICAL" label="Critical" color="bg-red-500" />
        </div>
      </div>
    </div>
  )
}

interface ExperimentCardProps {
  reactor: Reactor
  isSelected: boolean
  onSelect: () => void
  onViewPID: () => void
}

function ExperimentCard({ reactor, isSelected, onSelect, onViewPID }: ExperimentCardProps) {
  const statusConfig = {
    PASS: { bg: 'bg-green-500/20', text: 'text-green-400', border: 'border-green-500/50' },
    WARN: { bg: 'bg-yellow-500/20', text: 'text-yellow-400', border: 'border-yellow-500/50' },
    CRITICAL: { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/50', pulse: true },
  }
  
  const config = statusConfig[reactor.status]
  const accentColor = REACTOR_COLORS[reactor.id] || '#3b82f6'

  return (
    <div
      onClick={onSelect}
      onDoubleClick={onViewPID}
      className={`
        relative cursor-pointer rounded-lg border p-3 transition-all
        ${isSelected ? 'ring-2 ring-blue-500/50 border-blue-500/50' : 'border-slate-700 hover:border-slate-600'}
        ${reactor.status === 'CRITICAL' ? 'animate-pulse-critical' : ''}
        bg-slate-800/80 hover:bg-slate-800
      `}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-1 rounded-l-lg"
        style={{ backgroundColor: accentColor }}
      />

      <div className="flex items-start justify-between ml-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white text-sm">{reactor.name}</h3>
            <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${config.bg} ${config.text}`}>
              {reactor.status}
            </span>
          </div>
          <p className="text-xs text-slate-500">{reactor.id}</p>
        </div>
        
        <button
          onClick={(e) => { e.stopPropagation(); onViewPID(); }}
          className="px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
        >
          P&ID →
        </button>
      </div>

      <div className="grid grid-cols-4 gap-2 mt-2 ml-2 text-xs">
        <MetricBadge label="pH" value={reactor.metrics.pH.toFixed(2)} />
        <MetricBadge label="DO" value={`${reactor.metrics.dissolvedOxygen.toFixed(0)}%`} />
        <MetricBadge label="Temp" value={`${reactor.metrics.temperature.toFixed(1)}°`} />
        <MetricBadge label="VCD" value={reactor.metrics.viableCellDensity.toFixed(1)} />
      </div>

      <div className="mt-2 ml-2 flex items-center justify-between text-xs">
        <span className="text-slate-500">Antibody Titer</span>
        <span className="font-semibold text-white">{reactor.metrics.antibodyTiter.toFixed(0)} mg/L</span>
      </div>
    </div>
  )
}

function MetricBadge({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900/50 rounded px-1.5 py-1 text-center">
      <div className="text-slate-500 text-[10px]">{label}</div>
      <div className="text-slate-300 font-mono">{value}</div>
    </div>
  )
}

function StatusSummary({ 
  reactors, 
  status, 
  label, 
  color 
}: { 
  reactors: Reactor[]
  status: 'PASS' | 'WARN' | 'CRITICAL'
  label: string
  color: string 
}) {
  const count = reactors.filter(r => r.status === status).length
  
  return (
    <div className="flex items-center justify-center gap-1.5 bg-slate-900/50 rounded py-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-slate-400">{count} {label}</span>
    </div>
  )
}
