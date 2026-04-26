import type { Reactor } from '../../types'
import { ReactorCard } from './ReactorCard'

interface ReactorGridProps {
  reactors: Reactor[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function ReactorGrid({ reactors, selectedId, onSelect }: ReactorGridProps) {
  const handleSelect = (id: string) => {
    onSelect(selectedId === id ? null : id)
  }

  return (
    <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Reactor Status</h2>
        <div className="flex items-center gap-4 text-xs">
          <StatusLegend status="PASS" />
          <StatusLegend status="WARN" />
          <StatusLegend status="CRITICAL" />
        </div>
      </div>
      
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {reactors.map(reactor => (
          <ReactorCard
            key={reactor.id}
            reactor={reactor}
            isSelected={selectedId === reactor.id}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  )
}

function StatusLegend({ status }: { status: 'PASS' | 'WARN' | 'CRITICAL' }) {
  const colors = {
    PASS: 'bg-green-500',
    WARN: 'bg-yellow-500',
    CRITICAL: 'bg-red-500',
  }

  return (
    <div className="flex items-center gap-1">
      <span className={`w-2 h-2 rounded-full ${colors[status]}`} />
      <span className="text-slate-400">{status}</span>
    </div>
  )
}
