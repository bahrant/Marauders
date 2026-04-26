import { useState, useEffect, useRef } from 'react'
import type { AgentAction } from '../types'
import { getAgentLog, type AgentLogEvent } from '../api/bioReactorApi'
import { getRunState, subscribe } from '../lib/runState'
import { generateAgentActions } from '../api/mockData' // fallback only

interface UseAgentActionsReturn {
  actions: AgentAction[]
  isLoading: boolean
  error: Error | null
}

const RUN_DAYS = 14

function eventToAction(e: AgentLogEvent): AgentAction {
  // Synthesize a timestamp so the activity feed's "X ago" rendering looks
  // sensible. Each sim day maps to a real day ending now.
  const dayMs = 24 * 60 * 60 * 1000
  const now = Date.now()
  return {
    id: e.id,
    timestamp: new Date(now - (RUN_DAYS - e.day) * dayMs),
    reactorId: e.reactorId,
    action: e.action,
    reasoning: e.reasoning,
    severity: e.severity,
    parameters: e.parameters,
  }
}

export function useAgentActions(): UseAgentActionsReturn {
  const [actions, setActions] = useState<AgentAction[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const fellBackToMockRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    async function fetchLog() {
      const { runId, day } = getRunState()
      if (!runId) return // run not yet created by useReactorData
      try {
        const data = await getAgentLog(runId, day)
        if (cancelled) return
        if (data.success) {
          // Newest first to match AgentActivityFeed expectation
          const mapped = data.events
            .map(eventToAction)
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          setActions(mapped)
          setError(null)
          fellBackToMockRef.current = false
        }
      } catch (e) {
        if (cancelled) return
        const err = e instanceof Error ? e : new Error('Failed to fetch agent log')
        setError(err)
        // Fallback: if we've never received a real log, populate with mock
        // so the activity feed isn't empty during demo offline mode.
        if (!fellBackToMockRef.current) {
          try {
            setActions(generateAgentActions(20))
            fellBackToMockRef.current = true
          } catch {
            // ignore
          }
        }
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    // Initial fetch (likely no-op until run is created)
    fetchLog()

    // Re-fetch every time runState changes (which happens each playback tick)
    const unsub = subscribe(fetchLog)

    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  return { actions, isLoading, error }
}
