import { dia, shapes, util, g } from '@joint/plus'

const POWER_FLAG = 'POWER'
const FLOW_FLAG = 'FLOW'
const OPEN_FLAG = 'OPEN'

const LIQUID_COLOR = '#0EAD69'
const MAX_LIQUID_COLOR = '#ED2637'
const MIN_LIQUID_COLOR = '#FFD23F'

const r = 30
const d = 10
const l = (3 * r) / 4
const step = 20

export class Pump extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Pump',
      size: { width: 100, height: 100 },
      power: 0,
      attrs: {
        root: { magnetSelector: 'body' },
        body: { rx: 'calc(w / 2)', ry: 'calc(h / 2)', cx: 'calc(w / 2)', cy: 'calc(h / 2)', stroke: 'gray', strokeWidth: 2, fill: 'lightgray' },
        label: { text: 'Pump', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(0.5*w)', y: 'calc(h+10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' },
        rotorGroup: { transform: 'translate(calc(w/2),calc(h/2))', event: 'element:power:click', cursor: 'pointer' },
        rotorFrame: { r: 40, fill: '#eee', stroke: '#666', strokeWidth: 2 },
        rotorBackground: { r: 34, fill: '#777', stroke: '#222', strokeWidth: 1, style: { transition: 'fill 0.5s ease-in-out' } },
        rotor: { d: `M 0 0 V ${r} l ${-d} ${-l} Z M 0 0 V ${-r} l ${d} ${l} Z M 0 0 H ${r} l ${-l} ${d} Z M 0 0 H ${-r} l ${l} ${-d} Z`, stroke: '#222', strokeWidth: 3, fill: '#bbb' }
      },
      ports: {
        groups: {
          pipes: {
            position: { name: 'line', args: { start: { x: 'calc(w / 2)', y: 'calc(h)' }, end: { x: 'calc(w / 2)', y: 0 } } },
            markup: util.svg`<rect @selector='pipeBody' /><rect @selector='pipeEnd' />`,
            size: { width: 80, height: 30 },
            attrs: {
              portRoot: { magnetSelector: 'pipeEnd' },
              pipeBody: { width: 'calc(w)', height: 'calc(h)', y: 'calc(h / -2)', fill: { type: 'linearGradient', stops: [{ offset: '0%', color: 'gray' }, { offset: '30%', color: 'white' }, { offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }], attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' } } },
              pipeEnd: { width: 10, height: 'calc(h+6)', y: 'calc(h / -2 - 3)', stroke: 'gray', strokeWidth: 3, fill: 'white' }
            }
          }
        },
        items: [
          { id: 'left', group: 'pipes', z: 1, attrs: { pipeBody: { x: 'calc(-1 * w)' }, pipeEnd: { x: 'calc(-1 * w)' } } },
          { id: 'right', group: 'pipes', z: 0, attrs: { pipeEnd: { x: 'calc(w - 10)' } } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<ellipse @selector='body' /><g @selector='rotorGroup'><circle @selector='rotorFrame' /><circle @selector='rotorBackground' /><path @selector='rotor' /></g><text @selector='label' />` }
  get power() { return this.get('power') || 0 }
  set power(value) { this.set('power', value) }
}

export const PumpView = dia.ElementView.extend({
  presentationAttributes: dia.ElementView.addPresentationAttributes({ power: [POWER_FLAG] }),
  initFlag: [dia.ElementView.Flags.RENDER, POWER_FLAG],
  confirmUpdate(...args: unknown[]) {
    let flags = dia.ElementView.prototype.confirmUpdate.call(this, ...args)
    if (this.hasFlag(flags, POWER_FLAG)) { this.togglePower(); flags = this.removeFlag(flags, POWER_FLAG) }
    return flags
  },
  getSpinAnimation() {
    let { spinAnimation } = this
    if (spinAnimation) return spinAnimation
    const rotorEl = this.findNode('rotor')
    spinAnimation = rotorEl.animate({ transform: ['rotate(0deg)', 'rotate(360deg)'] }, { fill: 'forwards', duration: 1000, iterations: Infinity })
    this.spinAnimation = spinAnimation
    return spinAnimation
  },
  togglePower() { this.getSpinAnimation().playbackRate = this.model.power }
})

export class ControlValve extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'ControlValve',
      size: { width: 60, height: 60 },
      open: 1,
      attrs: {
        root: { magnetSelector: 'body' },
        body: { rx: 'calc(w / 2)', ry: 'calc(h / 2)', cx: 'calc(w / 2)', cy: 'calc(h / 2)', stroke: 'gray', strokeWidth: 2, fill: { type: 'radialGradient', stops: [{ offset: '80%', color: 'white' }, { offset: '100%', color: 'gray' }] } },
        liquid: { d: 'M calc(w / 2 + 12) calc(h / 2) h -24', stroke: LIQUID_COLOR, strokeWidth: 24, strokeDasharray: '3,1' },
        cover: { x: 'calc(w / 2 - 12)', y: 'calc(h / 2 - 12)', width: 24, height: 24, stroke: '#333', strokeWidth: 2, fill: '#fff' },
        coverFrame: { x: 'calc(w / 2 - 15)', y: 'calc(h / 2 - 15)', width: 30, height: 30, stroke: '#777', strokeWidth: 2, fill: 'none', rx: 1, ry: 1 },
        stem: { width: 10, height: 30, x: 'calc(w / 2 - 5)', y: -30, stroke: '#333', strokeWidth: 2, fill: '#555' },
        control: { d: 'M 0 0 C 0 -30 60 -30 60 0 Z', transform: 'translate(calc(w / 2 - 30), -20)', stroke: '#333', strokeWidth: 2, rx: 5, ry: 5, fill: '#666' },
        label: { text: 'Valve', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(0.5*w)', y: 'calc(h+10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' }
      },
      ports: {
        groups: {
          pipes: {
            position: { name: 'absolute', args: { x: 'calc(w / 2)', y: 'calc(h / 2)' } },
            markup: util.svg`<rect @selector='pipeBody' /><rect @selector='pipeEnd' />`,
            size: { width: 50, height: 30 },
            attrs: {
              portRoot: { magnetSelector: 'pipeEnd' },
              pipeBody: { width: 'calc(w)', height: 'calc(h)', y: 'calc(h / -2)', fill: { type: 'linearGradient', stops: [{ offset: '0%', color: 'gray' }, { offset: '30%', color: 'white' }, { offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }], attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' } } },
              pipeEnd: { width: 10, height: 'calc(h+6)', y: 'calc(h / -2 - 3)', stroke: 'gray', strokeWidth: 3, fill: 'white' }
            }
          }
        },
        items: [
          { id: 'left', group: 'pipes', z: 0, attrs: { pipeBody: { x: 'calc(-1 * w)' }, pipeEnd: { x: 'calc(-1 * w)' } } },
          { id: 'right', group: 'pipes', z: 0, attrs: { pipeEnd: { x: 'calc(w - 10)' } } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='stem' /><path @selector='control' /><ellipse @selector='body' /><rect @selector='coverFrame' /><path @selector='liquid' /><rect @selector='cover' /><text @selector='label' />` }
}

export const ControlValveView = dia.ElementView.extend({
  presentationAttributes: dia.ElementView.addPresentationAttributes({ open: ['OPEN'] }),
  initFlag: [dia.ElementView.Flags.RENDER, 'OPEN'],
  framePadding: 6,
  confirmUpdate(...args: unknown[]) {
    let flags = dia.ElementView.prototype.confirmUpdate.call(this, ...args)
    this.animateLiquid()
    if (this.hasFlag(flags, 'OPEN')) { this.updateCover(); flags = this.removeFlag(flags, 'OPEN') }
    return flags
  },
  updateCover() {
    const opening = Math.max(0, Math.min(1, this.model.get('open') || 0))
    const coverEl = this.findNode('cover')
    const coverFrameEl = this.findNode('coverFrame')
    const frameWidth = Number(coverFrameEl.getAttribute('width')) - this.framePadding
    coverEl.animate({ width: [`${Math.round(frameWidth * (1 - opening))}px`] }, { fill: 'forwards', duration: 200 })
  },
  animateLiquid() {
    if (this.liquidAnimation) return
    const liquidEl = this.findNode('liquid')
    this.liquidAnimation = liquidEl.animate({ strokeDashoffset: [0, 24] }, { fill: 'forwards', iterations: Infinity, duration: 3000 })
  }
})

export class HandValve extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'HandValve',
      size: { width: 50, height: 50 },
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
            position: { name: 'absolute', args: { x: 'calc(w / 2)', y: 'calc(h / 2)' } },
            markup: util.svg`<rect @selector='pipeBody' /><rect @selector='pipeEnd' />`,
            size: { width: 50, height: 30 },
            attrs: {
              portRoot: { magnetSelector: 'pipeEnd' },
              pipeBody: { width: 'calc(w)', height: 'calc(h)', y: 'calc(h / -2)', fill: { type: 'linearGradient', stops: [{ offset: '0%', color: 'gray' }, { offset: '30%', color: 'white' }, { offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }], attrs: { x1: '0%', y1: '0%', x2: '0%', y2: '100%' } } },
              pipeEnd: { width: 10, height: 'calc(h+6)', y: 'calc(h / -2 - 3)', stroke: 'gray', strokeWidth: 3, fill: 'white' }
            }
          }
        },
        items: [
          { id: 'left', group: 'pipes', z: 0, attrs: { pipeBody: { x: 'calc(-1 * w)' }, pipeEnd: { x: 'calc(-1 * w)' } } },
          { id: 'right', group: 'pipes', z: 0, attrs: { pipeEnd: { x: 'calc(w - 10)' } } }
        ]
      }
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='stem' /><rect @selector='handwheel' /><ellipse @selector='body' /><text @selector='label' />` }
}

export class LiquidTank extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'LiquidTank',
      size: { width: 160, height: 300 },
      attrs: {
        root: { magnetSelector: 'body' },
        legs: { fill: 'none', stroke: '#350100', strokeWidth: 8, strokeLinecap: 'round', d: 'M 20 calc(h) l -5 10 M calc(w - 20) calc(h) l 5 10' },
        body: { stroke: 'gray', strokeWidth: 4, x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 120, ry: 10, fill: { type: 'linearGradient', stops: [{ offset: '0%', color: 'gray' }, { offset: '30%', color: 'white' }, { offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }] } },
        top: { x: 0, y: 20, width: 'calc(w)', height: 20, fill: 'none', stroke: 'gray', strokeWidth: 2 },
        label: { text: 'Tank 1', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w / 2)', y: 'calc(h + 10)', fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' }
      }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='legs'/><rect @selector='body'/><rect @selector='top'/><text @selector='label' />` }
  get level() { return this.get('level') || 0 }
  set level(level) { this.set('level', Math.max(0, Math.min(100, level))) }
}

