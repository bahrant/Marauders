import type { ValidationIssue, MaterialBalance, ValidationSeverity } from '../../types'

interface ValidationPanelProps {
  issues: ValidationIssue[]
  balances: MaterialBalance[]
  enabled: boolean
  onToggleEnabled: () => void
  onIssueClick: (elementIds: string[]) => void
  isRunning: boolean
}

const SEV_STYLE: Record<ValidationSeverity, { bg: string; text: string; icon: string; border: string }> = {
  error:   { bg: 'bg-red-900/40',    text: 'text-red-300',    icon: '✕', border: 'border-red-700/50' },
  warning: { bg: 'bg-yellow-900/40', text: 'text-yellow-300', icon: '⚠', border: 'border-yellow-700/50' },
  info:    { bg: 'bg-blue-900/40',   text: 'text-blue-300',   icon: 'ℹ', border: 'border-blue-700/50' },
}

const CAT_LABEL: Record<string, string> = {
  topology: 'Topology',
  balance:  'Balance',
  hazop:    'HAZOP',
}

function IssueCard({ issue, onClick }: { issue: ValidationIssue; onClick: () => void }) {
  const s = SEV_STYLE[issue.severity]
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded border ${s.border} ${s.bg} p-2.5 hover:brightness-125 transition-all`}
    >
      <div className="flex items-start gap-2">
        <span className={`${s.text} font-bold text-sm mt-0.5 shrink-0`}>{s.icon}</span>
        <div className="min-w-0 flex-1">
          <p className={`${s.text} text-xs font-semibold leading-snug`}>{issue.message}</p>
          <p className="text-slate-400 text-xs mt-0.5 leading-snug">{issue.explanation}</p>
          <p className="text-slate-500 text-xs mt-1 italic">Fix: {issue.suggestedFix}</p>
          <span className="inline-block mt-1 text-xs bg-slate-700 text-slate-400 rounded px-1.5 py-0.5">
            {CAT_LABEL[issue.category] ?? issue.category}
          </span>
        </div>
      </div>
    </button>
  )
}

function BalanceRow({ balance }: { balance: MaterialBalance }) {
  const color = balance.isBalanced ? 'text-green-400' : balance.discrepancyPct > 20 ? 'text-red-400' : 'text-yellow-400'
  return (
    <div className="flex items-center justify-between py-1 border-b border-slate-700/40 last:border-0">
      <span className="text-slate-400 text-xs truncate max-w-24">{balance.elementName}</span>
      <div className="flex items-center gap-2 text-xs font-mono">
        <span className="text-slate-500">↓{balance.inflow.toFixed(1)}</span>
        <span className="text-slate-500">↑{balance.outflow.toFixed(1)}</span>
        <span className={`font-semibold ${color}`}>{balance.discrepancyPct.toFixed(1)}%</span>
      </div>
    </div>
  )
}

export function ValidationPanel({
  issues,
  balances,
  enabled,
  onToggleEnabled,
  onIssueClick,
  isRunning,
}: ValidationPanelProps) {
  const errorCount   = issues.filter(i => i.severity === 'error').length
  const warningCount = issues.filter(i => i.severity === 'warning').length
  const unbalanced   = balances.filter(b => !b.isBalanced).length

  return (
    <div className="w-72 bg-slate-800 border-l border-slate-700 flex flex-col shrink-0 overflow-hidden">

      {/* Header */}
      <div className="px-3 py-2.5 border-b border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Validation</span>
          {issues.length > 0 && (
            <span className={`text-xs font-bold rounded px-1.5 py-0.5 ${
              errorCount > 0 ? 'bg-red-700 text-red-100' : 'bg-yellow-700 text-yellow-100'
            }`}>
              {issues.length}
            </span>
          )}
          {isRunning && (
            <span className="text-xs bg-blue-900 text-blue-300 rounded px-1.5 py-0.5">live</span>
          )}
        </div>
        <button
          onClick={onToggleEnabled}
          title={enabled ? 'Disable validation (free-sketch mode)' : 'Enable validation'}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            enabled
              ? 'bg-blue-700 text-blue-100 hover:bg-blue-600'
              : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </button>
      </div>

      {!enabled && (
        <div className="flex-1 flex items-center justify-center p-4">
          <p className="text-slate-500 text-xs text-center">
            Validation disabled (free-sketch mode).<br />
            Enable before simulation or export.
          </p>
        </div>
      )}

      {enabled && (
        <div className="flex-1 overflow-y-auto">

          {/* Summary bar */}
          {issues.length > 0 && (
            <div className="flex gap-1 px-3 py-2 border-b border-slate-700/50">
              {errorCount > 0 && (
                <div className="flex items-center gap-1 text-red-300 bg-red-900/30 rounded px-2 py-0.5 text-xs">
                  <span>✕</span><span>{errorCount} error{errorCount > 1 ? 's' : ''}</span>
                </div>
              )}
              {warningCount > 0 && (
                <div className="flex items-center gap-1 text-yellow-300 bg-yellow-900/30 rounded px-2 py-0.5 text-xs">
                  <span>⚠</span><span>{warningCount} warn</span>
                </div>
              )}
            </div>
          )}

          {/* Issues list */}
          {issues.length === 0 ? (
            <div className="p-4 text-center text-xs text-green-400">
              <p className="text-2xl mb-1">✓</p>
              <p className="font-semibold">No issues found</p>
              <p className="text-slate-500 mt-1">Plant topology is valid.</p>
            </div>
          ) : (
            <div className="p-2 space-y-1.5">
              {issues.map(issue => (
                <IssueCard
                  key={issue.id}
                  issue={issue}
                  onClick={() => onIssueClick(issue.elementIds)}
                />
              ))}
            </div>
          )}

          {/* Material balance section */}
          {balances.length > 0 && (
            <div className="border-t border-slate-700 px-3 py-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Material Balance</span>
                {unbalanced > 0 && (
                  <span className="text-xs text-yellow-400">{unbalanced} unbalanced</span>
                )}
              </div>
              <div className="text-xs text-slate-600 mb-1 flex justify-between">
                <span>Node</span>
                <span>In / Out / Δ%</span>
              </div>
              {balances.map(b => <BalanceRow key={b.elementId} balance={b} />)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
