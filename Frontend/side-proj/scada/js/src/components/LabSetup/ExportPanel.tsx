import { useState } from 'react'
import type { PlantGraph, SimulationState, SimulationConfig } from '../../types'
import { generatePythonScript, exportToJSON } from '../../lib/simulation/SimulationEngine'

interface ExportPanelProps {
  graph: PlantGraph
  simState: SimulationState | null
  simConfig: SimulationConfig
  onClose: () => void
}

type ExportFormat = 'json' | 'python' | 'isa88'

function generateISA88(graph: PlantGraph): string {
  const vessels = graph.nodes.filter(n =>
    ['Bioreactor', 'Fermenter', 'LiquidTank', 'ConicTank'].includes(n.type)
  )
  const pumps = graph.nodes.filter(n => n.type === 'Pump')

  const unitProcedures = vessels.map(v => `
  <UnitProcedure id="${v.id}" name="Process_${v.name.replace(/\s+/g, '_')}">
    <Operations>
      <Operation name="CIP" sequence="1">
        <Phases>
          <Phase name="Pre-rinse" duration="PT15M"/>
          <Phase name="Caustic_wash" duration="PT20M"/>
          <Phase name="Water_rinse" duration="PT10M"/>
          <Phase name="Acid_wash" duration="PT15M"/>
          <Phase name="Final_rinse" duration="PT15M"/>
        </Phases>
      </Operation>
      <Operation name="SIP" sequence="2">
        <Phases>
          <Phase name="Steam_up" duration="PT30M"/>
          <Phase name="Hold" duration="PT30M"/>
          <Phase name="Cool_down" duration="PT30M"/>
        </Phases>
      </Operation>
      <Operation name="Charge" sequence="3">
        <Phases>
          <Phase name="Load_media" parameter="volume=${v.properties.workingVolume ?? 100}L"/>
          <Phase name="Adjust_pH"/>
          <Phase name="Adjust_temperature" parameter="setpoint=37"/>
        </Phases>
      </Operation>
      <Operation name="Inoculate" sequence="4">
        <Phases>
          <Phase name="Transfer_inoculum"/>
          <Phase name="Start_agitation" parameter="setpoint=${v.properties.impellerSpeed ?? 200}RPM"/>
          <Phase name="Start_aeration" parameter="setpoint=${v.properties.spargeRate ?? 1.0}L/min"/>
        </Phases>
      </Operation>
      <Operation name="Culture" sequence="5">
        <Phases>
          <Phase name="Growth_phase" parameter="DO_setpoint=${v.properties.doSetpoint ?? 40}%"/>
          <Phase name="Production_phase"/>
          <Phase name="Harvest_trigger"/>
        </Phases>
      </Operation>
      <Operation name="Harvest" sequence="6">
        <Phases>
          <Phase name="Stop_aeration"/>
          <Phase name="Stop_agitation"/>
          <Phase name="Transfer_to_downstream"/>
        </Phases>
      </Operation>
    </Operations>
  </UnitProcedure>`).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ISA-88 Recipe Skeleton -->
<!-- Generated from SCADA Lab Setup: ${graph.plantName} -->
<!-- Generated: ${new Date().toISOString()} -->
<Recipe xmlns="urn:isa88:recipe:1.0"
        id="RECIPE-001"
        name="${graph.plantName.replace(/\s+/g, '_')}"
        version="1.0">

  <Header>
    <ProductID>PRODUCT-001</ProductID>
    <RecipeType>Master</RecipeType>
    <Author>BioReactorAgent SCADA</Author>
    <Date>${new Date().toISOString().split('T')[0]}</Date>
    <Equipment>
      <Units>${vessels.map(v => `<Unit id="${v.id}" name="${v.name}" volume="${v.properties.workingVolume ?? 100}L"/>`).join('\n      ')}</Units>
      <Pumps>${pumps.map(p => `<Pump id="${p.id}" name="${p.name}"/>`).join('\n      ')}</Pumps>
    </Equipment>
  </Header>

  <Procedure>
${unitProcedures}
  </Procedure>

</Recipe>`
}

export function ExportPanel({ graph, simState, simConfig, onClose }: ExportPanelProps) {
  const [format, setFormat] = useState<ExportFormat>('json')
  const [copied, setCopied] = useState(false)

  const getContent = () => {
    switch (format) {
      case 'json':   return exportToJSON(graph, simState)
      case 'python': return generatePythonScript(graph, simConfig)
      case 'isa88':  return generateISA88(graph)
    }
  }

  const content = getContent()

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const ext = format === 'json' ? 'json' : format === 'python' ? 'py' : 'xml'
    const filename = `${graph.plantName.replace(/\s+/g, '_')}_export.${ext}`
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }

  const formatInfo: Record<ExportFormat, { label: string; description: string; badge: string }> = {
    json:   { label: 'JSON Plant Model', description: 'Full plant graph with parameters, suitable for Aspen Plus, SuperPro Designer, or Pyomo import', badge: '.json' },
    python: { label: 'Python Simulation Script', description: 'SciPy ODE simulation stub pre-populated with Monod kinetics and current parameters', badge: '.py' },
    isa88:  { label: 'ISA-88 Recipe Skeleton', description: 'Unit procedures and operations based on equipment and connections (XML)', badge: '.xml' },
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-slate-600 rounded-xl shadow-2xl w-full max-w-3xl flex flex-col max-h-[85vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white">Export Plant Diagram</h2>
            <p className="text-xs text-slate-400">{graph.plantName} &middot; {graph.nodes.length} elements &middot; {graph.edges.length} connections</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Format selector */}
        <div className="flex gap-2 px-5 py-3 border-b border-slate-700 shrink-0">
          {(Object.entries(formatInfo) as [ExportFormat, typeof formatInfo[ExportFormat]][]).map(([fmt, info]) => (
            <button
              key={fmt}
              onClick={() => setFormat(fmt)}
              className={`flex-1 text-left rounded-lg border p-3 transition-all ${
                format === fmt
                  ? 'bg-blue-900/40 border-blue-600 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs font-semibold">{info.label}</span>
                <span className="text-xs font-mono bg-slate-700 px-1.5 py-0.5 rounded text-slate-300">{info.badge}</span>
              </div>
              <p className="text-xs opacity-75 leading-snug">{info.description}</p>
            </button>
          ))}
        </div>

        {/* Content preview */}
        <div className="flex-1 overflow-hidden p-4">
          <pre className="h-full overflow-auto bg-slate-950 border border-slate-700 rounded-lg p-3 text-xs font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">
            {content}
          </pre>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 px-5 py-4 border-t border-slate-700 shrink-0">
          <button
            onClick={handleCopy}
            className={`px-4 py-2 rounded text-sm font-medium transition-colors ${
              copied
                ? 'bg-green-700 text-green-100'
                : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
            }`}
          >
            {copied ? '✓ Copied' : 'Copy to Clipboard'}
          </button>
          <button
            onClick={handleDownload}
            className="px-4 py-2 rounded text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Download File
          </button>
          <span className="ml-auto text-xs text-slate-500">
            {content.length.toLocaleString()} characters
          </span>
        </div>
      </div>
    </div>
  )
}
