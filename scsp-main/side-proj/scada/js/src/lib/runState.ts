/**
 * runState.ts — shared simulation run state.
 *
 * Both useReactorData and useAgentActions need to point at the same backend
 * run_id and the same current simulated day. This module is the source of
 * truth, with a simple subscribe/notify pattern.
 */

type RunState = {
  runId: string | null
  day: number       // current simulated day (0..runDays)
  runDays: number   // total run duration
}

let state: RunState = { runId: null, day: 0, runDays: 14 }
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((fn) => fn())
}

export function getRunState(): RunState {
  return state
}

export function setRun(runId: string, runDays: number) {
  state = { runId, day: 0, runDays }
  notify()
}

export function setDay(day: number) {
  if (day === state.day) return
  state = { ...state, day }
  notify()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
