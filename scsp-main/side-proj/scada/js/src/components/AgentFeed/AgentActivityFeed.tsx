import { useState } from 'react'
import type { AgentAction, Reactor } from '../../types'
import { REACTOR_COLORS } from '../../types'

interface AgentActivityFeedProps {
  actions: AgentAction[]
  reactors: Reactor[]
  onReactorClick: (id: string) => void
}

export function AgentActivityFeed({ actions, reactors, onReactorClick }: AgentActivityFeedProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<string | null>(null)

  const filteredActions = filter
    ? actions.filter(a => a.reactorId === filter)
    : actions

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">Agent Activity</h2>
          <div className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-xs text-slate-400">Live</span>
          </div>
        </div>
        
        <div className="flex gap-2 mt-3 flex-wrap">
          <FilterButton
            label="All"
            isActive={filter === null}
            onClick={() => setFilter(null)}
          />
          {reactors.map(reactor => (
            <FilterButton
              key={reactor.id}
              label={reactor.id}
              isActive={filter === reactor.id}
              onClick={() => setFilter(reactor.id)}
              color={REACTOR_COLORS[reactor.id]}
            />
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
        {filteredActions.length === 0 ? (
          <div className="text-center text-slate-500 py-8">
            No agent activity recorded
          </div>
        ) : (
          <div className="space-y-2">
            {filteredActions.map(action => (
              <ActionItem
                key={action.id}
                action={action}
                isExpanded={expandedId === action.id}
                onToggle={() => toggleExpand(action.id)}
                onReactorClick={onReactorClick}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

interface FilterButtonProps {
  label: string
  isActive: boolean
  onClick: () => void
  color?: string
}

function FilterButton({ label, isActive, onClick, color }: FilterButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        px-2 py-1 rounded text-xs font-medium transition-colors
        ${isActive
          ? 'bg-slate-600 text-white'
          : 'bg-slate-700/50 text-slate-400 hover:bg-slate-700 hover:text-slate-300'
        }
      `}
      style={color && isActive ? { backgroundColor: color + '40', borderColor: color } : undefined}
    >
      {label}
    </button>
  )
}

interface ActionItemProps {
  action: AgentAction
  isExpanded: boolean
  onToggle: () => void
  onReactorClick: (id: string) => void
}

function ActionItem({ action, isExpanded, onToggle, onReactorClick }: ActionItemProps) {
  const severityConfig = {
    info: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', icon: 'ℹ' },
    warning: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', icon: '⚠' },
    critical: { bg: 'bg-red-500/10', border: 'border-red-500/30', icon: '!' },
  }

  const config = severityConfig[action.severity]
  const reactorColor = REACTOR_COLORS[action.reactorId] || '#64748b'

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div
      className={`
        rounded-lg border p-3 cursor-pointer transition-all animate-slide-in
        ${config.bg} ${config.border}
        ${isExpanded ? 'ring-1 ring-white/20' : ''}
        hover:bg-slate-800/50
      `}
      onClick={onToggle}
    >
      <div className="flex items-start gap-2">
        <span className="text-xs font-mono text-slate-500 mt-0.5 shrink-0">
          {formatTime(action.timestamp)}
        </span>
        
        <button
          onClick={(e) => {
            e.stopPropagation()
            onReactorClick(action.reactorId)
          }}
          className="px-1.5 py-0.5 rounded text-xs font-medium shrink-0 hover:opacity-80 transition-opacity"
          style={{ backgroundColor: reactorColor + '30', color: reactorColor }}
        >
          {action.reactorId}
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-sm text-white font-medium truncate">
            {action.action}
          </p>
          
          {isExpanded && (
            <div className="mt-2 text-xs text-slate-400 leading-relaxed">
              {action.reasoning}
            </div>
          )}
        </div>

        <span className="text-xs text-slate-500 shrink-0">
          {isExpanded ? '▼' : '▶'}
        </span>
      </div>
    </div>
  )
}
