import { useRef, useEffect, useState, useCallback } from 'react'
import { initLabSetup, type LabSetupHandle } from './lab-setup-init'
import { ValidationPanel } from './ValidationPanel'
import { PropertyPanel } from './PropertyPanel'
import { ExportPanel } from './ExportPanel'
import { validatePlant, computeMaterialBalance } from '../../lib/validation/topologyValidator'
import { eulerStep, rk4Step, createInitialState, DEFAULT_SIM_CONFIG, formatSimTime } from '../../lib/simulation/SimulationEngine'
import type {
  ValidationIssue,
  MaterialBalance,
  PlantGraph,
  EquipmentProperties,
  SimulationState,
  SimulationConfig,
} from '../../types'

// ── Palette ───────────────────────────────────────────────────────────────────

const PALETTE_GROUPS = [
  {
    label: 'Basic',
    items: [
      { type: 'LiquidTank',   label: 'Liquid Tank',   dot: 'bg-blue-500' },
      { type: 'ConicTank',    label: 'Conic Tank',    dot: 'bg-cyan-500' },
      { type: 'Pump',         label: 'Pump',          dot: 'bg-orange-500' },
      { type: 'ControlValve', label: 'Control Valve', dot: 'bg-yellow-500' },
      { type: 'HandValve',    label: 'Hand Valve',    dot: 'bg-green-500' },
      { type: 'Panel',        label: 'Level Gauge',   dot: 'bg-purple-500' },
      { type: 'Zone',         label: 'Zone Label',    dot: 'bg-slate-400' },
      { type: 'Join',         label: 'Junction',      dot: 'bg-gray-400' },
    ],
  },
  {
    label: 'Bioprocess',
    items: [
      { type: 'Bioreactor',          label: 'STR Bioreactor',   dot: 'bg-emerald-500' },
      { type: 'Fermenter',           label: 'Fermenter',        dot: 'bg-lime-500' },
      { type: 'Centrifuge',          label: 'Centrifuge',       dot: 'bg-rose-500' },
      { type: 'ChromatographyColumn',label: 'Chrom. Column',    dot: 'bg-violet-500' },
      { type: 'UfDfSkid',            label: 'UF/DF Skid',       dot: 'bg-sky-500' },
      { type: 'Lyophilizer',         label: 'Lyophilizer',      dot: 'bg-indigo-400' },
    ],
  },
  {
    label: 'Utilities',
    items: [
      { type: 'WfiGenerator',        label: 'WFI Generator',    dot: 'bg-teal-400' },
      { type: 'CleanSteamGenerator', label: 'Clean Steam Gen.', dot: 'bg-orange-300' },
      { type: 'ChilledWaterUnit',    label: 'Chilled Water',    dot: 'bg-cyan-300' },
      { type: 'TransferPanel',       label: 'Transfer Panel',   dot: 'bg-slate-300' },
      { type: 'InstrumentLoop',      label: 'Instrument Loop',  dot: 'bg-yellow-300' },
    ],
  },
] as const

type PaletteType = (typeof PALETTE_GROUPS)[number]['items'][number]['type']

// ── Probe catalogue ───────────────────────────────────────────────────────────

const PROBE_TYPES = [
  { id: 'pH',    label: 'pH Probe',             color: 'text-green-400' },
  { id: 'DO',    label: 'Dissolved Oxygen',      color: 'text-blue-400' },
  { id: 'Temp',  label: 'Temperature Sensor',    color: 'text-orange-400' },
  { id: 'Turb',  label: 'Turbidity / Biomass',   color: 'text-purple-400' },
  { id: 'CO2',   label: 'CO₂ Off-gas',            color: 'text-slate-300' },
  { id: 'Gluc',  label: 'Glucose / Nutrient',    color: 'text-yellow-400' },
  { id: 'Press', label: 'Pressure Sensor',       color: 'text-red-400' },
  { id: 'Level', label: 'Level Sensor',          color: 'text-cyan-400' },
] as const

// ── State shapes ──────────────────────────────────────────────────────────────

interface ProbePanel { id: string; name: string; probes: string[] }
interface RPMPanel   { id: string; name: string; rpm: number }
interface SelectedElement { id: string; type: string; name: string; props: EquipmentProperties }

