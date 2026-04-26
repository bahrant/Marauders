import { dia } from '@joint/plus'
import {
  namespace,
  LiquidTank,
  ConicTank,
  Pump,
  ControlValve,
  HandValve,
  Panel,
  Zone,
  Join,
  Pipe,
  addControls,
  // FR3 new equipment
  Bioreactor,
  Fermenter,
  Centrifuge,
  ChromatographyColumn,
  UfDfSkid,
  Lyophilizer,
  WfiGenerator,
  CleanSteamGenerator,
  ChilledWaterUnit,
  TransferPanel,
  InstrumentLoop,
} from '../ScadaVisualization/scada-init'
import type { PlantGraph, EquipmentProperties, SimulationState } from '../../types'
import { getDefaultProperties } from '../../lib/equipment/equipmentConfig'

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface LabSetupEvents {
  onTankDblClick: (id: string, name: string, probes: string[]) => void
  onPumpDblClick: (id: string, name: string, rpm: number) => void
  onElementSelect: (id: string, type: string, name: string, props: EquipmentProperties) => void
  onElementDeselect: () => void
  onGraphChange: (graph: PlantGraph) => void
}

export interface LabSetupHandle {
  // FR1 original equipment
  addLiquidTank(name: string): void
  addConicTank(name: string): void
  addPump(name: string): void
  addControlValve(name: string): void
  addHandValve(name: string): void
  addPanel(name: string): void
  addZone(name: string): void
  addJoin(): void
  // FR3 new equipment
  addBioreactor(name: string): void
  addFermenter(name: string): void
  addCentrifuge(name: string): void
  addChromColumn(name: string): void
  addUfDfSkid(name: string): void
  addLyophilizer(name: string): void
  addWfiGenerator(name: string): void
  addCleanSteamGenerator(name: string): void
  addChilledWaterUnit(name: string): void
  addTransferPanel(name: string): void
  addInstrumentLoop(name: string): void
  // Controls
  setSimulating(enabled: boolean): void
  setConnectMode(enabled: boolean): void
  setValidationEnabled(enabled: boolean): void
  // Data
  updateTankProbes(id: string, name: string, probes: string[]): void
  updatePumpRPM(id: string, name: string, rpm: number): void
  updateElementProperties(id: string, props: EquipmentProperties): void
  // Simulation
  applySimulationState(state: SimulationState): void
  getGraphData(): PlantGraph
  // Canvas
  highlightElements(ids: string[], severity: 'error' | 'warning' | 'info'): void
  clearHighlights(): void
  clear(): void
  cleanup(): void
}

const HIGHLIGHT_SOURCE = { highlighter: { name: 'stroke', options: { width: 3, attrs: { stroke: '#3b82f6', 'stroke-opacity': 0.9 } } } }
const HIGHLIGHT_ERROR   = { highlighter: { name: 'stroke', options: { width: 4, attrs: { stroke: '#ef4444', 'stroke-opacity': 0.9 } } } }
const HIGHLIGHT_WARN    = { highlighter: { name: 'stroke', options: { width: 4, attrs: { stroke: '#f59e0b', 'stroke-opacity': 0.9 } } } }
const HIGHLIGHT_INFO    = { highlighter: { name: 'stroke', options: { width: 3, attrs: { stroke: '#60a5fa', 'stroke-opacity': 0.8 } } } }

const SEV_HIGHLIGHT = { error: HIGHLIGHT_ERROR, warning: HIGHLIGHT_WARN, info: HIGHLIGHT_INFO }

function getBaseName(labelText: string): string {
  return (labelText || '').split('\n')[0].trim()
}

// ── Graph serializer ──────────────────────────────────────────────────────────

function serializeGraph(graph: dia.Graph, plantName: string): PlantGraph {
  const nodes = graph.getElements().map(el => {
    const labelText = (el.attr('label/text') as string) || ''
    return {
      id: String(el.id),
      type: el.get('type') as string,
      name: getBaseName(labelText),
      properties: (el.get('equipmentProps') as EquipmentProperties) ?? {},
      simState: el.get('simState') as Record<string, unknown> | undefined,
    }
  })

  const edges = graph.getLinks().map(link => ({
    id: String(link.id),
    source: String((link.get('source') as { id?: string })?.id ?? ''),
    target: String((link.get('target') as { id?: string })?.id ?? ''),
    flowRate: (link.get('flow') as number) ?? undefined,
  })).filter(e => e.source && e.target)

  return { nodes, edges, plantName }
}