export class ConicTank extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'ConicTank',
      size: { width: 160, height: 100 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { stroke: 'gray', strokeWidth: 4, x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 120, ry: 10, fill: { type: 'linearGradient', stops: [{ offset: '0%', color: 'gray' }, { offset: '30%', color: 'white' }, { offset: '70%', color: 'white' }, { offset: '100%', color: 'gray' }] } },
        top: { x: 0, y: 20, width: 'calc(w)', height: 20, fill: 'none', stroke: 'gray', strokeWidth: 2 },
        bottom: { d: 'M 0 0 L calc(w) 0 L calc(w / 2 + 10) 70 h -20 Z', transform: 'translate(0, calc(h - 10))', stroke: 'gray', strokeLinejoin: 'round', strokeWidth: 2, fill: { type: 'linearGradient', stops: [{ offset: '10%', color: '#aaa' }, { offset: '30%', color: '#fff' }, { offset: '90%', color: '#aaa' }], attrs: { gradientTransform: 'rotate(-10)' } } },
        label: { text: 'Tank 2', textAnchor: 'middle', textVerticalAnchor: 'bottom', x: 'calc(w / 2)', y: -10, fontSize: 14, fontFamily: 'sans-serif', fill: '#350100' }
      }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='bottom'/><rect @selector='body'/><rect @selector='top'/><text @selector='label' />` }
}

export class Panel extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Panel',
      size: { width: 100, height: 230 },
      level: 0,
      attrs: {
        root: { magnetSelector: 'panelBody' },
        panelBody: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 1, ry: 1, fill: 'lightgray', stroke: 'gray', strokeWidth: 1 },
        panelWindow: { transform: 'translate(10, 10) rotate(180) translate(-40,-205)' },
        panelTicks: { transform: 'translate(55, 15)', d: `M 0 0 h 8 M 0 ${step} h 8 M 0 ${step * 2} h 8 M 0 ${step * 3} h 8 M 0 ${step * 4} h 8 M 0 ${step * 5} h 8 M 0 ${step * 6} h 8 M 0 ${step * 7} h 8 M 0 ${step * 8} h 8 M 0 ${step * 9} h 8 M 0 ${step * 10} h 8`, fill: 'none', stroke: 'black', strokeWidth: 2, strokeLinecap: 'round' },
        panelValues: { text: '100\n90\n80\n70\n60\n50\n40\n30\n20\n10\n0', textAnchor: 'middle', textVerticalAnchor: 'top', x: 80, y: 10, lineHeight: step, fontSize: 14, fontFamily: 'sans-serif' },
        frame: { width: 40, height: 200, rx: 1, ry: 1, fill: 'none', stroke: 'black', strokeWidth: 3 },
        liquid: { x: 0, y: 0, width: 40, height: 0, stroke: 'black', strokeWidth: 2, strokeOpacity: 0.2, fill: MIN_LIQUID_COLOR },
        glass: { x: 0, y: 0, width: 40, height: 200, fill: 'blue', stroke: 'none', fillOpacity: 0.1 },
        label: { text: 'Tank 1', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w / 2)', y: 'calc(h + 10)', fontSize: 20, fontFamily: 'sans-serif', fill: '#350100' }
      }
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='panelBody'/><path @selector='panelTicks'/><text @selector='panelValues' /><g @selector='panelWindow'><rect @selector='glass'/><rect @selector='liquid'/><rect @selector='frame'/></g>` }
}

