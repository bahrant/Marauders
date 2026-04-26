import { useEffect, useRef, useCallback } from 'react'
import { dia } from '@joint/plus'
import type { Facility, Reactor } from '../../types'
import {
  namespace,
  createZone,
  createBioreactor,
  updateBioreactorStatus,
  BioreactorNode,
} from './shapes'

interface FacilityMapProps {
  facility: Facility
  reactors: Reactor[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onViewPID?: (id: string) => void
}

export function FacilityMap({ facility, reactors, selectedId, onSelect, onViewPID }: FacilityMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<dia.Paper | null>(null)
  const graphRef = useRef<dia.Graph | null>(null)
  const reactorShapesRef = useRef<Map<string, BioreactorNode>>(new Map())

  const initializePaper = useCallback(() => {
    if (!containerRef.current || paperRef.current) return

    const graph = new dia.Graph({}, { cellNamespace: namespace })
    graphRef.current = graph

    const paper = new dia.Paper({
      el: containerRef.current,
      model: graph,
      width: '100%',
      height: '100%',
      gridSize: 10,
      async: true,
      frozen: true,
      sorting: dia.Paper.sorting.APPROX,
      background: { color: '#0f172a' },
      cellViewNamespace: namespace,
      interactive: false,
    })

    paperRef.current = paper

    paper.on('element:pointerclick', (elementView) => {
      const reactorId = elementView.model.get('reactorId')
      if (reactorId) {
        onSelect(selectedId === reactorId ? null : reactorId)
      }
    })

    paper.on('element:pointerdblclick', (elementView) => {
      const reactorId = elementView.model.get('reactorId')
      if (reactorId && onViewPID) {
        onViewPID(reactorId)
      }
    })

    facility.zones.forEach(zone => {
      const shape = createZone(zone)
      graph.addCell(shape)
    })

    reactors.forEach(reactor => {
      const shape = createBioreactor(reactor)
      graph.addCell(shape)
      reactorShapesRef.current.set(reactor.id, shape)
    })

    paper.unfreeze()
    paper.transformToFitContent({
      padding: 20,
      useModelGeometry: true,
    })
  }, [facility, reactors, onSelect, selectedId])

  useEffect(() => {
    initializePaper()

    return () => {
      paperRef.current?.remove()
      paperRef.current = null
      graphRef.current = null
      reactorShapesRef.current.clear()
    }
  }, [])

  useEffect(() => {
    reactors.forEach(reactor => {
      const shape = reactorShapesRef.current.get(reactor.id)
      if (shape) {
        updateBioreactorStatus(shape, reactor.status)
      }
    })
  }, [reactors])

  useEffect(() => {
    reactorShapesRef.current.forEach((shape, id) => {
      const isSelected = id === selectedId
      shape.attr('body/strokeWidth', isSelected ? 3 : 2)
      shape.attr('statusRing/strokeWidth', isSelected ? 4 : 3)
    })
  }, [selectedId])

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Facility Map</h2>
            <p className="text-xs text-slate-500">Double-click reactor for P&ID view</p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <Legend color="#22c55e" label="Normal" />
            <Legend color="#eab308" label="Warning" />
            <Legend color="#ef4444" label="Critical" />
          </div>
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1">
      <span
        className="w-3 h-3 rounded-full border-2"
        style={{ borderColor: color }}
      />
      <span className="text-slate-400">{label}</span>
    </div>
  )
}
