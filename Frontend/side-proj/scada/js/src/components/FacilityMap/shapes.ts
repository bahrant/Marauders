import { dia, shapes, util } from '@joint/plus'
import type { Zone, Reactor, ReactorStatus } from '../../types'
import { REACTOR_COLORS } from '../../types'

const STATUS_COLORS: Record<ReactorStatus, string> = {
  PASS: '#22c55e',
  WARN: '#eab308',
  CRITICAL: '#ef4444',
}

export class ZoneShape extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'facility.Zone',
      size: { width: 400, height: 130 },
      attrs: {
        body: {
          width: 'calc(w)',
          height: 'calc(h)',
          fill: '#1e293b',
          stroke: '#475569',
          strokeWidth: 2,
          rx: 8,
          ry: 8,
        },
        label: {
          x: 12,
          y: 20,
          fill: '#94a3b8',
          fontSize: 12,
          fontWeight: 'bold',
          fontFamily: 'system-ui, sans-serif',
          textAnchor: 'start',
          textVerticalAnchor: 'middle',
        },
        classification: {
          x: 'calc(w - 12)',
          y: 20,
          fill: '#64748b',
          fontSize: 10,
          fontFamily: 'system-ui, sans-serif',
          textAnchor: 'end',
          textVerticalAnchor: 'middle',
        },
      },
    }
  }

  preinitialize(): void {
    this.markup = util.svg/* xml */ `
      <rect @selector="body" />
      <text @selector="label" />
      <text @selector="classification" />
    `
  }
}

export class BioreactorNode extends dia.Element {
  defaults() {
    return {
      ...super.defaults,
      type: 'facility.Bioreactor',
      size: { width: 60, height: 70 },
      attrs: {
        body: {
          cx: 30,
          cy: 25,
          r: 22,
          fill: '#334155',
          stroke: '#64748b',
          strokeWidth: 2,
        },
        statusRing: {
          cx: 30,
          cy: 25,
          r: 26,
          fill: 'none',
          stroke: '#22c55e',
          strokeWidth: 3,
        },
        icon: {
          x: 18,
          y: 13,
          width: 24,
          height: 24,
          href: 'data:image/svg+xml;base64,' + btoa(`
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e2e8f0" stroke-width="2">
              <path d="M9 3h6v2a6 6 0 0 1 6 6v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a6 6 0 0 1 6-6V3z"/>
              <path d="M9 3h6v2H9z"/>
              <circle cx="12" cy="14" r="2"/>
            </svg>
          `),
        },
        label: {
          x: 30,
          y: 60,
          fill: '#e2e8f0',
          fontSize: 10,
          fontWeight: 'bold',
          fontFamily: 'system-ui, sans-serif',
          textAnchor: 'middle',
          textVerticalAnchor: 'middle',
        },
      },
    }
  }

  preinitialize(): void {
    this.markup = util.svg/* xml */ `
      <circle @selector="statusRing" />
      <circle @selector="body" />
      <image @selector="icon" />
      <text @selector="label" />
    `
  }
}

export function createZone(zone: Zone): ZoneShape {
  const shape = new ZoneShape()
  shape.position(zone.bounds.x, zone.bounds.y)
  shape.size(zone.bounds.width, zone.bounds.height)
  shape.attr({
    label: { text: zone.name },
    classification: { text: zone.classification },
  })
  shape.set('zoneId', zone.id)
  return shape
}

export function createBioreactor(reactor: Reactor): BioreactorNode {
  const shape = new BioreactorNode()
  shape.position(reactor.position.x - 30, reactor.position.y - 35)
  shape.attr({
    label: { text: reactor.id },
    statusRing: { stroke: STATUS_COLORS[reactor.status] },
    body: { stroke: REACTOR_COLORS[reactor.id] || '#64748b' },
  })
  shape.set('reactorId', reactor.id)
  shape.set('status', reactor.status)
  return shape
}

export function updateBioreactorStatus(shape: BioreactorNode, status: ReactorStatus): void {
  shape.attr('statusRing/stroke', STATUS_COLORS[status])
  shape.set('status', status)
}

export const namespace = {
  ...shapes,
  facility: {
    Zone: ZoneShape,
    Bioreactor: BioreactorNode,
  },
}