export const PanelView = dia.ElementView.extend({
  presentationAttributes: dia.ElementView.addPresentationAttributes({ level: ['LEVEL'], color: ['LEVEL'] }),
  initFlag: [dia.ElementView.Flags.RENDER, 'LEVEL'],
  confirmUpdate(...args: unknown[]) {
    let flags = dia.ElementView.prototype.confirmUpdate.call(this, ...args)
    if (this.hasFlag(flags, 'LEVEL')) { this.updateLevel(); flags = this.removeFlag(flags, 'LEVEL') }
    return flags
  },
  updateLevel() {
    const level = Math.max(0, Math.min(100, this.model.get('level') || 0))
    const color = this.model.get('color') || 'red'
    const liquidEl = this.findNode('liquid')
    const windowEl = this.findNode('frame')
    const height = Math.round((Number(windowEl.getAttribute('height')) * level) / 100)
    liquidEl.animate({ height: [`${height}px`], fill: [color] }, { fill: 'forwards', duration: 1000 })
  }
})

export class Pipe extends dia.Link {
  defaults() {
    return {
      ...super.defaults,
      type: 'Pipe',
      z: -1,
      router: { name: 'rightAngle' },
      flow: 1,
      attrs: {
        liquid: { connection: true, stroke: LIQUID_COLOR, strokeWidth: 10, strokeLinejoin: 'round', strokeLinecap: 'square', strokeDasharray: '10,20' },
        line: { connection: true, stroke: '#eee', strokeWidth: 10, strokeLinejoin: 'round', strokeLinecap: 'round' },
        outline: { connection: true, stroke: '#444', strokeWidth: 16, strokeLinejoin: 'round', strokeLinecap: 'round' }
      }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='outline' fill='none'/><path @selector='line' fill='none'/><path @selector='liquid' fill='none'/>` }
}

export const PipeView = dia.LinkView.extend({
  presentationAttributes: dia.LinkView.addPresentationAttributes({ flow: [FLOW_FLAG] }),
  initFlag: [...dia.LinkView.prototype.initFlag, FLOW_FLAG],
  confirmUpdate(...args: unknown[]) {
    let flags = dia.LinkView.prototype.confirmUpdate.call(this, ...args)
    if (this.hasFlag(flags, FLOW_FLAG)) { this.updateFlow(); flags = this.removeFlag(flags, FLOW_FLAG) }
    return flags
  },
  getFlowAnimation() {
    if (this.flowAnimation) return this.flowAnimation
    const liquidEl = this.findNode('liquid')
    this.flowAnimation = liquidEl.animate({ strokeDashoffset: [90, 0] }, { fill: 'forwards', duration: 1000, iterations: Infinity })
    return this.flowAnimation
  },
  updateFlow() {
    const flowRate = this.model.get('flow') || 0
    this.getFlowAnimation().playbackRate = flowRate
    this.findNode('liquid').style.stroke = flowRate === 0 ? '#ccc' : ''
  }
})

export class Zone extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Zone',
      size: { width: 120, height: 40 },
      attrs: {
        body: { fill: '#ffffff', stroke: '#cad8e3', strokeWidth: 1, d: 'M 0 calc(0.5*h) calc(0.5*h) 0 H calc(w) V calc(h) H calc(0.5*h) Z' },
        label: { fontSize: 14, fontFamily: 'sans-serif', fontWeight: 'bold', fill: LIQUID_COLOR, textVerticalAnchor: 'middle', textAnchor: 'middle', x: 'calc(w / 2 + 10)', y: 'calc(h / 2)' }
      }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='body'/><text @selector='label'/>` }
}

export class Join extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Join',
      size: { width: 30, height: 30 },
      attrs: { body: { fill: '#eee', stroke: '#666', strokeWidth: 2, d: 'M 10 0 H calc(w - 10) l 10 10 V calc(h - 10) l -10 10 H 10 l -10 -10 V 10 Z' } }
    }
  }
  preinitialize() { this.markup = util.svg`<path @selector='body'/>` }
}

// ── FR3 Extended Equipment Library ────────────────────────────────────────────

export class Bioreactor extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Bioreactor',
      size: { width: 160, height: 300 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { stroke: '#2563eb', strokeWidth: 4, x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 120, ry: 10, fill: '#dbeafe' },
        top: { x: 0, y: 20, width: 'calc(w)', height: 20, fill: 'none', stroke: '#2563eb', strokeWidth: 2 },
        impeller1: { d: 'M calc(w/2) calc(h*0.4) h -40', stroke: '#1d4ed8', strokeWidth: 6, strokeLinecap: 'round' },
        impeller2: { d: 'M calc(w/2) calc(h*0.4) h 40', stroke: '#1d4ed8', strokeWidth: 6, strokeLinecap: 'round' },
        impeller3: { d: 'M calc(w/2) calc(h*0.6) h -35', stroke: '#1d4ed8', strokeWidth: 5, strokeLinecap: 'round' },
        impeller4: { d: 'M calc(w/2) calc(h*0.6) h 35', stroke: '#1d4ed8', strokeWidth: 5, strokeLinecap: 'round' },
        shaft: { d: 'M calc(w/2) 0 V calc(h*0.75)', stroke: '#374151', strokeWidth: 3 },
        sparger: { d: 'M calc(w/2-20) calc(h*0.85) h 40', stroke: '#6b7280', strokeWidth: 3, strokeDasharray: '4,3' },
        jacket: { x: -8, y: 20, width: 'calc(w+16)', height: 'calc(h-20)', rx: 130, ry: 12, fill: 'none', stroke: '#93c5fd', strokeWidth: 2, strokeDasharray: '6,4' },
        label: { text: 'Bioreactor', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+10)', fontSize: 12, fontFamily: 'sans-serif', fill: '#1e3a5f' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='jacket'/><path @selector='legs'/><rect @selector='body'/><rect @selector='top'/><path @selector='shaft'/><path @selector='impeller1'/><path @selector='impeller2'/><path @selector='impeller3'/><path @selector='impeller4'/><path @selector='sparger'/><text @selector='label'/>` }
  get level() { return this.get('level') || 0 }
  set level(v) { this.set('level', Math.max(0, Math.min(100, v))) }
}