// ── initLabSetup ──────────────────────────────────────────────────────────────

export function initLabSetup(
  container: HTMLElement,
  events: LabSetupEvents,
  plantName = 'My Pilot Plant',
): LabSetupHandle {
  const graph = new dia.Graph({}, { cellNamespace: namespace })

  const paper = new dia.Paper({
    model: graph,
    width: container.clientWidth || 900,
    height: container.clientHeight || 600,
    async: true,
    frozen: false,
    sorting: dia.Paper.sorting.APPROX,
    background: { color: '#F3F7F6' },
    interactive: { linkMove: true, stopDelegation: false },
    cellViewNamespace: namespace,
    defaultAnchor: { name: 'perpendicular' },
    defaultLink: () => new Pipe(),
  })

  container.innerHTML = ''
  container.appendChild(paper.el)

  const resizeObserver = new ResizeObserver(() => {
    paper.setDimensions(container.clientWidth, container.clientHeight)
  })
  resizeObserver.observe(container)

  let addedCount = 0
  let simulationInterval: number | null = null
  let connectMode = false
  let connectSource: dia.Element | null = null
  let selectedCell: dia.Cell | null = null
  let currentPlantName = plantName

  const nextPosition = (w = 0, h = 0) => {
    const col = addedCount % 4
    const row = Math.floor(addedCount / 4)
    addedCount++
    return { x: 80 + col * 220 - w / 2, y: 80 + row * 220 - h / 2 }
  }

  const emitGraphChange = () => {
    events.onGraphChange(serializeGraph(graph, currentPlantName))
  }

  graph.on('add remove change:source change:target change:equipmentProps', emitGraphChange)

  const clearConnectSource = () => {
    if (connectSource) {
      const view = paper.findViewByModel(connectSource)
      view?.unhighlight(null, HIGHLIGHT_SOURCE)
      connectSource = null
    }
  }

  // ── Connect mode ──────────────────────────────────────────────────────────

  paper.on('element:pointerclick', (cellView: dia.CellView, evt: dia.Event) => {
    if (!connectMode) return
    evt.stopPropagation()
    const element = cellView.model as dia.Element

    if (!connectSource) {
      connectSource = element
      cellView.highlight(null, HIGHLIGHT_SOURCE)
    } else if (connectSource.id === element.id) {
      clearConnectSource()
    } else {
      new Pipe({
        source: { id: connectSource.id, anchor: { name: 'right', args: { dy: 0 } }, connectionPoint: { name: 'anchor' } },
        target: { id: element.id, anchor: { name: 'left', args: { dy: 0 } }, connectionPoint: { name: 'anchor' } },
      }).addTo(graph)
      clearConnectSource()
    }
  })

  paper.on('blank:pointerdown', () => {
    if (connectMode) { clearConnectSource(); return }
    selectedCell = null
    events.onElementDeselect()
  })

  // ── Double-click: open config panels ─────────────────────────────────────

  paper.on('element:pointerdblclick', (cellView: dia.CellView) => {
    if (connectMode) return
    const model = cellView.model
    const type = model.get('type') as string
    const labelText = (model.attr('label/text') as string) || ''
    const baseName = getBaseName(labelText)

    if (type === 'LiquidTank' || type === 'Bioreactor' || type === 'Fermenter') {
      const probes = (model.get('probes') as string[]) || []
      events.onTankDblClick(String(model.id), baseName, probes)
    } else if (type === 'Pump') {
      const rpm = (model.get('rpm') as number) || 0
      events.onPumpDblClick(String(model.id), baseName, rpm)
    } else {
      const newName = window.prompt('Rename element:', baseName)
      if (newName !== null && newName.trim() !== '') {
        model.attr('label/text', newName.trim())
      }
    }
  })

  // ── Element selection — trigger property panel ────────────────────────────

  paper.on('element:pointerdown', (cellView: dia.CellView) => {
    if (connectMode) return
    selectedCell = cellView.model
    const model = cellView.model
    const type = model.get('type') as string
    const labelText = (model.attr('label/text') as string) || ''
    const baseName = getBaseName(labelText)
    const props = (model.get('equipmentProps') as EquipmentProperties) ?? getDefaultProperties(type)
    events.onElementSelect(String(model.id), type, baseName, props)
  })

  paper.on('link:pointerdown', (cellView: dia.CellView) => {
    if (!connectMode) { selectedCell = cellView.model; events.onElementDeselect() }
  })

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && connectMode) { clearConnectSource(); return }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCell && !connectMode) {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return
      selectedCell.remove()
      selectedCell = null
      events.onElementDeselect()
    }
  }
  document.addEventListener('keydown', handleKeyDown)

  const updateCursor = () => {
    paper.el.style.cursor = connectMode ? 'crosshair' : 'default'
  }

  // ── Element factories ─────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function createElement(
    ctor: new (...args: any[]) => dia.Element,
    type: string,
    name: string,
    w: number,
    h: number,
    extra: Record<string, unknown> = {},
  ): dia.Element {
    const pos = nextPosition(w, h)
    const defaultProps = getDefaultProperties(type)
    const el = new ctor({
      position: pos,
      attrs: { label: { text: name } },
      equipmentProps: defaultProps,
      ...extra,
    })
    el.addTo(graph)
    return el
  }

  // ── Handle (public API) ───────────────────────────────────────────────────

  const handle: LabSetupHandle = {
    // Original equipment — directly instantiate to avoid gradient-type inference issues
    addLiquidTank(name) {
      const pos = nextPosition(160, 300)
      const tank = new LiquidTank({ position: pos, attrs: { label: { text: name } }, equipmentProps: getDefaultProperties('LiquidTank') })
      tank.addTo(graph); tank.level = 50
    },
    addConicTank(name) {
      const pos = nextPosition(160, 100)
      new ConicTank({ position: pos, attrs: { label: { text: name } }, equipmentProps: getDefaultProperties('ConicTank') }).addTo(graph)
    },
    addPump(name) {
      const pos = nextPosition(100, 100)
      const pump = new Pump({ position: pos, attrs: { label: { text: name } }, equipmentProps: getDefaultProperties('Pump') })
      pump.addTo(graph); addControls(paper)
    },
    addControlValve(name) {
      const pos = nextPosition(60, 60)
      const props = getDefaultProperties('ControlValve')
      new ControlValve({ position: pos, open: 0.5, attrs: { label: { text: name } }, equipmentProps: props }).addTo(graph)
      addControls(paper)
    },
    addHandValve(name) {
      const pos = nextPosition(50, 50)
      const props = getDefaultProperties('HandValve')
      new HandValve({ position: pos, open: 1, attrs: { label: { text: name } }, equipmentProps: props }).addTo(graph)
      addControls(paper)
    },
    addPanel(name) {
      const pos = nextPosition(100, 230)
      new Panel({ position: pos, attrs: { label: { text: name } } }).addTo(graph)
    },
    addZone(name) {
      const pos = nextPosition(120, 40)
      new Zone({ position: pos, attrs: { label: { text: name } } }).addTo(graph)
    },
    addJoin() {
      const pos = nextPosition(30, 30)
      new Join({ position: pos }).addTo(graph)
    },

    // FR3 new equipment
    addBioreactor(name) {
      const pos = nextPosition(160, 300)
      const el = new Bioreactor({ position: pos, attrs: { label: { text: name } }, equipmentProps: getDefaultProperties('Bioreactor') })
      el.addTo(graph)
      el.level = 50
    },
    addFermenter(name) {
      const pos = nextPosition(160, 280)
      const el = new Fermenter({ position: pos, attrs: { label: { text: name } }, equipmentProps: getDefaultProperties('Fermenter') })
      el.addTo(graph)
      el.level = 50
    },
    addCentrifuge(name) { createElement(Centrifuge, 'Centrifuge', name, 100, 100) },
    addChromColumn(name) { createElement(ChromatographyColumn, 'ChromatographyColumn', name, 70, 200) },
    addUfDfSkid(name) { createElement(UfDfSkid, 'UfDfSkid', name, 160, 80) },
    addLyophilizer(name) { createElement(Lyophilizer, 'Lyophilizer', name, 140, 100) },
    addWfiGenerator(name) { createElement(WfiGenerator, 'WfiGenerator', name, 80, 200) },
    addCleanSteamGenerator(name) { createElement(CleanSteamGenerator, 'CleanSteamGenerator', name, 110, 110) },
    addChilledWaterUnit(name) { createElement(ChilledWaterUnit, 'ChilledWaterUnit', name, 130, 90) },
    addTransferPanel(name) { createElement(TransferPanel, 'TransferPanel', name, 90, 90) },
    addInstrumentLoop(name) { createElement(InstrumentLoop, 'InstrumentLoop', name, 80, 50) },

    // Property management (FR3 domain params)
    updateElementProperties(id, props) {
      const el = graph.getCell(id)
      if (!el) return
      el.set('equipmentProps', { ...(el.get('equipmentProps') as EquipmentProperties ?? {}), ...props })
      emitGraphChange()
    },

    // Probe/RPM config (existing)
    updateTankProbes(id, name, probes) {
      const el = graph.getCell(id) as LiquidTank
      if (!el) return
      el.set('probes', probes)
      const probeText = probes.length > 0 ? `\n${probes.join('  ')}` : ''
      el.attr('label/text', `${name}${probeText}`)
    },
    updatePumpRPM(id, name, rpm) {
      const el = graph.getCell(id) as Pump
      if (!el) return
      const props = (el.get('equipmentProps') as EquipmentProperties) ?? {}
      el.set('rpm', rpm)
      el.set('equipmentProps', { ...props, impellerSpeed: rpm })
      el.attr('label/text', rpm > 0 ? `${name}\n${rpm} RPM` : name)
    },

    // FR2 Physics simulation — apply computed state back to JointJS elements
    applySimulationState(state: SimulationState) {
      for (const node of graph.getElements()) {
        const id = String(node.id)
        const elState = state.elements[id]
        if (!elState) continue

        node.set('simState', elState)

        const type = node.get('type') as string
        if ((type === 'LiquidTank' || type === 'Bioreactor' || type === 'Fermenter') && elState.level !== undefined) {
          ;(node as LiquidTank).level = elState.level
        }
      }

      for (const link of graph.getLinks()) {
        const id = String(link.id)
        const linkState = state.links[id]
        if (linkState) link.set('flow', linkState.flowRate > 0.01 ? linkState.flowRate : 0)
      }
    },

    // FR2 Physics simulation toggle
    setSimulating(enabled) {
      if (simulationInterval !== null) { clearInterval(simulationInterval); simulationInterval = null }

      if (!enabled) {
        graph.getLinks().forEach(link => link.set('flow', 0))
        graph.getElements().forEach(el => {
          if (el.get('type') === 'Pump') (el as Pump).power = 0
        })
        return
      }

      graph.getElements().forEach(el => {
        if (el.get('type') === 'Pump') {
          const rpm = (el.get('rpm') as number) || 120
          ;(el as Pump).power = Math.max(0.2, Math.min(3, rpm / 400))
        }
      })

      // Basic flow animation tick (physics state is driven by React via applySimulationState)
      simulationInterval = window.setInterval(() => {
        graph.getLinks().forEach(link => {
          const current = link.get('flow') as number || 0
          if (current > 0) link.set('flow', current)  // keep animation running
        })
      }, 500)
    },

    setConnectMode(enabled) {
      connectMode = enabled
      if (!enabled) clearConnectSource()
      updateCursor()
    },

    setValidationEnabled(_enabled) { /* reactive — controlled by React */ },

    // FR1 Validation highlighting
    highlightElements(ids, severity) {
      const opt = SEV_HIGHLIGHT[severity] ?? HIGHLIGHT_WARN
      for (const id of ids) {
        const el = graph.getCell(id)
        if (!el) continue
        const view = paper.findViewByModel(el)
        if (view) view.highlight(null, opt)
      }
    },

    clearHighlights() {
      graph.getElements().forEach(el => {
        const view = paper.findViewByModel(el)
        if (view) {
          try {
            view.unhighlight(null, HIGHLIGHT_ERROR)
            view.unhighlight(null, HIGHLIGHT_WARN)
            view.unhighlight(null, HIGHLIGHT_INFO)
          } catch { /* ignore if no highlight */ }
        }
      })
    },

    // FR5 Graph serialization for export
    getGraphData(): PlantGraph {
      return serializeGraph(graph, currentPlantName)
    },

    clear() {
      if (simulationInterval !== null) { clearInterval(simulationInterval); simulationInterval = null }
      clearConnectSource()
      graph.clear()
      addedCount = 0
    },

    cleanup() {
      if (simulationInterval !== null) { clearInterval(simulationInterval); simulationInterval = null }
      resizeObserver.disconnect()
      document.removeEventListener('keydown', handleKeyDown)
      paper.remove()
    },
  }

  // Expose a way to update the plant name for serialization
  ;(handle as LabSetupHandle & { setPlantName(n: string): void }).setPlantName = (n: string) => {
    currentPlantName = n
  }

  return handle
}