// ── Component ─────────────────────────────────────────────────────────────────

export function LabSetup() {
  const containerRef = useRef<HTMLDivElement>(null)
  const handleRef    = useRef<LabSetupHandle | null>(null)

  // UI state
  const [plantName,     setPlantName]     = useState('My Pilot Plant')
  const [isSimulating,  setIsSimulating]  = useState(false)
  const [connectMode,   setConnectMode]   = useState(false)
  const [counters,      setCounters]      = useState<Partial<Record<string, number>>>({})
  const [probePanel,    setProbePanel]    = useState<ProbePanel | null>(null)
  const [rpmPanel,      setRpmPanel]      = useState<RPMPanel | null>(null)
  const [showValidation,setShowValidation]= useState(true)
  const [validationEnabled, setValidationEnabled] = useState(true)
  const [showExport,    setShowExport]    = useState(false)
  const [selectedEl,    setSelectedEl]    = useState<SelectedElement | null>(null)

  // Validation state (FR1)
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [materialBalances, setMaterialBalances]  = useState<MaterialBalance[]>([])
  const [currentGraph,     setCurrentGraph]      = useState<PlantGraph>({ nodes: [], edges: [], plantName })

  // Simulation state (FR2)
  const [simConfig,  setSimConfig]  = useState<SimulationConfig>({ ...DEFAULT_SIM_CONFIG })
  const [simState,   setSimState]   = useState<SimulationState | null>(null)
  const [simElapsed, setSimElapsed] = useState(0)

  // ── Initialise JointJS once ────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return
    handleRef.current = initLabSetup(containerRef.current, {
      onTankDblClick: (id, name, probes) => { setProbePanel({ id, name, probes }); setSelectedEl(null) },
      onPumpDblClick: (id, name, rpm)    => { setRpmPanel({ id, name, rpm }); setSelectedEl(null) },
      onElementSelect: (id, type, name, props) => {
        setSelectedEl({ id, type, name, props })
        setProbePanel(null)
        setRpmPanel(null)
      },
      onElementDeselect: () => setSelectedEl(null),
      onGraphChange: (graph) => {
        setCurrentGraph(graph)
        if (validationEnabled) {
          setValidationIssues(validatePlant(graph, { skipCIPCheck: false }))
          setMaterialBalances(computeMaterialBalance(graph))
        }
      },
    }, plantName)

    return () => { handleRef.current?.cleanup(); handleRef.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep plant name in sync with JointJS serializer
  useEffect(() => {
    const h = handleRef.current as LabSetupHandle & { setPlantName?(n: string): void }
    h?.setPlantName?.(plantName)
  }, [plantName])

  // Re-run validation when toggled on
  useEffect(() => {
    if (validationEnabled && currentGraph.nodes.length > 0) {
      setValidationIssues(validatePlant(currentGraph, { skipCIPCheck: false }))
      setMaterialBalances(computeMaterialBalance(currentGraph))
    } else if (!validationEnabled) {
      setValidationIssues([])
      setMaterialBalances([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationEnabled])

  // ── FR2 Physics simulation loop ────────────────────────────────────────────

  useEffect(() => {
    if (!isSimulating) return

    // Initialise state if graph has elements and no state yet
    if (!simState && currentGraph.nodes.length > 0) {
      setSimState(createInitialState(currentGraph))
      return
    }

    const speed = simConfig.speedMultiplier
    const interval = Math.max(100, 1000 / speed)  // ms between ticks

    const id = window.setInterval(() => {
      setSimState(prev => {
        if (!prev) return prev
        const next = simConfig.solver === 'rk4'
          ? rk4Step(prev, currentGraph, simConfig)
          : eulerStep(prev, currentGraph, simConfig)
        setSimElapsed(next.time)
        handleRef.current?.applySimulationState(next)
        return next
      })
    }, interval)

    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSimulating, simConfig.speedMultiplier, simConfig.solver])

  // ── Palette add ────────────────────────────────────────────────────────────

  const addElement = useCallback((type: PaletteType, label: string) => {
    const handle = handleRef.current
    if (!handle) return
    const count = (counters[type] ?? 0) + 1
    setCounters(prev => ({ ...prev, [type]: count }))
    const name = `${label} ${count}`

    switch (type) {
      case 'LiquidTank':          handle.addLiquidTank(name);          break
      case 'ConicTank':           handle.addConicTank(name);           break
      case 'Pump':                handle.addPump(name);                 break
      case 'ControlValve':        handle.addControlValve(name);        break
      case 'HandValve':           handle.addHandValve(name);           break
      case 'Panel':               handle.addPanel(name);               break
      case 'Zone':                handle.addZone(name);                break
      case 'Join':                handle.addJoin();                    break
      case 'Bioreactor':          handle.addBioreactor(name);          break
      case 'Fermenter':           handle.addFermenter(name);           break
      case 'Centrifuge':          handle.addCentrifuge(name);          break
      case 'ChromatographyColumn':handle.addChromColumn(name);         break
      case 'UfDfSkid':            handle.addUfDfSkid(name);            break
      case 'Lyophilizer':         handle.addLyophilizer(name);         break
      case 'WfiGenerator':        handle.addWfiGenerator(name);        break
      case 'CleanSteamGenerator': handle.addCleanSteamGenerator(name); break
      case 'ChilledWaterUnit':    handle.addChilledWaterUnit(name);    break
      case 'TransferPanel':       handle.addTransferPanel(name);       break
      case 'InstrumentLoop':      handle.addInstrumentLoop(name);      break
    }
  }, [counters])

  // ── Toolbar actions ────────────────────────────────────────────────────────

  const toggleConnect = () => {
    const next = !connectMode
    setConnectMode(next)
    handleRef.current?.setConnectMode(next)
    if (next) { setProbePanel(null); setRpmPanel(null); setSelectedEl(null) }
  }

  const toggleSimulation = () => {
    const next = !isSimulating
    setIsSimulating(next)
    handleRef.current?.setSimulating(next)
    if (!next) { setSimState(null); setSimElapsed(0) }
    else if (currentGraph.nodes.length > 0) {
      setSimState(createInitialState(currentGraph))
    }
  }

  const handleClear = () => {
    handleRef.current?.clear()
    setIsSimulating(false)
    setConnectMode(false)
    setCounters({})
    setProbePanel(null)
    setRpmPanel(null)
    setSelectedEl(null)
    setValidationIssues([])
    setMaterialBalances([])
    setSimState(null)
    setSimElapsed(0)
    setCurrentGraph({ nodes: [], edges: [], plantName })
  }

  const toggleValidation = () => {
    const next = !validationEnabled
    setValidationEnabled(next)
    handleRef.current?.setValidationEnabled(next)
    if (!next) handleRef.current?.clearHighlights()
  }

  const handleIssueClick = (elementIds: string[]) => {
    handleRef.current?.clearHighlights()
    const issue = validationIssues.find(i => i.elementIds.some(id => elementIds.includes(id)))
    if (issue) handleRef.current?.highlightElements(issue.elementIds, issue.severity)
  }

  // ── Probe panel ────────────────────────────────────────────────────────────

  const toggleProbe = (probeId: string) => {
    setProbePanel(prev => {
      if (!prev) return prev
      const has = prev.probes.includes(probeId)
      return { ...prev, probes: has ? prev.probes.filter(p => p !== probeId) : [...prev.probes, probeId] }
    })
  }

  const applyProbes = () => {
    if (!probePanel) return
    handleRef.current?.updateTankProbes(probePanel.id, probePanel.name, probePanel.probes)
    setProbePanel(null)
  }

  // ── RPM panel ──────────────────────────────────────────────────────────────

  const applyRPM = () => {
    if (!rpmPanel) return
    handleRef.current?.updatePumpRPM(rpmPanel.id, rpmPanel.name, rpmPanel.rpm)
    setRpmPanel(null)
  }

  // ── Property panel ────────────────────────────────────────────────────────

  const applyProperties = (id: string, props: EquipmentProperties) => {
    handleRef.current?.updateElementProperties(id, props)
    setSelectedEl(prev => prev ? { ...prev, props } : prev)
  }

  // ── Derived state for badges ───────────────────────────────────────────────

  const errorCount   = validationIssues.filter(i => i.severity === 'error').length
  const warningCount = validationIssues.filter(i => i.severity === 'warning').length
  const badgeClass   = errorCount > 0 ? 'bg-red-700 text-red-100' : warningCount > 0 ? 'bg-yellow-700 text-yellow-100' : 'bg-green-800 text-green-300'
  const badgeText    = errorCount > 0 ? `${errorCount}E` : warningCount > 0 ? `${warningCount}W` : '✓'

  // Bioreactor state for display
  const primaryBioState = simState && currentGraph.nodes.find(n => n.type === 'Bioreactor' || n.type === 'Fermenter')
  const bioSimState = primaryBioState ? simState?.elements[primaryBioState.id] : null

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col relative">

      {/* ── Toolbar ── */}
      <div className="p-2 border-b border-slate-700 flex items-center gap-1.5 flex-wrap shrink-0">
        <input
          value={plantName}
          onChange={e => setPlantName(e.target.value)}
          className="bg-slate-700 text-white px-2.5 py-1.5 rounded text-sm border border-slate-600 focus:border-blue-500 outline-none w-40"
          placeholder="Plant name..."
        />

        {/* Connect */}
        <button
          onClick={toggleConnect}
          title="Click Connect, then click source then target to draw a pipe. ESC to cancel."
          className={`px-2.5 py-1.5 rounded text-sm font-medium transition-colors ${
            connectMode
              ? 'bg-blue-600 text-white ring-2 ring-blue-400 ring-offset-1 ring-offset-slate-900'
              : 'bg-slate-700 hover:bg-slate-600 text-slate-300'
          }`}
        >
          {connectMode ? 'Connecting…' : 'Connect'}
        </button>

        {/* Simulate */}
        <button
          onClick={toggleSimulation}
          disabled={currentGraph.nodes.length === 0}
          title={currentGraph.nodes.length === 0 ? 'Add equipment first' : undefined}
          className={`px-2.5 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-40 ${
            isSimulating
              ? 'bg-red-600 hover:bg-red-700 text-white'
              : 'bg-green-700 hover:bg-green-600 text-white'
          }`}
        >
          {isSimulating ? 'Stop Sim' : 'Simulate'}
        </button>

        {/* Sim speed (while running) */}
        {isSimulating && (
          <div className="flex items-center gap-1 bg-slate-700 rounded px-2 py-1">
            <span className="text-xs text-slate-400">Speed:</span>
            {[1, 2, 5, 10].map(s => (
              <button
                key={s}
                onClick={() => setSimConfig(c => ({ ...c, speedMultiplier: s }))}
                className={`text-xs px-1.5 py-0.5 rounded ${simConfig.speedMultiplier === s ? 'bg-blue-600 text-white' : 'text-slate-300 hover:text-white'}`}
              >
                {s}×
              </button>
            ))}
          </div>
        )}

        {/* Solver toggle */}
        {isSimulating && (
          <button
            onClick={() => setSimConfig(c => ({ ...c, solver: c.solver === 'euler' ? 'rk4' : 'euler' }))}
            className="text-xs bg-slate-700 text-slate-300 hover:text-white px-2 py-1 rounded"
            title="Switch between Euler and Runge-Kutta 4th order solvers"
          >
            {simConfig.solver.toUpperCase()}
          </button>
        )}

        {/* Sim clock */}
        {isSimulating && simElapsed > 0 && (
          <span className="text-xs text-blue-300 font-mono bg-blue-900/30 px-2 py-1 rounded">
            {formatSimTime(simElapsed)}
          </span>
        )}

        {/* Bioreactor live metrics */}
        {isSimulating && bioSimState && (
          <div className="flex items-center gap-2 text-xs font-mono bg-emerald-900/30 rounded px-2 py-1">
            {bioSimState.biomass !== undefined && <span className="text-emerald-300">X:{bioSimState.biomass.toFixed(2)}g/L</span>}
            {bioSimState.dissolvedOxygen !== undefined && <span className="text-blue-300">DO:{bioSimState.dissolvedOxygen.toFixed(0)}%</span>}
            {bioSimState.pH !== undefined && <span className="text-green-300">pH:{bioSimState.pH.toFixed(2)}</span>}
          </div>
        )}

        <div className="flex items-center gap-1 ml-auto">
          {/* Validation badge */}
          {validationEnabled && currentGraph.nodes.length > 0 && (
            <button
              onClick={() => setShowValidation(v => !v)}
              className={`text-xs font-bold rounded px-1.5 py-0.5 ${badgeClass}`}
              title={`${validationIssues.length} validation issue(s) — click to toggle panel`}
            >
              {badgeText}
            </button>
          )}

          {/* Validate toggle */}
          <button
            onClick={toggleValidation}
            title={validationEnabled ? 'Disable validation (free-sketch mode)' : 'Enable validation'}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              validationEnabled
                ? 'bg-blue-700/60 text-blue-200 hover:bg-blue-700'
                : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
            }`}
          >
            {validationEnabled ? 'Valid.' : 'Validate'}
          </button>

          {/* Validation panel toggle */}
          <button
            onClick={() => setShowValidation(v => !v)}
            title="Toggle validation panel"
            className="text-xs px-2 py-1 rounded bg-slate-700 text-slate-400 hover:bg-slate-600"
          >
            {showValidation ? '⟩' : '⟨'}
          </button>

          {/* Export */}
          <button
            onClick={() => { handleRef.current?.clearHighlights(); setShowExport(true) }}
            className="text-xs px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
          >
            Export
          </button>

          {/* Clear */}
          <button
            onClick={handleClear}
            className="text-xs px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 transition-colors"
          >
            Clear
          </button>
        </div>

        {connectMode && (
          <div className="w-full text-xs text-blue-400 mt-0.5">
            Click a source component → click a target to draw a pipe. ESC to cancel.
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex flex-1 min-h-0">

        {/* Palette sidebar */}
        <div className="w-44 bg-slate-800 border-r border-slate-700 flex flex-col overflow-y-auto shrink-0">
          {PALETTE_GROUPS.map(group => (
            <div key={group.label} className="p-2">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5 px-0.5">{group.label}</p>
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <button
                    key={item.type}
                    onClick={() => addElement(item.type, item.label)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded bg-slate-700/60 hover:bg-slate-600 text-slate-300 hover:text-white text-left text-xs transition-colors group"
                  >
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${item.dot}`} />
                    <span className="flex-1">{item.label}</span>
                    {(counters[item.type] ?? 0) > 0 && (
                      <span className="text-slate-500 group-hover:text-slate-400 font-mono">
                        {counters[item.type]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Legend */}
          <div className="mt-auto p-3 pt-2 border-t border-slate-700/50 text-xs text-slate-600 leading-relaxed space-y-0.5">
            <p>Dbl-click <span className="text-blue-400">tank</span> → probes</p>
            <p>Dbl-click <span className="text-orange-400">pump</span> → RPM</p>
            <p>Click element → properties</p>
            <p>Select + Delete to remove</p>
          </div>
        </div>

        {/* JointJS canvas */}
        <div
          ref={containerRef}
          className="flex-1 overflow-hidden"
          style={{ background: '#F3F7F6' }}
        />

        {/* Validation panel */}
        {showValidation && (
          <ValidationPanel
            issues={validationIssues}
            balances={materialBalances}
            enabled={validationEnabled}
            onToggleEnabled={toggleValidation}
            onIssueClick={handleIssueClick}
            isRunning={isSimulating}
          />
        )}
      </div>

      {/* ── Property panel (floating) ── */}
      {selectedEl && !probePanel && !rpmPanel && (
        <div className="absolute bottom-4 right-4 z-20">
          <PropertyPanel
            elementId={selectedEl.id}
            elementType={selectedEl.type}
            elementName={selectedEl.name}
            properties={selectedEl.props}
            onApply={applyProperties}
            onClose={() => setSelectedEl(null)}
          />
        </div>
      )}

      {/* ── Probe configuration panel ── */}
      {probePanel && (
        <div className="absolute top-16 right-80 z-20 w-60 bg-slate-900 border border-slate-600 rounded-lg shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <div>
              <p className="text-sm font-semibold text-white">{probePanel.name}</p>
              <p className="text-xs text-slate-400">Select installed probes</p>
            </div>
            <button onClick={() => setProbePanel(null)} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
          </div>
          <div className="px-4 py-3 space-y-2">
            {PROBE_TYPES.map(probe => (
              <label key={probe.id} className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={probePanel.probes.includes(probe.id)}
                  onChange={() => toggleProbe(probe.id)}
                  className="w-4 h-4 rounded accent-blue-500 cursor-pointer"
                />
                <span className={`text-xs ${probePanel.probes.includes(probe.id) ? probe.color : 'text-slate-400'} group-hover:text-white transition-colors`}>
                  {probe.label}
                </span>
              </label>
            ))}
          </div>
          <div className="px-4 pb-3">
            <button onClick={applyProbes} className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm py-1.5 rounded font-medium transition-colors">
              Apply
            </button>
          </div>
        </div>
      )}

      {/* ── RPM configuration panel ── */}
      {rpmPanel && (
        <div className="absolute top-16 right-80 z-20 w-60 bg-slate-900 border border-slate-600 rounded-lg shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
            <div>
              <p className="text-sm font-semibold text-white">{rpmPanel.name}</p>
              <p className="text-xs text-slate-400">Agitator speed</p>
            </div>
            <button onClick={() => setRpmPanel(null)} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
          </div>
          <div className="px-4 py-4 space-y-3">
            <div className="flex items-center gap-3">
              <input
                type="number" min={0} max={2000} step={10}
                value={rpmPanel.rpm}
                onChange={e => setRpmPanel(prev => prev ? { ...prev, rpm: Math.max(0, Math.min(2000, Number(e.target.value))) } : null)}
                className="w-24 bg-slate-700 text-white px-3 py-1.5 rounded text-sm border border-slate-600 focus:border-blue-500 outline-none font-mono"
              />
              <span className="text-sm text-slate-400">RPM</span>
            </div>
            <input
              type="range" min={0} max={2000} step={10}
              value={rpmPanel.rpm}
              onChange={e => setRpmPanel(prev => prev ? { ...prev, rpm: Number(e.target.value) } : null)}
              className="w-full accent-blue-500"
            />
            <div className="flex justify-between text-xs text-slate-500">
              <span>Off</span>
              <span className={rpmPanel.rpm > 0 ? 'text-orange-400 font-semibold' : ''}>
                {rpmPanel.rpm > 0 ? `${rpmPanel.rpm} RPM` : '—'}
              </span>
              <span>2000</span>
            </div>
          </div>
          <div className="px-4 pb-3">
            <button onClick={applyRPM} className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm py-1.5 rounded font-medium transition-colors">
              Apply
            </button>
          </div>
        </div>
      )}

      {/* ── Export modal ── */}
      {showExport && (
        <ExportPanel
          graph={currentGraph}
          simState={simState}
          simConfig={simConfig}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* ── Sim state info overlay ── */}
      {isSimulating && bioSimState && (
        <div className="absolute bottom-4 left-48 z-10 bg-slate-900/90 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono pointer-events-none">
          <div className="text-slate-500 mb-1">{primaryBioState?.name ?? 'Bioreactor'} — live state</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {bioSimState.biomass !== undefined       && <><span className="text-slate-500">Biomass</span><span className="text-emerald-300">{bioSimState.biomass.toFixed(3)} g/L</span></>}
            {bioSimState.substrate !== undefined     && <><span className="text-slate-500">Glucose</span><span className="text-yellow-300">{bioSimState.substrate.toFixed(3)} g/L</span></>}
            {bioSimState.dissolvedOxygen !== undefined && <><span className="text-slate-500">DO</span><span className="text-blue-300">{bioSimState.dissolvedOxygen.toFixed(1)} %</span></>}
            {bioSimState.pH !== undefined            && <><span className="text-slate-500">pH</span><span className="text-green-300">{bioSimState.pH.toFixed(3)}</span></>}
            {bioSimState.volume !== undefined        && <><span className="text-slate-500">Volume</span><span className="text-slate-300">{bioSimState.volume.toFixed(1)} L</span></>}
            {bioSimState.product !== undefined       && <><span className="text-slate-500">Titer</span><span className="text-purple-300">{bioSimState.product.toFixed(1)} mg/L</span></>}
          </div>
        </div>
      )}

      {/* ── Equipment catalog info (when in free sketch mode) ── */}
      {!validationEnabled && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-10 text-xs bg-yellow-900/80 border border-yellow-700 text-yellow-300 rounded px-3 py-1.5 pointer-events-none">
          Free-sketch mode — validation disabled. Re-enable before simulation or export.
        </div>
      )}
    </div>
  )
}