export class Fermenter extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Fermenter',
      size: { width: 160, height: 280 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { stroke: '#16a34a', strokeWidth: 4, x: 0, y: 0, width: 'calc(w)', height: 'calc(h*0.75)', rx: 120, ry: 10, fill: '#dcfce7' },
        cone: { d: 'M 0 0 L calc(w) 0 L calc(w/2+8) 70 h -16 Z', transform: 'translate(0, calc(h*0.75-10))', stroke: '#16a34a', strokeLinejoin: 'round', strokeWidth: 3, fill: '#bbf7d0' },
        coil1: { d: 'M 5 calc(h*0.2) Q calc(w/2) calc(h*0.25) calc(w-5) calc(h*0.2)', stroke: '#6ee7b7', strokeWidth: 2, fill: 'none' },
        coil2: { d: 'M 5 calc(h*0.4) Q calc(w/2) calc(h*0.45) calc(w-5) calc(h*0.4)', stroke: '#6ee7b7', strokeWidth: 2, fill: 'none' },
        agitator: { d: 'M calc(w/2-30) calc(h*0.35) h 60', stroke: '#15803d', strokeWidth: 5, strokeLinecap: 'round' },
        shaft: { d: 'M calc(w/2) 0 V calc(h*0.65)', stroke: '#374151', strokeWidth: 3 },
        label: { text: 'Fermenter', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+5)', fontSize: 12, fontFamily: 'sans-serif', fill: '#14532d' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><path @selector='cone'/><path @selector='shaft'/><path @selector='agitator'/><path @selector='coil1'/><path @selector='coil2'/><text @selector='label'/>` }
  get level() { return this.get('level') || 0 }
  set level(v) { this.set('level', Math.max(0, Math.min(100, v))) }
}

export class Centrifuge extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Centrifuge',
      size: { width: 100, height: 100 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { cx: 'calc(w/2)', cy: 'calc(h/2)', rx: 'calc(w/2)', ry: 'calc(h/2)', stroke: '#dc2626', strokeWidth: 3, fill: '#fee2e2' },
        blade1: { d: 'M calc(w/2) calc(h/2) L calc(w/2+30) calc(h/2-20)', stroke: '#b91c1c', strokeWidth: 5, strokeLinecap: 'round' },
        blade2: { d: 'M calc(w/2) calc(h/2) L calc(w/2-30) calc(h/2+20)', stroke: '#b91c1c', strokeWidth: 5, strokeLinecap: 'round' },
        blade3: { d: 'M calc(w/2) calc(h/2) L calc(w/2+20) calc(h/2+30)', stroke: '#b91c1c', strokeWidth: 5, strokeLinecap: 'round' },
        hub: { cx: 'calc(w/2)', cy: 'calc(h/2)', r: 8, fill: '#7f1d1d', stroke: '#450a0a', strokeWidth: 2 },
        label: { text: 'Centrifuge', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+8)', fontSize: 11, fontFamily: 'sans-serif', fill: '#7f1d1d' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<ellipse @selector='body'/><path @selector='blade1'/><path @selector='blade2'/><path @selector='blade3'/><circle @selector='hub'/><text @selector='label'/>` }
}

export class ChromatographyColumn extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'ChromatographyColumn',
      size: { width: 70, height: 200 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { x: 10, y: 20, width: 'calc(w-20)', height: 'calc(h-40)', stroke: '#7c3aed', strokeWidth: 3, fill: '#ede9fe' },
        capTop: { x: 0, y: 10, width: 'calc(w)', height: 15, rx: 3, fill: '#7c3aed', stroke: '#5b21b6', strokeWidth: 2 },
        capBot: { x: 0, y: 'calc(h-25)', width: 'calc(w)', height: 15, rx: 3, fill: '#7c3aed', stroke: '#5b21b6', strokeWidth: 2 },
        pack1: { d: 'M 10 calc(h*0.2) h calc(w-20)', stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '3,2' },
        pack2: { d: 'M 10 calc(h*0.3) h calc(w-20)', stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '3,2' },
        pack3: { d: 'M 10 calc(h*0.4) h calc(w-20)', stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '3,2' },
        pack4: { d: 'M 10 calc(h*0.5) h calc(w-20)', stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '3,2' },
        pack5: { d: 'M 10 calc(h*0.6) h calc(w-20)', stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '3,2' },
        pack6: { d: 'M 10 calc(h*0.7) h calc(w-20)', stroke: '#a78bfa', strokeWidth: 1.5, strokeDasharray: '3,2' },
        label: { text: 'Chrom.\nColumn', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+5)', fontSize: 10, fontFamily: 'sans-serif', fill: '#5b21b6' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><rect @selector='capTop'/><rect @selector='capBot'/><path @selector='pack1'/><path @selector='pack2'/><path @selector='pack3'/><path @selector='pack4'/><path @selector='pack5'/><path @selector='pack6'/><text @selector='label'/>` }
}

