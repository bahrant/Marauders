import { dia, shapes, util, g, ui } from '@joint/plus'

const POWER_FLAG = 'POWER'
const FLOW_FLAG = 'FLOW'
const OPEN_FLAG = 'OPEN'
const BROKEN_FLAG = 'BROKEN'

const LIQUID_COLOR = '#0EAD69'
const MAX_LIQUID_COLOR = '#ED2637'
const MIN_LIQUID_COLOR = '#FFD23F'
const BROKEN_COLOR = '#ff0000'

const r = 30
const d = 10
const l = (3 * r) / 4
const step = 20

// ============ ELEMENT CLASSES ============

class Pump extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Pump',
      size: { width: 100, height: 100 },
      power: 0,
      broken: false,
      attrs: {
        root: { magnetSelector: 'body' },
        body: { rx: 'calc(w / 2)', ry: 'calc(h / 2)', cx: 'calc(w / 2)', cy: 'calc(h / 2)', stroke: 'gray', strokeWidth: 2, fill: 'lightgray' },
        label: { text: 'Pump', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(0.5*w)', y: 'calc(h+10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' },
        rotorGroup: { transform: 'translate(calc(w/2),calc(h/2))', cursor: 'pointer' },
        rotorFrame: { r: 40, fill: '#eee', stroke: '#666', strokeWidth: 2 },
        rotorBackground: { r: 34, fill: '#777', stroke: '#222', strokeWidth: 1 },
        rotor: { d: `M 0 0 V ${r} l ${-d} ${-l} Z M 0 0 V ${-r} l ${d} ${l} Z M 0 0 H ${r} l ${-l} ${d} Z M 0 0 H ${-r} l ${l} ${-d} Z`, stroke: '#222', strokeWidth: 3, fill: '#bbb' }
      },
      ports: {
        groups: {
          pipes: {
            position: { name: 'ellipse', args: { dr: 0, dx: 0, dy: 0 } },
            markup: util.svg`<circle @selector='portBody' r='8' fill='#666' stroke='#333' stroke-width='2'/>`,
            attrs: { portRoot: { magnet: true } }
          }
        },
        items: [
          { id: 'left', group: 'pipes', args: { x: 0, y: 50 } },
          { id: 'right', group: 'pipes', args: { x: 100, y: 50 } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<ellipse @selector='body' /><g @selector='rotorGroup'><circle @selector='rotorFrame' /><circle @selector='rotorBackground' /><path @selector='rotor' /></g><text @selector='label' />` }
  get power() { return this.get('broken') ? 0 : (this.get('power') || 0) }
  set power(value) { this.set('power', value) }
}

const PumpView = dia.ElementView.extend({
  presentationAttributes: dia.ElementView.addPresentationAttributes({ power: [POWER_FLAG], broken: [BROKEN_FLAG] }),
  initFlag: [dia.ElementView.Flags.RENDER, POWER_FLAG, BROKEN_FLAG],
  confirmUpdate(...args: unknown[]) {
    let flags = dia.ElementView.prototype.confirmUpdate.call(this, ...args)
    if (this.hasFlag(flags, POWER_FLAG)) { this.togglePower(); flags = this.removeFlag(flags, POWER_FLAG) }
    if (this.hasFlag(flags, BROKEN_FLAG)) { this.updateBroken(); flags = this.removeFlag(flags, BROKEN_FLAG) }
    return flags
  },
  getSpinAnimation() {
    if (this.spinAnimation) return this.spinAnimation
    const rotorEl = this.findNode('rotor')
    this.spinAnimation = rotorEl.animate({ transform: ['rotate(0deg)', 'rotate(360deg)'] }, { fill: 'forwards', duration: 1000, iterations: Infinity })
    return this.spinAnimation
  },
  togglePower() { this.getSpinAnimation().playbackRate = this.model.power },
  updateBroken() {
    const broken = this.model.get('broken')
    this.findNode('body').style.fill = broken ? BROKEN_COLOR : 'lightgray'
    this.findNode('rotorBackground').style.fill = broken ? '#800' : '#777'
  }
})

class ControlValve extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'ControlValve',
      size: { width: 60, height: 60 },
      open: 1,
      broken: false,
      attrs: {
        root: { magnetSelector: 'body' },
        body: { rx: 'calc(w / 2)', ry: 'calc(h / 2)', cx: 'calc(w / 2)', cy: 'calc(h / 2)', stroke: 'gray', strokeWidth: 2, fill: { type: 'radialGradient', stops: [{ offset: '80%', color: 'white' }, { offset: '100%', color: 'gray' }] } },
        liquid: { d: 'M calc(w / 2 + 12) calc(h / 2) h -24', stroke: LIQUID_COLOR, strokeWidth: 24, strokeDasharray: '3,1' },
        cover: { x: 'calc(w / 2 - 12)', y: 'calc(h / 2 - 12)', width: 24, height: 24, stroke: '#333', strokeWidth: 2, fill: '#fff' },
        coverFrame: { x: 'calc(w / 2 - 15)', y: 'calc(h / 2 - 15)', width: 30, height: 30, stroke: '#777', strokeWidth: 2, fill: 'none', rx: 1, ry: 1 },
        stem: { width: 10, height: 30, x: 'calc(w / 2 - 5)', y: -30, stroke: '#333', strokeWidth: 2, fill: '#555' },
        control: { d: 'M 0 0 C 0 -30 60 -30 60 0 Z', transform: 'translate(calc(w / 2 - 30), -20)', stroke: '#333', strokeWidth: 2, fill: '#666' },
        label: { text: 'Valve', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(0.5*w)', y: 'calc(h+10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' }
      },
      ports: {
        groups: {
          pipes: {
            position: { name: 'absolute' },
            markup: util.svg`<circle @selector='portBody' r='8' fill='#666' stroke='#333' stroke-width='2'/>`,
            attrs: { portRoot: { magnet: true } }
          }
        },
        items: [
          { id: 'left', group: 'pipes', args: { x: -20, y: 30 } },
          { id: 'right', group: 'pipes', args: { x: 80, y: 30 } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='stem' /><path @selector='control' /><ellipse @selector='body' /><rect @selector='coverFrame' /><path @selector='liquid' /><rect @selector='cover' /><text @selector='label' />` }
}

const ControlValveView = dia.ElementView.extend({
  presentationAttributes: dia.ElementView.addPresentationAttributes({ open: [OPEN_FLAG], broken: [BROKEN_FLAG] }),
  initFlag: [dia.ElementView.Flags.RENDER, OPEN_FLAG, BROKEN_FLAG],
  framePadding: 6,
  confirmUpdate(...args: unknown[]) {
    let flags = dia.ElementView.prototype.confirmUpdate.call(this, ...args)
    this.animateLiquid()
    if (this.hasFlag(flags, OPEN_FLAG)) { this.updateCover(); flags = this.removeFlag(flags, OPEN_FLAG) }
    if (this.hasFlag(flags, BROKEN_FLAG)) { this.updateBroken(); flags = this.removeFlag(flags, BROKEN_FLAG) }
    return flags
  },
  updateCover() {
    const opening = this.model.get('broken') ? 0 : Math.max(0, Math.min(1, this.model.get('open') || 0))
    const coverEl = this.findNode('cover')
    const coverFrameEl = this.findNode('coverFrame')
    const frameWidth = Number(coverFrameEl.getAttribute('width')) - this.framePadding
    coverEl.animate({ width: [`${Math.round(frameWidth * (1 - opening))}px`] }, { fill: 'forwards', duration: 200 })
  },
  animateLiquid() {
    if (this.liquidAnimation) return
    const liquidEl = this.findNode('liquid')
    this.liquidAnimation = liquidEl.animate({ strokeDashoffset: [0, 24] }, { fill: 'forwards', iterations: Infinity, duration: 3000 })
  },
  updateBroken() {
    const broken = this.model.get('broken')
    this.findNode('body').style.stroke = broken ? BROKEN_COLOR : 'gray'
    this.findNode('control').style.fill = broken ? '#800' : '#666'
  }
})

class HandValve extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'HandValve',
      size: { width: 50, height: 50 },
      open: 1,
      broken: false,
      attrs: {
        root: { magnetSelector: 'body' },
        body: { rx: 'calc(w / 2)', ry: 'calc(h / 2)', cx: 'calc(w / 2)', cy: 'calc(h / 2)', stroke: 'gray', strokeWidth: 2, fill: { type: 'radialGradient', stops: [{ offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }] } },
        stem: { width: 10, height: 30, x: 'calc(w / 2 - 5)', y: -30, stroke: '#333', strokeWidth: 2, fill: '#555' },
        handwheel: { width: 60, height: 10, x: 'calc(w / 2 - 30)', y: -30, stroke: '#333', strokeWidth: 2, rx: 5, ry: 5, fill: '#666' },
        label: { text: 'Valve', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(0.5*w)', y: 'calc(h+10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' }
      },
      ports: {
        groups: {
          pipes: {
            position: { name: 'absolute' },
            markup: util.svg`<circle @selector='portBody' r='8' fill='#666' stroke='#333' stroke-width='2'/>`,
            attrs: { portRoot: { magnet: true } }
          }
        },
        items: [
          { id: 'left', group: 'pipes', args: { x: -20, y: 25 } },
          { id: 'right', group: 'pipes', args: { x: 70, y: 25 } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='stem' /><rect @selector='handwheel' /><ellipse @selector='body' /><text @selector='label' />` }
}

class LiquidTank extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'LiquidTank',
      size: { width: 120, height: 180 },
      level: 50,
      broken: false,
      attrs: {
        root: { magnetSelector: 'body' },
        body: { stroke: 'gray', strokeWidth: 4, x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 60, ry: 10, fill: { type: 'linearGradient', stops: [{ offset: '0%', color: 'gray' }, { offset: '30%', color: 'white' }, { offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }] } },
        liquidBg: { x: 5, y: 5, width: 'calc(w - 10)', height: 'calc(h - 10)', rx: 55, ry: 8, fill: '#ddd' },
        liquid: { x: 5, width: 'calc(w - 10)', rx: 55, ry: 8, fill: LIQUID_COLOR },
        top: { x: 0, y: 15, width: 'calc(w)', height: 15, fill: 'none', stroke: 'gray', strokeWidth: 2 },
        label: { text: 'Tank', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w / 2)', y: 'calc(h + 10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' },
        levelText: { text: '50%', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 'calc(w / 2)', y: 'calc(h / 2)', fontSize: 20, fontWeight: 'bold', fontFamily: 'sans-serif', fill: '#333' }
      },
      ports: {
        groups: {
          pipes: {
            position: { name: 'absolute' },
            markup: util.svg`<circle @selector='portBody' r='8' fill='#666' stroke='#333' stroke-width='2'/>`,
            attrs: { portRoot: { magnet: true } }
          }
        },
        items: [
          { id: 'in', group: 'pipes', args: { x: 60, y: -10 } },
          { id: 'out', group: 'pipes', args: { x: 60, y: 190 } },
          { id: 'left', group: 'pipes', args: { x: -10, y: 90 } },
          { id: 'right', group: 'pipes', args: { x: 130, y: 90 } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><rect @selector='liquidBg'/><rect @selector='liquid'/><rect @selector='top'/><text @selector='label' /><text @selector='levelText' />` }
  get level() { return this.get('level') || 0 }
  set level(value) { 
    const newLevel = Math.max(0, Math.min(100, value))
    this.set('level', newLevel)
    this.updateLiquid()
  }
  updateLiquid() {
    const level = this.level
    const height = this.size().height - 10
    const liquidHeight = (height * level) / 100
    const y = 5 + height - liquidHeight
    this.attr('liquid/y', y)
    this.attr('liquid/height', liquidHeight)
    this.attr('levelText/text', `${Math.round(level)}%`)
    
    const color = level > 80 ? MAX_LIQUID_COLOR : level < 20 ? MIN_LIQUID_COLOR : LIQUID_COLOR
    this.attr('liquid/fill', this.get('broken') ? BROKEN_COLOR : color)
  }
}

class Pipe extends dia.Link {
  defaults() {
    return {
      ...super.defaults,
      type: 'Pipe',
      z: -1,
      router: { name: 'manhattan', args: { step: 20 } },
      connector: { name: 'rounded', args: { radius: 10 } },
      flow: 0,
      pressure: 1,
      broken: false,
      attrs: {
        liquid: { connection: true, stroke: LIQUID_COLOR, strokeWidth: 8, strokeLinejoin: 'round', strokeLinecap: 'round', strokeDasharray: '8,12' },
        line: { connection: true, stroke: '#ddd', strokeWidth: 8, strokeLinejoin: 'round', strokeLinecap: 'round' },
        outline: { connection: true, stroke: '#666', strokeWidth: 12, strokeLinejoin: 'round', strokeLinecap: 'round' }
      }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='outline' fill='none'/><path @selector='line' fill='none'/><path @selector='liquid' fill='none'/>` }
}

const PipeView = dia.LinkView.extend({
  presentationAttributes: dia.LinkView.addPresentationAttributes({ flow: [FLOW_FLAG], broken: [BROKEN_FLAG] }),
  initFlag: [...dia.LinkView.prototype.initFlag, FLOW_FLAG, BROKEN_FLAG],
  confirmUpdate(...args: unknown[]) {
    let flags = dia.LinkView.prototype.confirmUpdate.call(this, ...args)
    if (this.hasFlag(flags, FLOW_FLAG)) { this.updateFlow(); flags = this.removeFlag(flags, FLOW_FLAG) }
    if (this.hasFlag(flags, BROKEN_FLAG)) { this.updateBroken(); flags = this.removeFlag(flags, BROKEN_FLAG) }
    return flags
  },
  getFlowAnimation() {
    if (this.flowAnimation) return this.flowAnimation
    const liquidEl = this.findNode('liquid')
    this.flowAnimation = liquidEl.animate({ strokeDashoffset: [60, 0] }, { fill: 'forwards', duration: 1000, iterations: Infinity })
    return this.flowAnimation
  },
  updateFlow() {
    const flow = this.model.get('broken') ? 0 : (this.model.get('flow') || 0)
    const pressure = this.model.get('pressure') || 1
    this.getFlowAnimation().playbackRate = flow * pressure
    this.findNode('liquid').style.stroke = flow === 0 ? '#ccc' : LIQUID_COLOR
    this.findNode('liquid').style.strokeWidth = `${6 + pressure * 2}px`
  },
  updateBroken() {
    const broken = this.model.get('broken')
    this.findNode('outline').style.stroke = broken ? BROKEN_COLOR : '#666'
    this.findNode('line').style.stroke = broken ? '#fcc' : '#ddd'
  }
})

class Join extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Join',
      size: { width: 30, height: 30 },
      attrs: { body: { fill: '#eee', stroke: '#666', strokeWidth: 2, d: 'M 10 0 H calc(w - 10) l 10 10 V calc(h - 10) l -10 10 H 10 l -10 -10 V 10 Z' } },
      ports: {
        groups: {
          pipes: {
            position: { name: 'absolute' },
            markup: util.svg`<circle @selector='portBody' r='6' fill='#666' stroke='#333' stroke-width='2'/>`,
            attrs: { portRoot: { magnet: true } }
          }
        },
        items: [
          { id: 'top', group: 'pipes', args: { x: 15, y: -5 } },
          { id: 'bottom', group: 'pipes', args: { x: 15, y: 35 } },
          { id: 'left', group: 'pipes', args: { x: -5, y: 15 } },
          { id: 'right', group: 'pipes', args: { x: 35, y: 15 } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='body'/>` }
}

const namespace = { ...shapes, Pipe, PipeView, LiquidTank, Pump, PumpView, ControlValve, ControlValveView, HandValve, Join }

// ============ SANDBOX INITIALIZATION ============

export interface SandboxState {
  pressure: number
  selectedElement: dia.Cell | null
}

export function initSandbox(
  container: HTMLElement, 
  toolbarContainer: HTMLElement,
  onStateChange?: (state: SandboxState) => void
): () => void {
  let pressure = 1
  let selectedElement: dia.Cell | null = null
  let elementCounter = { tank: 1, pump: 1, valve: 1, join: 1 }
  
  const graph = new dia.Graph({}, { cellNamespace: namespace })
  
  const paper = new dia.Paper({
    model: graph,
    width: container.clientWidth || 1000,
    height: container.clientHeight || 600,
    async: true,
    frozen: true,
    sorting: dia.Paper.sorting.APPROX,
    background: { color: '#F3F7F6' },
    gridSize: 20,
    drawGrid: { name: 'mesh', args: { color: '#ddd' } },
    interactive: { linkMove: true, labelMove: true },
    cellViewNamespace: namespace,
    defaultLink: () => new Pipe(),
    defaultConnectionPoint: { name: 'boundary' },
    validateConnection: (cellViewS, magnetS, cellViewT, magnetT) => {
      if (cellViewS === cellViewT) return false
      if (!magnetS || !magnetT) return false
      return true
    },
    linkPinning: false,
    snapLinks: { radius: 30 },
    markAvailable: true,
    defaultAnchor: { name: 'center' },
    defaultConnector: { name: 'rounded', args: { radius: 10 } },
    defaultRouter: { name: 'manhattan', args: { step: 20, padding: 20 } }
  })
  
  container.innerHTML = ''
  container.appendChild(paper.el)

  // Selection handling
  paper.on('element:pointerclick', (elementView) => {
    if (selectedElement) {
      unhighlight(selectedElement)
    }
    selectedElement = elementView.model
    highlight(selectedElement)
    onStateChange?.({ pressure, selectedElement })
  })

  paper.on('blank:pointerclick', () => {
    if (selectedElement) {
      unhighlight(selectedElement)
      selectedElement = null
      onStateChange?.({ pressure, selectedElement })
    }
  })

  paper.on('link:pointerclick', (linkView) => {
    if (selectedElement) {
      unhighlight(selectedElement)
    }
    selectedElement = linkView.model
    highlight(selectedElement)
    onStateChange?.({ pressure, selectedElement })
  })

  function highlight(cell: dia.Cell) {
    const view = paper.findViewByModel(cell)
    if (view) {
      view.highlight(null, { highlighter: { name: 'stroke', options: { width: 3, attrs: { stroke: '#3b82f6' } } } })
    }
  }

  function unhighlight(cell: dia.Cell) {
    const view = paper.findViewByModel(cell)
    if (view) {
      view.unhighlight(null, { highlighter: { name: 'stroke' } })
    }
  }

  // Create toolbar
  const toolbar = new ui.Toolbar({
    tools: [
      { type: 'label', text: 'Add Elements:' },
      { type: 'button', name: 'tank', text: '🛢️ Tank' },
      { type: 'button', name: 'pump', text: '⚙️ Pump' },
      { type: 'button', name: 'valve', text: '🔧 Valve' },
      { type: 'button', name: 'handvalve', text: '🎛️ Hand Valve' },
      { type: 'button', name: 'join', text: '➕ Join' },
      { type: 'separator' },
      { type: 'label', text: 'Pressure:' },
      { type: 'range', name: 'pressure', min: 0, max: 3, step: 0.1, value: 1 },
      { type: 'separator' },
      { type: 'button', name: 'break', text: '💥 Break' },
      { type: 'button', name: 'repair', text: '🔧 Repair' },
      { type: 'button', name: 'delete', text: '🗑️ Delete' },
      { type: 'separator' },
      { type: 'button', name: 'clear', text: '🧹 Clear All' },
      { type: 'button', name: 'demo', text: '📋 Load Demo' }
    ]
  })

  toolbarContainer.innerHTML = ''
  toolbarContainer.appendChild(toolbar.el)
  toolbar.render()

  toolbar.on({
    'tank:pointerclick': () => addTank(),
    'pump:pointerclick': () => addPump(),
    'valve:pointerclick': () => addControlValve(),
    'handvalve:pointerclick': () => addHandValve(),
    'join:pointerclick': () => addJoin(),
    'pressure:change': (value: number) => {
      pressure = value
      graph.getLinks().forEach(link => link.set('pressure', pressure))
      onStateChange?.({ pressure, selectedElement })
    },
    'break:pointerclick': () => breakSelected(),
    'repair:pointerclick': () => repairSelected(),
    'delete:pointerclick': () => deleteSelected(),
    'clear:pointerclick': () => clearAll(),
    'demo:pointerclick': () => loadDemo()
  })

  function addTank() {
    const tank = new LiquidTank({
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      attrs: { label: { text: `Tank ${elementCounter.tank++}` } }
    })
    tank.level = 50 + Math.random() * 30
    tank.addTo(graph)
  }

  function addPump() {
    const pump = new Pump({
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      attrs: { label: { text: `Pump ${elementCounter.pump++}` } }
    })
    pump.power = 1
    pump.addTo(graph)
  }

  function addControlValve() {
    const valve = new ControlValve({
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      open: 1,
      attrs: { label: { text: `Valve ${elementCounter.valve++}` } }
    })
    valve.addTo(graph)
  }

  function addHandValve() {
    const valve = new HandValve({
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      open: 1,
      attrs: { label: { text: `HV ${elementCounter.valve++}` } }
    })
    valve.addTo(graph)
  }

  function addJoin() {
    const join = new Join({
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 }
    })
    join.addTo(graph)
  }

  function breakSelected() {
    if (selectedElement) {
      selectedElement.set('broken', true)
    }
  }

  function repairSelected() {
    if (selectedElement) {
      selectedElement.set('broken', false)
    }
  }

  function deleteSelected() {
    if (selectedElement) {
      selectedElement.remove()
      selectedElement = null
      onStateChange?.({ pressure, selectedElement })
    }
  }

  function clearAll() {
    graph.clear()
    elementCounter = { tank: 1, pump: 1, valve: 1, join: 1 }
  }

  function loadDemo() {
    clearAll()
    
    // Create demo setup
    const tank1 = new LiquidTank({ position: { x: 50, y: 150 }, attrs: { label: { text: 'Feed Tank' } } })
    tank1.level = 80
    tank1.addTo(graph)

    const pump1 = new Pump({ position: { x: 250, y: 180 }, attrs: { label: { text: 'Feed Pump' } } })
    pump1.power = 1
    pump1.addTo(graph)

    const valve1 = new ControlValve({ position: { x: 420, y: 195 }, open: 0.75, attrs: { label: { text: 'Flow Control' } } })
    valve1.addTo(graph)

    const tank2 = new LiquidTank({ position: { x: 580, y: 150 }, attrs: { label: { text: 'Process Tank' } } })
    tank2.level = 30
    tank2.addTo(graph)

    const join1 = new Join({ position: { x: 700, y: 230 } })
    join1.addTo(graph)

    const pump2 = new Pump({ position: { x: 750, y: 300 }, attrs: { label: { text: 'Discharge' } } })
    pump2.power = 0.5
    pump2.addTo(graph)

    // Connect with pipes
    const pipe1 = new Pipe({ source: { id: tank1.id, port: 'right' }, target: { id: pump1.id, port: 'left' }, flow: 1, pressure })
    pipe1.addTo(graph)

    const pipe2 = new Pipe({ source: { id: pump1.id, port: 'right' }, target: { id: valve1.id, port: 'left' }, flow: 1, pressure })
    pipe2.addTo(graph)

    const pipe3 = new Pipe({ source: { id: valve1.id, port: 'right' }, target: { id: tank2.id, port: 'left' }, flow: 0.75, pressure })
    pipe3.addTo(graph)

    const pipe4 = new Pipe({ source: { id: tank2.id, port: 'right' }, target: { id: join1.id, port: 'left' }, flow: 0.5, pressure })
    pipe4.addTo(graph)

    const pipe5 = new Pipe({ source: { id: join1.id, port: 'bottom' }, target: { id: pump2.id, port: 'left' }, flow: 0.5, pressure })
    pipe5.addTo(graph)

    elementCounter = { tank: 3, pump: 3, valve: 2, join: 2 }

    paper.transformToFitContent({ padding: 50 })
  }

  // Simulation loop
  const intervalId = window.setInterval(() => {
    // Update tank levels based on connected flows
    graph.getElements().forEach(element => {
      if (element.get('type') === 'LiquidTank' && !element.get('broken')) {
        const tank = element as LiquidTank
        const connectedLinks = graph.getConnectedLinks(element)
        let netFlow = 0
        
        connectedLinks.forEach(link => {
          if (link.get('broken')) return
          const flow = (link.get('flow') as number) || 0
          const linkPressure = (link.get('pressure') as number) || 1
          const source = link.get('source') as { id?: string }
          
          if (source.id === element.id) {
            netFlow -= flow * linkPressure * 0.5
          } else {
            netFlow += flow * linkPressure * 0.5
          }
        })
        
        tank.level = tank.level + netFlow
      }
    })

    // Update pipe flows based on connected elements
    graph.getLinks().forEach(link => {
      if (link.get('broken')) {
        link.set('flow', 0)
        return
      }

      const source = link.get('source') as { id?: string }
      const sourceElement = source.id ? graph.getCell(source.id) : null
      
      if (sourceElement) {
        let flow = 1
        
        if (sourceElement.get('type') === 'Pump') {
          flow = sourceElement.get('broken') ? 0 : ((sourceElement as Pump).power || 0)
        } else if (sourceElement.get('type') === 'ControlValve') {
          flow = sourceElement.get('broken') ? 0 : (sourceElement.get('open') as number || 0)
        } else if (sourceElement.get('type') === 'HandValve') {
          flow = sourceElement.get('broken') ? 0 : (sourceElement.get('open') as number || 0)
        } else if (sourceElement.get('type') === 'LiquidTank') {
          const level = (sourceElement as LiquidTank).level
          flow = sourceElement.get('broken') ? 0 : (level > 10 ? 1 : level / 10)
        }
        
        link.set('flow', flow)
      }
    })
  }, 500)

  paper.unfreeze()
  
  // Load demo by default
  loadDemo()

  return () => {
    clearInterval(intervalId)
    toolbar.remove()
    paper.remove()
  }
}
