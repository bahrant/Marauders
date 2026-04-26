import { useState, useCallback } from 'react'
import { ReactorGrid } from './components/ReactorGrid/ReactorGrid'
import { TimeSeriesCharts } from './components/TimeSeriesCharts/TimeSeriesCharts'
import { AgentActivityFeed } from './components/AgentFeed/AgentActivityFeed'
import { ExperimentList } from './components/ExperimentList/ExperimentList'
import { ScadaVisualization } from './components/ScadaVisualization/ScadaVisualization'
import { LabSetup } from './components/LabSetup/LabSetup'
import { useReactorData } from './hooks/useReactorData'
import { useAgentActions } from './hooks/useAgentActions'
import { computeMetricsFromPID, type PIDState } from './components/ScadaVisualization/scada-init'
import type { ReactorMetrics } from './types'

type ActiveView = 'dashboard' | 'scada' | 'labSetup'

export default function App() {
  const [selectedReactorId, setSelectedReactorId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<ActiveView>('dashboard')
  const [scadaReactorId, setScadaReactorId] = useState<string>('BR-001')
  const [pidOverrides, setPidOverrides] = useState<Record<string, Partial<ReactorMetrics>>>({})
  const { reactors, timeSeries, isLoading, dayOfRun } = useReactorData()
  const { actions } = useAgentActions()

  const handleViewReactorPID = (reactorId: string) => {
    setScadaReactorId(reactorId)
    setActiveView('scada')
  }

  const handlePIDStateChange = useCallback((state: PIDState) => {
    const metrics = computeMetricsFromPID(state)
    setPidOverrides(prev => ({
      ...prev,
      [scadaReactorId]: metrics,
    }))
  }, [scadaReactorId])

  // Merge P&ID overrides into reactor data for dashboard display
  const displayReactors = reactors.map(r =>
    pidOverrides[r.id]
      ? { ...r, metrics: { ...r.metrics, ...pidOverrides[r.id] } }
      : r
  )

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400">Loading bioreactor data...</p>
        </div>
      </div>
    )
  }

  const TAB_ITEMS: { id: ActiveView; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'scada', label: 'P&ID View' },
    { id: 'labSetup', label: 'Lab Setup' },
  ]

  return (
    <div className="min-h-screen bg-slate-900 p-4">
      <header className="mb-4 flex items-center justify-between animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold text-white">BioReactorAgent</h1>
          <p className="text-sm text-slate-400">Autonomous AI Agent for Pharmaceutical Bioprocessing</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex bg-slate-800 rounded-lg p-1">
            {TAB_ITEMS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveView(tab.id)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  activeView === tab.id
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="h-8 w-px bg-slate-700" />
          <div className="text-right">
            <p className="text-xs text-slate-500">Run Progress</p>
            <p className="text-sm font-semibold text-white">Day {dayOfRun} of 14</p>
          </div>
          <div className="h-8 w-px bg-slate-700" />
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
            <span className="text-sm text-slate-400">Agent Active</span>
          </div>
        </div>
      </header>

      {activeView === 'dashboard' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 h-[calc(100vh-120px)]">
          <div className="lg:col-span-2 flex flex-col gap-4">
            <div className="animate-fade-in" style={{ animationDelay: '0.1s' }}>
              <ReactorGrid
                reactors={displayReactors}
                selectedId={selectedReactorId}
                onSelect={setSelectedReactorId}
              />
            </div>
            <div className="flex-1 min-h-0 animate-fade-in" style={{ animationDelay: '0.2s' }}>
              <TimeSeriesCharts
                timeSeries={timeSeries}
                reactors={displayReactors}
                selectedReactorId={selectedReactorId}
              />
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="h-1/2 animate-fade-in" style={{ animationDelay: '0.3s' }}>
              <ExperimentList
                reactors={displayReactors}
                selectedId={selectedReactorId}
                onSelect={setSelectedReactorId}
                onViewPID={handleViewReactorPID}
              />
            </div>
            <div className="h-1/2 min-h-0 animate-fade-in" style={{ animationDelay: '0.4s' }}>
              <AgentActivityFeed
                actions={actions}
                reactors={displayReactors}
                onReactorClick={setSelectedReactorId}
              />
            </div>
          </div>
        </div>
      )}

      {activeView === 'scada' && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[calc(100vh-120px)]">
          <div className="lg:col-span-3 animate-fade-in">
            <ScadaVisualization
              reactorId={scadaReactorId}
              reactor={displayReactors.find(r => r.id === scadaReactorId)}
              onStateChange={handlePIDStateChange}
            />
          </div>
          <div className="flex flex-col gap-4">
            <div className="animate-fade-in bg-slate-800/50 rounded-lg border border-slate-700 p-4">
              <h3 className="text-sm font-semibold text-slate-400 mb-3">Select Experiment</h3>
              <div className="grid grid-cols-2 gap-2">
                {reactors.map(reactor => (
                  <button
                    key={reactor.id}
                    onClick={() => setScadaReactorId(reactor.id)}
                    className={`p-2 rounded-lg text-left transition-all ${
                      scadaReactorId === reactor.id
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                    }`}
                  >
                    <div className="font-medium text-sm">{reactor.name}</div>
                    <div className="text-xs opacity-75">{reactor.id}</div>
                  </button>
                ))}
              </div>
              {pidOverrides[scadaReactorId] && (
                <div className="mt-3 pt-3 border-t border-slate-700">
                  <p className="text-xs text-slate-500 mb-2">P&ID Override Active</p>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <span className="text-slate-400">DO</span>
                    <span className="text-blue-400 font-mono">
                      {pidOverrides[scadaReactorId].dissolvedOxygen?.toFixed(1)}%
                    </span>
                    <span className="text-slate-400">pH</span>
                    <span className="text-blue-400 font-mono">
                      {pidOverrides[scadaReactorId].pH?.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="animate-fade-in" style={{ animationDelay: '0.1s' }}>
              <ReactorGrid
                reactors={displayReactors}
                selectedId={scadaReactorId}
                onSelect={(id) => id !== null && setScadaReactorId(id)}
              />
            </div>
            <div className="flex-1 min-h-0 animate-fade-in" style={{ animationDelay: '0.2s' }}>
              <AgentActivityFeed
                actions={actions.filter(a => a.reactorId === scadaReactorId)}
                reactors={displayReactors}
                onReactorClick={setScadaReactorId}
              />
            </div>
          </div>
        </div>
      )}

      {activeView === 'labSetup' && (
        <div className="h-[calc(100vh-120px)] animate-fade-in">
          <LabSetup />
        </div>
      )}
    </div>
  )
}