export class UfDfSkid extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'UfDfSkid',
      size: { width: 160, height: 80 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 4, stroke: '#0284c7', strokeWidth: 3, fill: '#e0f2fe' },
        mem1: { d: 'M 20 calc(h*0.3) h calc(w-40)', stroke: '#0369a1', strokeWidth: 3 },
        mem2: { d: 'M 20 calc(h*0.5) h calc(w-40)', stroke: '#0369a1', strokeWidth: 3 },
        mem3: { d: 'M 20 calc(h*0.7) h calc(w-40)', stroke: '#0369a1', strokeWidth: 3 },
        arrow1: { d: 'M calc(w*0.2) 5 V calc(h-5)', stroke: '#0284c7', strokeWidth: 2, markerEnd: 'url(#arrow)' },
        arrow2: { d: 'M calc(w*0.5) 5 V calc(h-5)', stroke: '#0284c7', strokeWidth: 2 },
        tag: { text: 'UF/DF', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 'calc(w*0.75)', y: 'calc(h/2)', fontSize: 11, fontWeight: 'bold', fontFamily: 'sans-serif', fill: '#0369a1' },
        label: { text: 'UF/DF Skid', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+8)', fontSize: 11, fontFamily: 'sans-serif', fill: '#075985' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><path @selector='mem1'/><path @selector='mem2'/><path @selector='mem3'/><path @selector='arrow1'/><path @selector='arrow2'/><text @selector='tag'/><text @selector='label'/>` }
}

export class Lyophilizer extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'Lyophilizer',
      size: { width: 140, height: 100 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 6, stroke: '#4338ca', strokeWidth: 3, fill: '#eef2ff' },
        door: { x: 10, y: 10, width: 'calc(w-20)', height: 'calc(h-20)', rx: 4, stroke: '#6366f1', strokeWidth: 2, fill: '#c7d2fe' },
        shelf1: { d: 'M 20 calc(h*0.3) h calc(w-40)', stroke: '#4338ca', strokeWidth: 2 },
        shelf2: { d: 'M 20 calc(h*0.5) h calc(w-40)', stroke: '#4338ca', strokeWidth: 2 },
        shelf3: { d: 'M 20 calc(h*0.7) h calc(w-40)', stroke: '#4338ca', strokeWidth: 2 },
        snowflake: { text: '❄', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 'calc(w*0.8)', y: 'calc(h*0.25)', fontSize: 16, fill: '#818cf8' },
        label: { text: 'Lyophilizer', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+8)', fontSize: 11, fontFamily: 'sans-serif', fill: '#3730a3' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><rect @selector='door'/><path @selector='shelf1'/><path @selector='shelf2'/><path @selector='shelf3'/><text @selector='snowflake'/><text @selector='label'/>` }
}

export class WfiGenerator extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'WfiGenerator',
      size: { width: 80, height: 200 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { x: 10, y: 0, width: 'calc(w-20)', height: 'calc(h)', rx: 4, stroke: '#0d9488', strokeWidth: 3, fill: '#ccfbf1' },
        tray1: { d: 'M 15 calc(h*0.2) h calc(w-30)', stroke: '#0f766e', strokeWidth: 2 },
        tray2: { d: 'M 15 calc(h*0.35) h calc(w-30)', stroke: '#0f766e', strokeWidth: 2 },
        tray3: { d: 'M 15 calc(h*0.5) h calc(w-30)', stroke: '#0f766e', strokeWidth: 2 },
        tray4: { d: 'M 15 calc(h*0.65) h calc(w-30)', stroke: '#0f766e', strokeWidth: 2 },
        tray5: { d: 'M 15 calc(h*0.8) h calc(w-30)', stroke: '#0f766e', strokeWidth: 2 },
        steamIn: { d: 'M calc(w/2) calc(h) V calc(h+15)', stroke: '#14b8a6', strokeWidth: 4, strokeLinecap: 'round' },
        wfiOut: { d: 'M calc(w/2) 0 V -15', stroke: '#0891b2', strokeWidth: 4, strokeLinecap: 'round' },
        label: { text: 'WFI Gen.', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+20)', fontSize: 10, fontFamily: 'sans-serif', fill: '#134e4a' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><path @selector='tray1'/><path @selector='tray2'/><path @selector='tray3'/><path @selector='tray4'/><path @selector='tray5'/><path @selector='steamIn'/><path @selector='wfiOut'/><text @selector='label'/>` }
}

export class CleanSteamGenerator extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'CleanSteamGenerator',
      size: { width: 110, height: 110 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { cx: 'calc(w/2)', cy: 'calc(h/2+10)', rx: 'calc(w/2)', ry: 40, stroke: '#d97706', strokeWidth: 3, fill: '#fef3c7' },
        steamPipe: { d: 'M calc(w/2) calc(h/2-30) V -10', stroke: '#78716c', strokeWidth: 6, strokeLinecap: 'round' },
        steamL: { d: 'M calc(w/2) -10 l -12 -12', stroke: '#78716c', strokeWidth: 3 },
        steamR: { d: 'M calc(w/2) -10 l 12 -12', stroke: '#78716c', strokeWidth: 3 },
        waterIn: { d: 'M 0 calc(h/2+10) H -12', stroke: '#6b7280', strokeWidth: 4, strokeLinecap: 'round' },
        flame1: { d: 'M calc(w/2-10) calc(h-5) Q calc(w/2) calc(h+20) calc(w/2+10) calc(h-5)', stroke: '#f97316', strokeWidth: 2, fill: 'none' },
        label: { text: 'CSG', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+8)', fontSize: 11, fontFamily: 'sans-serif', fill: '#92400e' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<ellipse @selector='body'/><path @selector='steamPipe'/><path @selector='steamL'/><path @selector='steamR'/><path @selector='waterIn'/><path @selector='flame1'/><text @selector='label'/>` }
}

export class ChilledWaterUnit extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'ChilledWaterUnit',
      size: { width: 130, height: 90 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 5, stroke: '#0891b2', strokeWidth: 3, fill: '#ecfeff' },
        coil: { d: 'M 15 calc(h*0.3) h 20 l 10 20 h -10 l 10 20 h -10 l 10 20 h 20', stroke: '#06b6d4', strokeWidth: 3, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' },
        tempTag: { text: '~5°C', textAnchor: 'start', textVerticalAnchor: 'middle', x: 'calc(w*0.65)', y: 'calc(h/2)', fontSize: 12, fontFamily: 'monospace', fill: '#0369a1', fontWeight: 'bold' },
        label: { text: 'Chilled Water', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+8)', fontSize: 11, fontFamily: 'sans-serif', fill: '#0c4a6e' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><path @selector='coil'/><text @selector='tempTag'/><text @selector='label'/>` }
}

