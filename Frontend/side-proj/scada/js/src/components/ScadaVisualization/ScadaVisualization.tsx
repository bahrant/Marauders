import { useEffect, useRef, useCallback } from 'react'
import { initScada, type PIDState } from './scada-init'
import type { Reactor } from '../../types'

interface ScadaVisualizationProps {
  reactorId: string
  reactor?: Reactor
  onStateChange?: (state: PIDState) => void
}

export function ScadaVisualization({ reactorId, reactor, onStateChange }: ScadaVisualizationProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange

  const stableCallback = useCallback((state: PIDState) => {
    onStateChangeRef.current?.(state)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    if (cleanupRef.current) {
      cleanupRef.current()
      cleanupRef.current = null
    }

    cleanupRef.current = initScada(
      containerRef.current,
      reactorId,
      onStateChange ? stableCallback : undefined
    )

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current()
        cleanupRef.current = null
      }
    }
  }, [reactorId, stableCallback, onStateChange])

  const statusColors = {
    PASS: 'text-green-400',
    WARN: 'text-yellow-400',
    CRITICAL: 'text-red-400',
  }

  return (
    <div className="bg-slate-800/50 rounded-lg border border-slate-700 h-full flex flex-col">
      <div className="p-3 border-b border-slate-700 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-white">
            {reactor?.name || reactorId} - P&ID
          </h2>
          {reactor && (
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${statusColors[reactor.status]} bg-slate-700`}>
              {reactor.status}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          {reactor && (
            <>
              <span>pH: {reactor.metrics.pH.toFixed(2)}</span>
              <span>DO: {reactor.metrics.dissolvedOxygen.toFixed(1)}%</span>
              <span>Temp: {reactor.metrics.temperature.toFixed(1)}°C</span>
            </>
          )}
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Live
          </span>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 rounded-b-lg overflow-hidden"
        style={{ minHeight: '500px' }}
      />
    </div>
  )
}
