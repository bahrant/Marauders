import { useState, useEffect, useCallback, useRef } from 'react'
import type { Reactor, ReactorTimeSeries, DataPoint, Facility, ReactorStatus } from '../types'
import { createRun, getSnapshot, getTimeseries, type ReactorSnapshot } from '../api/bioReactorApi'
import { generateFacility } from '../api/mockData' // keep for facility geometry until LabSetup wires it
import { setRun, setDay as setSharedDay } from '../lib/runState'

interface UseReactorDataReturn {
  reactors: Reactor[]
  timeSeries: ReactorTimeSeries[]
  facility: Facility
  dayOfRun: number
  isLoading: boolean
  error: Error | null
  refresh: () => void
}

const TICK_INTERVAL_MS = 2000          // 2s between ticks
const PLAYBACK_DAYS_PER_TICK = 0.5     // → 14-day run plays in ~56s
const RUN_DAYS = 14
const RUN_SEED = 42

const STATUS_MAP: Record<string, ReactorStatus> = {
  nominal: 'PASS',
  warning: 'WARN',
  critical: 'CRITICAL',
}

// API uses R1..R4 — keep those IDs in the frontend so the agent log,
// validation, and logs all align. The mock data also used BR-001..BR-004
// so we keep both forms and let the components key off `id` either way.
function snapshotToReactor(snap: ReactorSnapshot): Reactor {
  return {
    id: snap.reactor_id,
    name: `Bioreactor ${snap.reactor_id.replace('R', '')}`,
    status: STATUS_MAP[snap.status] ?? 'PASS',
    metrics: {
      pH: snap.pH,
      dissolvedOxygen: snap.DO,
      temperature: snap.temperature,
      viableCellDensity: snap.VCD,
      antibodyTiter: snap.mAb_titer * 1000, // g/L → mg/L for the existing UI
    },
    position: { x: 150, y: 120 }, // FacilityMap layer overrides this
    zone: 'cleanroom-a',
    anomalies: snap.anomalies,
    strategy: snap.strategy,
  }
}

function snapshotsToTimeSeries(byReactor: Record<string, ReactorSnapshot[]>): ReactorTimeSeries[] {
  // Synthesize timestamps so the existing chart components (which expect
  // Date) keep working. Each simulated day → a real day, ending "now".
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  return Object.entries(byReactor).map(([rid, snaps]) => ({
    reactorId: rid,
    data: snaps.map<DataPoint>((s) => ({
      timestamp: new Date(now - (RUN_DAYS - s.day) * dayMs),
      pH: s.pH,
      dissolvedOxygen: s.DO,
      temperature: s.temperature,
      viableCellDensity: s.VCD,
    })),
  }))
}

export function useReactorData(): UseReactorDataReturn {
  const [reactors, setReactors] = useState<Reactor[]>([])
  const [timeSeries, setTimeSeries] = useState<ReactorTimeSeries[]>([])
  const [facility, setFacility] = useState<Facility>({ dimensions: { width: 500, height: 400 }, zones: [] })
  const [dayOfRun, setDayOfRun] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const runIdRef = useRef<string | null>(null)
  const dayRef = useRef(0)

  // Fetch latest state at a given simulated day
  const fetchAtDay = useCallback(async (day: number) => {
    const runId = runIdRef.current
    if (!runId) return
    try {
      const [snapData, tsData] = await Promise.all([
        getSnapshot(runId, day),
        getTimeseries(runId, day),
      ])
      if (snapData.success) {
        const list = Object.values(snapData.snapshots).filter(Boolean).map(snapshotToReactor)
        setReactors(list)
      }
      if (tsData.success) {
        setTimeSeries(snapshotsToTimeSeries(tsData.timeseries))
      }
    } catch (e) {
      // Don't surface transient errors mid-tick
      console.warn('[useReactorData] fetch failed at day', day, e)
    }
  }, [])

  // Initialize a new run
  const initRun = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await createRun({
        n_reactors: 4,
        run_days: RUN_DAYS,
        seed: RUN_SEED,
      })
      runIdRef.current = data.run_id
      setRun(data.run_id, data.run_days)
      dayRef.current = 1
      setDayOfRun(1)
      setSharedDay(1)
      await fetchAtDay(1)
      setFacility(generateFacility())
      setIsLoading(false)
    } catch (e) {
      const err = e instanceof Error
        ? e
        : new Error('Could not reach backend — is api.py running on localhost:5000?')
      setError(err)
      console.error('Run init failed:', err)

      // Fallback to mock data so the UI still has something to render.
      // This matches the existing defensive pattern in the codebase.
      try {
        const { generateReactors, generateTimeSeries } = await import('../api/mockData')
        setReactors(generateReactors(7))
        setTimeSeries(generateTimeSeries(7))
        setDayOfRun(7)
        setFacility(generateFacility())
      } catch (fallbackErr) {
        console.error('Fallback also failed', fallbackErr)
      }
      setIsLoading(false)
    }
  }, [fetchAtDay])

  // Mount: kick off the run
  useEffect(() => {
    initRun()
  }, [initRun])

  // Tick: advance simulated day forward
  useEffect(() => {
    if (isLoading || error || !runIdRef.current) return
    const id = setInterval(() => {
      const next = Math.min(RUN_DAYS, dayRef.current + PLAYBACK_DAYS_PER_TICK)
      if (next === dayRef.current) {
        // Reached end of run — stop ticking
        clearInterval(id)
        return
      }
      dayRef.current = next
      setDayOfRun(next)
      setSharedDay(next)
      fetchAtDay(next)
    }, TICK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [isLoading, error, fetchAtDay])

  return {
    reactors,
    timeSeries,
    facility,
    dayOfRun: Math.floor(dayOfRun),
    isLoading,
    error,
    refresh: initRun,
  }
}
