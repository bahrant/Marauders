# Changes Required to Integrate BioReactor Simulator API

**Compatibility Score: 7.5/10**

The SCADA React + joint.js application (`side-proj/scada/js/`) is well-structured for integration. The new Flask API (`http://localhost:5000/api/simulate`) produces data that is semantically very close to the current mock structures. The main work is replacing the mock generators with real fetch calls and adding a lightweight adapter layer for field name differences and status mapping.

## Field Mapping Table

| Simulator Field (our API) | SCADA Type Field | Notes / Transformation |
|---------------------------|------------------|------------------------|
| VCD                       | viableCellDensity | Direct (×10⁶ cells/mL) |
| mAb_titer                 | antibodyTiter    | Multiply by 1000 (g/L → mg/L) |
| pH, DO, temperature       | pH, dissolvedOxygen, temperature | Direct |
| status ("nominal")        | status ("PASS")  | nominal→PASS, warning→WARN, critical→CRITICAL |
| anomalies                 | (new)            | Add to Reactor type for alert display |
| strategy, glucose, lactate| (new)            | Nice-to-have for richer cards |
| history                   | timeSeries       | Map daily snapshots to DataPoint[] |

## Files to Create / Modify

### 1. New File: `side-proj/scada/js/src/api/bioReactorApi.ts` (create)

```ts
const API_BASE = 'http://localhost:5000';

export interface SimulationResponse {
  success: boolean;
  summary: Record<string, any>;
  current_readings: Record<string, any>;
  history: Record<string, any[]>;
  metadata: any;
}

export async function runSimulation(params: { n_reactors?: number; run_days?: number; temp_shift?: boolean } = {}): Promise<SimulationResponse> {
  const response = await fetch(`${API_BASE}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) throw new Error('Simulation failed');
  return response.json();
}

export async function getCurrentReadings() {
  const res = await fetch(`${API_BASE}/api/readings`);
  return res.json();
}
```

### 2. Update `side-proj/scada/js/src/hooks/useReactorData.ts`

Replace the entire file content with a version that uses the new API and adapter:

```ts
import { useState, useEffect, useCallback } from 'react';
import type { Reactor, ReactorTimeSeries, Facility } from '../types';
import { runSimulation, getCurrentReadings } from '../api/bioReactorApi';
import { generateFacility } from './mockData'; // keep facility for now

function adaptReactorData(apiReading: any): Reactor {
  const statusMap: Record<string, 'PASS' | 'WARN' | 'CRITICAL'> = {
    nominal: 'PASS',
    warning: 'WARN',
    critical: 'CRITICAL',
  };

  return {
    id: apiReading.reactor_id,
    name: `Bioreactor ${apiReading.reactor_id.replace('R', '')}`,
    status: statusMap[apiReading.status] || 'PASS',
    metrics: {
      pH: apiReading.pH,
      dissolvedOxygen: apiReading.DO,
      temperature: apiReading.temperature,
      viableCellDensity: apiReading.VCD,
      antibodyTiter: apiReading.mAb_titer * 1000, // g/L to mg/L
    },
    position: { x: 0, y: 0 }, // joint.js will position
    zone: 'cleanroom-a',
    // Add extra fields if you extend the type
    anomalies: apiReading.anomalies || [],
    strategy: apiReading.strategy,
  };
}

export function useReactorData() {
  const [reactors, setReactors] = useState<Reactor[]>([]);
  const [timeSeries, setTimeSeries] = useState<ReactorTimeSeries[]>([]);
  const [facility, setFacility] = useState<Facility>({ dimensions: { width: 500, height: 400 }, zones: [] });
  const [dayOfRun, setDayOfRun] = useState(7);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const loadData = useCallback(async () => {
    try {
      setIsLoading(true);
      const sim = await runSimulation({ n_reactors: 4, run_days: 14, temp_shift: true });
      
      const adaptedReactors = Object.values(sim.current_readings).map(adaptReactorData);
      setReactors(adaptedReactors);
      setDayOfRun(Math.floor(Object.values(sim.current_readings)[0]?.day || 7));

      // Convert history to timeSeries format (simplified)
      const ts: ReactorTimeSeries[] = Object.entries(sim.history).map(([id, entries]) => ({
        reactorId: id,
        data: entries.map((e: any) => ({
          timestamp: new Date(e.timestamp || Date.now()),
          pH: e.pH,
          dissolvedOxygen: e.DO,
          temperature: e.temperature,
          viableCellDensity: e.VCD,
        })),
      }));
      setTimeSeries(ts);
      setFacility(generateFacility());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Failed to load bioreactor data'));
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 8000); // poll every 8s
    return () => clearInterval(interval);
  }, [loadData]);

  return { reactors, timeSeries, facility, dayOfRun, isLoading, error, refresh: loadData };
}
```

### 3. Minor Updates to Other Files

- **types/index.ts**: Extend `Reactor` interface to include optional `anomalies?: any[]` and `strategy?: string`.
- **ReactorCard.tsx**: Add small anomaly badge if `reactor.anomalies?.length > 0`.
- **App.tsx**: Pass `refresh` from hook to a manual refresh button if desired.
- **mockData.ts**: Can be kept for fallback or removed after full switch.

### 4. Run Instructions

1. Start the Python API: `cd /Users/bahran/Desktop/bioReactorSim && python3 app.py`
2. In SCADA dir: `cd /Users/bahran/Desktop/scsp/side-proj/scada/js && npm run dev`
3. The dashboard will now pull live simulated data from the kinetic model instead of static mocks.

These changes make the SCADA UI a true frontend for the autonomous BioReactorAgent system. The joint.js diagrams can be updated later to subscribe to the real probe streams.

**Estimated effort**: 2–3 focused coding sessions. The adapter pattern keeps the rest of the UI untouched. 

**Next**: After these changes are applied, the full closed-loop agent (monitoring → decision → actuation via `/api/step`) can be implemented.