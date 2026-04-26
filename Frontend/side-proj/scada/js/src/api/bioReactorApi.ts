const API_BASE = (import.meta.env.VITE_API_BASE as string) || 'http://localhost:5000';

// ── Legacy types ─────────────────────────────────────────────────────────────
export interface SimulationResponse {
  success: boolean;
  summary: Record<string, any>;
  current_readings: Record<string, any>;
  history: Record<string, any[]>;
  metadata: any;
}

// ── Playback types ───────────────────────────────────────────────────────────
export interface RunCreatedResponse {
  success: boolean;
  run_id: string;
  run_days: number;
  n_reactors: number;
  reactor_ids: string[];
  summary: Record<string, { final_titer_g_per_L: number; peak_VCD: number; strategy: string; run_day: number }>;
  agent_log_total: number;
  created_at: string;
}

export interface ReactorSnapshot {
  reactor_id: string;
  day: number;
  VCD: number;
  viability: number;
  glucose: number;
  lactate: number;
  glutamine: number;
  ammonia: number;
  pH: number;
  DO: number;
  temperature: number;
  agitation: number;
  osmolality: number;
  pCO2: number;
  mAb_titer: number;
  status: 'nominal' | 'warning' | 'critical';
  anomalies: Array<{ parameter: string; value: number; limit: string; type: string; severity: string }>;
  feed_events: string[];
  timestamp: string;
  strategy: string;
}

export interface SnapshotResponse {
  success: boolean;
  run_id: string;
  day: number;
  snapshots: Record<string, ReactorSnapshot>;
}

export interface TimeseriesResponse {
  success: boolean;
  run_id: string;
  up_to_day: number;
  timeseries: Record<string, ReactorSnapshot[]>;
}

export interface AgentLogEvent {
  id: string;
  reactorId: string;
  day: number;
  action: string;
  reasoning: string;
  severity: 'info' | 'warning' | 'critical';
  parameters?: Record<string, number>;
}

export interface AgentLogResponse {
  success: boolean;
  run_id: string;
  up_to_day: number;
  events: AgentLogEvent[];
}

// ── Playback API (current) ───────────────────────────────────────────────────
export async function createRun(params: {
  n_reactors?: number;
  run_days?: number;
  temp_shift?: boolean;
  seed?: number;
} = {}): Promise<RunCreatedResponse> {
  const response = await fetch(`${API_BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Run creation failed: ${response.status}`);
  }

  return response.json();
}

export async function getSnapshot(runId: string, day: number): Promise<SnapshotResponse> {
  const response = await fetch(`${API_BASE}/api/run/${runId}/snapshot?day=${day}`);
  if (!response.ok) throw new Error(`Snapshot fetch failed: ${response.status}`);
  return response.json();
}

export async function getTimeseries(runId: string, upToDay: number): Promise<TimeseriesResponse> {
  const response = await fetch(`${API_BASE}/api/run/${runId}/timeseries?up_to_day=${upToDay}`);
  if (!response.ok) throw new Error(`Timeseries fetch failed: ${response.status}`);
  return response.json();
}

export async function getAgentLog(runId: string, upToDay: number): Promise<AgentLogResponse> {
  const response = await fetch(`${API_BASE}/api/run/${runId}/agent_log?up_to_day=${upToDay}`);
  if (!response.ok) throw new Error(`Agent log fetch failed: ${response.status}`);
  return response.json();
}

export async function listRuns() {
  const response = await fetch(`${API_BASE}/api/runs`);
  if (!response.ok) throw new Error('Failed to list runs');
  return response.json();
}

// ── Legacy API (kept for backward compat with existing callers) ──────────────
export async function runSimulation(
  params: { n_reactors?: number; run_days?: number; temp_shift?: boolean; seed?: number } = {},
): Promise<SimulationResponse> {
  const response = await fetch(`${API_BASE}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Simulation request failed: ${response.status}`);
  }

  return response.json();
}

export async function getCurrentReadings() {
  const response = await fetch(`${API_BASE}/api/readings`);
  if (!response.ok) throw new Error('Failed to fetch current readings');
  return response.json();
}

export async function stepReactor(reactorId: string) {
  const response = await fetch(`${API_BASE}/api/step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reactor_id: reactorId }),
  });
  if (!response.ok) throw new Error('Failed to step reactor');
  return response.json();
}