export class TransferPanel extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'TransferPanel',
      size: { width: 90, height: 90 },
      attrs: {
        root: { magnetSelector: 'body' },
        body: { x: 0, y: 0, width: 'calc(w)', height: 'calc(h)', rx: 4, stroke: '#475569', strokeWidth: 3, fill: '#f1f5f9' },
        g1: { cx: 22, cy: 22, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#94a3b8' },
        g2: { cx: 45, cy: 22, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#94a3b8' },
        g3: { cx: 68, cy: 22, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#94a3b8' },
        g4: { cx: 22, cy: 45, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#64748b' },
        g5: { cx: 45, cy: 45, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#64748b' },
        g6: { cx: 68, cy: 45, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#64748b' },
        g7: { cx: 22, cy: 68, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#94a3b8' },
        g8: { cx: 45, cy: 68, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#94a3b8' },
        g9: { cx: 68, cy: 68, r: 8, stroke: '#475569', strokeWidth: 2, fill: '#94a3b8' },
        label: { text: 'Transfer\nPanel', textAnchor: 'middle', textVerticalAnchor: 'top', x: 'calc(w/2)', y: 'calc(h+5)', fontSize: 10, fontFamily: 'sans-serif', fill: '#334155' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<rect @selector='body'/><circle @selector='g1'/><circle @selector='g2'/><circle @selector='g3'/><circle @selector='g4'/><circle @selector='g5'/><circle @selector='g6'/><circle @selector='g7'/><circle @selector='g8'/><circle @selector='g9'/><text @selector='label'/>` }
}

export class InstrumentLoop extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'InstrumentLoop',
      size: { width: 80, height: 50 },
      attrs: {
        root: { magnetSelector: 'body1' },
        body1: { cx: 20, cy: 25, r: 18, stroke: '#ca8a04', strokeWidth: 2, fill: '#fefce8' },
        body2: { cx: 60, cy: 25, r: 18, stroke: '#ca8a04', strokeWidth: 2, fill: '#fef9c3' },
        link: { d: 'M 38 25 H 42', stroke: '#ca8a04', strokeWidth: 2 },
        tag1: { text: 'PT', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 20, y: 22, fontSize: 9, fontWeight: 'bold', fontFamily: 'sans-serif', fill: '#854d0e' },
        num1: { text: '1A', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 20, y: 31, fontSize: 8, fontFamily: 'sans-serif', fill: '#a16207' },
        tag2: { text: 'PT', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 60, y: 22, fontSize: 9, fontWeight: 'bold', fontFamily: 'sans-serif', fill: '#854d0e' },
        num2: { text: '1B', textAnchor: 'middle', textVerticalAnchor: 'middle', x: 60, y: 31, fontSize: 8, fontFamily: 'sans-serif', fill: '#a16207' },
        label: { text: 'Instrument\nLoop', textAnchor: 'middle', textVerticalAnchor: 'top', x: 40, y: 'calc(h+5)', fontSize: 10, fontFamily: 'sans-serif', fill: '#92400e' },
      },
    }
  }
  preinitialize() { this.markup = util.svg`<circle @selector='body1'/><circle @selector='body2'/><path @selector='link'/><text @selector='tag1'/><text @selector='num1'/><text @selector='tag2'/><text @selector='num2'/><text @selector='label'/>` }
}

export const namespace = {
  ...shapes,
  Zone, Pipe, PipeView,
  LiquidTank, ConicTank, Panel, PanelView,
  Pump, PumpView, ControlValve, ControlValveView, HandValve, Join,
  // FR3 equipment
  Bioreactor, Fermenter, Centrifuge, ChromatographyColumn,
  UfDfSkid, Lyophilizer, WfiGenerator, CleanSteamGenerator,
  ChilledWaterUnit, TransferPanel, InstrumentLoop,
}

// Control Highlighters
const PumpControl = dia.HighlighterView.extend({
  UPDATE_ATTRIBUTES: ['power'],
  tagName: 'g',
  children: util.svg`
    <foreignObject width='20' height='20'>
      <div class='jj-checkbox' xmlns='http://www.w3.org/1999/xhtml'>
        <input @selector='input' class='jj-checkbox-input' type='checkbox' style='width: 14px; height: 14px; box-sizing: border-box; margin: 2px;'/>
      </div>
    </foreignObject>
  `,
  events: { 'change input': 'onChange' },
  attributes: { transform: 'translate(5, 5)' },
  highlight: function(cellView: dia.CellView) {
    this.renderChildren()
    this.childNodes.input.checked = Boolean((cellView.model as Pump).power)
  },
  onChange: function(evt: Event) {
    (this.cellView.model as Pump).power = (evt.target as HTMLInputElement).checked ? 1 : 0
  }
})

const ToggleValveControl = dia.HighlighterView.extend({
  UPDATE_ATTRIBUTES: ['open'],
  children: util.svg`
    <foreignObject width='100' height='50'>
      <div class='jj-switch' xmlns='http://www.w3.org/1999/xhtml'>
        <div @selector='label' class='jj-switch-label' style=''></div>
        <button @selector='buttonOn' class='jj-switch-on'>open</button>
        <button @selector='buttonOff' class='jj-switch-off'>close</button>
      </div>
    </foreignObject>
  `,
  events: { 'click button': 'onButtonClick' },
  highlight: function(cellView: dia.CellView) {
    this.renderChildren()
    const { model } = cellView
    const { el, childNodes } = this
    const size = model.size()
    const isOpen = model.get('open')
    el.setAttribute('transform', `translate(${size.width / 2 - 50}, ${size.height + 10})`)
    childNodes.buttonOn.disabled = !isOpen
    childNodes.buttonOff.disabled = isOpen
    childNodes.label.textContent = model.attr('label/text')
  },
  onButtonClick: function() {
    const { model } = this.cellView
    model.set('open', !model.get('open'))
  }
})

const SliderValveControl = dia.HighlighterView.extend({
  UPDATE_ATTRIBUTES: ['open'],
  children: util.svg`
    <foreignObject width='100' height='60'>
      <div class='jj-slider' xmlns='http://www.w3.org/1999/xhtml'>
        <div @selector='label' class='jj-slider-label' style=''>Valve</div>
        <input @selector='slider' class='jj-slider-input' type='range' min='0' max='100' step='25' style='width:100%;'/>
        <output @selector='value' class='jj-slider-output'></output>
      </div>
    </foreignObject>
  `,
  events: { 'input input': 'onInput' },
  highlight: function(cellView: dia.CellView) {
    const { name = '' } = this.options
    const { model } = cellView
    const size = model.size()
    if (!this.childNodes) {
      this.renderChildren()
      this.childNodes.slider.value = (model.get('open') as number) * 100
    }
    this.el.setAttribute('transform', `translate(${size.width / 2 - 50}, ${size.height + 10})`)
    this.childNodes.label.textContent = name
    this.childNodes.value.textContent = this.getSliderTextValue(model.get('open') as number)
  },
  getSliderTextValue: function(value = 0) {
    if (value === 0) return 'Closed'
    if (value === 1) return 'Open'
    return `${value * 100}% open`
  },
  onInput: function(evt: Event) {
    this.cellView.model.set('open', Number((evt.target as HTMLInputElement).value) / 100)
  }
})

export function addControls(paper: dia.Paper) {
  const graph = paper.model
  graph.getElements().forEach((cell) => {
    switch (cell.get('type')) {
      case 'ControlValve':
        SliderValveControl.add(cell.findView(paper), 'root', 'slider', { name: cell.attr('label/text') })
        break
      case 'HandValve':
        ToggleValveControl.add(cell.findView(paper), 'root', 'button')
        break
      case 'Pump':
        PumpControl.add(cell.findView(paper), 'root', 'selection')
        break
    }
  })
}

export interface PIDState {
  pump1Power: number
  pump2Power: number
  controlValve1Open: number
  controlValve2Open: number
  handValve1Open: boolean
  handValve2Open: boolean
  handValve3Open: boolean
  tankLevel: number
}

export function computeMetricsFromPID(state: PIDState) {
  const totalPumpPower = state.pump1Power * 0.6 + state.pump2Power * 0.4
  const baseFlow = (state.controlValve1Open + state.controlValve2Open) / 2
  const dissolvedOxygen = Math.round((15 + totalPumpPower * 30 + baseFlow * 10) * 10) / 10
  const ph = Math.round(Math.max(6.5, Math.min(7.6, 6.8 + baseFlow * 0.4)) * 100) / 100
  return { dissolvedOxygen, pH: ph }
}

const REACTOR_CONFIGS: Record<string, { color: string; name: string; startLevel: number }> = {
  'BR-001': { color: '#3b82f6', name: 'Bioreactor 1', startLevel: 70 },
  'BR-002': { color: '#8b5cf6', name: 'Bioreactor 2', startLevel: 55 },
  'BR-003': { color: '#06b6d4', name: 'Bioreactor 3', startLevel: 80 },
  'BR-004': { color: '#f97316', name: 'Bioreactor 4', startLevel: 45 },
}

export function initScada(
  container: HTMLElement,
  reactorId: string = 'BR-001',
  onStateChange?: (state: PIDState) => void
): () => void {
  const config = REACTOR_CONFIGS[reactorId] || REACTOR_CONFIGS['BR-001']

  const graph = new dia.Graph({}, { cellNamespace: namespace })

  const paper = new dia.Paper({
    model: graph,
    width: container.clientWidth || 1000,
    height: container.clientHeight || 700,
    async: true,
    frozen: true,
    sorting: dia.Paper.sorting.APPROX,
    background: { color: '#F3F7F6' },
    interactive: { linkMove: false, stopDelegation: false },
    cellViewNamespace: namespace,
    defaultAnchor: { name: 'perpendicular' }
  })

  container.innerHTML = ''
  container.appendChild(paper.el)

  const tank1 = new LiquidTank({ position: { x: 50, y: 250 }, attrs: { label: { text: config.name } } })
  const panel1 = new Panel({ position: { x: 70, y: 300 }, attrs: { label: { text: config.name } } })
  panel1.listenTo(tank1, 'change:level', (_: unknown, level: number) => {
    const color = level > 80 ? MAX_LIQUID_COLOR : level < 20 ? MIN_LIQUID_COLOR : LIQUID_COLOR
    panel1.set({ level, color })
  })
  tank1.addTo(graph); panel1.addTo(graph); tank1.embed(panel1)

  const tank2 = new ConicTank({ position: { x: 820, y: 200 } }); tank2.addTo(graph)

  const pump1 = new Pump({ position: { x: 460, y: 250 }, attrs: { label: { text: 'Pump 1' } } }); pump1.addTo(graph); pump1.power = 1
  const pump2 = new Pump({ position: { x: 460, y: 450 }, attrs: { label: { text: 'Pump 2' } } }); pump2.addTo(graph); pump2.power = 0

  const controlValve1 = new ControlValve({ position: { x: 300, y: 295 }, open: 1, attrs: { label: { text: 'CTRL Valve 1' } } }); controlValve1.addTo(graph)
  const controlValve2 = new ControlValve({ position: { x: 300, y: 495 }, open: 0.25, attrs: { label: { text: 'CTRL Valve 2' } } }); controlValve2.addTo(graph)

  const zone1 = new Zone({ position: { x: 50, y: 600 }, attrs: { label: { text: 'Zone 1' } } })
  const zone2 = new Zone({ position: { x: 865, y: 600 }, attrs: { label: { text: 'Zone 2' } } })
  graph.addCells([zone1, zone2])

  const handValve1 = new HandValve({ position: { x: 875, y: 450 }, open: 1, angle: 270, attrs: { label: { text: 'Valve 1' } } }); handValve1.addTo(graph)
  const handValve2 = new HandValve({ position: { x: 650, y: 250 }, open: 1, angle: 0, attrs: { label: { text: 'Valve 2' } } }); handValve2.addTo(graph)
  const handValve3 = new HandValve({ position: { x: 650, y: 450 }, open: 1, angle: 0, attrs: { label: { text: 'Valve 3' } } }); handValve3.addTo(graph)

  const join1 = new Join({ position: { x: 772, y: 460 } }); join1.addTo(graph)
  const join2 = new Join({ position: { x: 810, y: 605 } }); join2.addTo(graph)

  // Pipes
  const tank1Pipe1 = new Pipe({ source: { id: tank1.id, anchor: { name: 'right', args: { dy: -25 } }, connectionPoint: { name: 'anchor' } }, target: { id: controlValve1.id, port: 'left', anchor: { name: 'left' } } }); tank1Pipe1.addTo(graph)
  const tank1Pipe2 = new Pipe({ source: { id: tank1.id, anchor: { name: 'bottomRight', args: { dy: -40 } }, connectionPoint: { name: 'anchor' } }, target: { id: controlValve2.id, port: 'left', anchor: { name: 'left' }, connectionPoint: { name: 'anchor' } } }); tank1Pipe2.addTo(graph)
  const tank2Pipe1 = new Pipe({ source: { id: tank2.id, selector: 'bottom', anchor: { name: 'bottom' }, connectionPoint: { name: 'anchor' } }, target: { id: handValve1.id, port: 'right', anchor: { name: 'right', args: { rotate: true } }, connectionPoint: { name: 'anchor' } } }); tank2Pipe1.addTo(graph)
  const ctrlValve1Pipe1 = new Pipe({ source: { id: controlValve1.id, port: 'right', anchor: { name: 'right' } }, target: { id: pump1.id, port: 'left', anchor: { name: 'left' } } }); ctrlValve1Pipe1.addTo(graph)
  const valve2Pipe1 = new Pipe({ source: { id: handValve2.id, port: 'right', anchor: { name: 'right', args: { rotate: true } }, connectionPoint: { name: 'anchor' } }, target: { id: join1.id, anchor: { name: 'top' }, connectionPoint: { name: 'anchor' } } }); valve2Pipe1.addTo(graph)
  const valve1Pipe1 = new Pipe({ source: { id: handValve1.id, port: 'left', anchor: { name: 'left', args: { rotate: true } }, connectionPoint: { name: 'anchor' } }, target: { id: join2.id, anchor: { name: 'top' }, connectionPoint: { name: 'anchor' } } }); valve1Pipe1.addTo(graph)
  const pump1Pipe1 = new Pipe({ source: { id: pump1.id, port: 'right', anchor: { name: 'right', args: { rotate: true } }, connectionPoint: { name: 'anchor' } }, target: { id: handValve2.id, port: 'left', anchor: { name: 'left', args: { rotate: true } }, connectionPoint: { name: 'anchor' } } }); pump1Pipe1.addTo(graph)
  const valve3Pipe1 = new Pipe({ source: { id: handValve3.id, port: 'right', anchor: { name: 'right', args: { rotate: true } }, connectionPoint: { name: 'anchor' } }, target: { id: join1.id, anchor: { name: 'left' }, connectionPoint: { name: 'anchor' } } }); valve3Pipe1.addTo(graph)
  const pump2Pipe1 = new Pipe({ source: { id: pump2.id, port: 'right', anchor: { name: 'right', args: { rotate: true } }, connectionPoint: { name: 'anchor' } }, target: { id: handValve3.id, port: 'left', anchor: { name: 'left', args: { rotate: true } }, connectionPoint: { name: 'anchor' } } }); pump2Pipe1.addTo(graph)
  const ctrlValve2Pipe1 = new Pipe({ source: { id: controlValve2.id, port: 'right', anchor: { name: 'right' } }, target: { id: pump2.id, port: 'left', anchor: { name: 'left', args: { rotate: true } }, connectionPoint: { name: 'anchor' } } }); ctrlValve2Pipe1.addTo(graph)
  const zone1Pipe1 = new Pipe({ source: { id: zone1.id, port: 'left', anchor: { name: 'left', args: { rotate: true, dx: 10 } }, connectionPoint: { name: 'anchor' } }, target: { id: tank1.id, anchor: { name: 'bottomLeft', args: { dy: -30 } }, connectionPoint: { name: 'anchor' } } }); zone1Pipe1.addTo(graph)
  const join1Pipe1 = new Pipe({ source: { id: join1.id, anchor: { name: 'bottom' }, connectionPoint: { name: 'anchor' } }, target: { id: join2.id, anchor: { name: 'left' }, connectionPoint: { name: 'anchor' } } }); join1Pipe1.addTo(graph)
  const join2Pipe1 = new Pipe({ source: { id: join2.id, anchor: { name: 'right' }, connectionPoint: { name: 'anchor' } }, target: { id: zone2.id, anchor: { name: 'left', args: { dx: 10 } }, connectionPoint: { name: 'anchor' } } }); join2Pipe1.addTo(graph)

  paper.transformToFitContent({ useModelGeometry: true, padding: { top: 80, bottom: 80, horizontal: 50 }, horizontalAlign: 'middle', verticalAlign: 'top' })
  paper.unfreeze()

  addControls(paper)

  tank1.level = config.startLevel

  // Wire up state change callback
  if (onStateChange) {
    const getState = (): PIDState => ({
      pump1Power: pump1.power,
      pump2Power: pump2.power,
      controlValve1Open: (controlValve1.get('open') as number) ?? 1,
      controlValve2Open: (controlValve2.get('open') as number) ?? 0.25,
      handValve1Open: Boolean(handValve1.get('open')),
      handValve2Open: Boolean(handValve2.get('open')),
      handValve3Open: Boolean(handValve3.get('open')),
      tankLevel: tank1.level,
    })

    let lastStateKey = ''
    const fireChange = () => {
      const state = getState()
      const key = JSON.stringify(state)
      if (key !== lastStateKey) {
        lastStateKey = key
        onStateChange(state)
      }
    }

    graph.on('change', fireChange)
    fireChange()
  }

  // Simulation tick
  const intervalId = window.setInterval(() => {
    const tank1Level = tank1.level
    const liquidIn = g.random(0, 15)

    tank1Pipe1.set('flow', tank1Level > 70 ? 1 : 0)
    tank1Pipe2.set('flow', tank1Level > 0 ? 1 : 0)

    const cv1Open = controlValve1.get('open') as number
    ctrlValve1Pipe1.set('flow', (tank1Level > 70 ? 1 : 0) * cv1Open)
    const cv2Open = controlValve2.get('open') as number
    ctrlValve2Pipe1.set('flow', (tank1Level > 0 ? 1 : 0) * cv2Open)

    pump1Pipe1.set('flow', (ctrlValve1Pipe1.get('flow') as number) * (1 + 2 * pump1.power))
    pump2Pipe1.set('flow', (ctrlValve2Pipe1.get('flow') as number) * (1 + 2 * pump2.power))

    valve2Pipe1.set('flow', (pump1Pipe1.get('flow') as number) * Number(handValve2.get('open')))
    valve3Pipe1.set('flow', (pump2Pipe1.get('flow') as number) * Number(handValve3.get('open')))

    join1Pipe1.set('flow', (valve2Pipe1.get('flow') as number) + (valve3Pipe1.get('flow') as number))
    tank2Pipe1.set('flow', 0.5)
    valve1Pipe1.set('flow', 0.5 * Number(handValve1.get('open')))
    join2Pipe1.set('flow', (join1Pipe1.get('flow') as number) + (valve1Pipe1.get('flow') as number))

    tank1.level = tank1Level + liquidIn - (join2Pipe1.get('flow') as number) * 4
  }, 1000)

  return () => {
    clearInterval(intervalId)
    paper.remove()
  }
}
