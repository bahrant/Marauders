import type { EquipmentProperties, EquipmentScale } from '../../types'

export interface PropertyFieldSchema {
  key: keyof EquipmentProperties
  label: string
  unit: string
  min?: number
  max?: number
  pilotRange?: [number, number]
  type?: 'number' | 'select' | 'boolean'
  options?: string[]
}

export interface EquipmentTypeConfig {
  label: string
  dot: string                        // Tailwind bg class
  defaultProperties: EquipmentProperties
  propertySchema: PropertyFieldSchema[]
  hasSim: boolean                   // participates in physics simulation
}

export const EQUIPMENT_CATALOG: Record<string, EquipmentTypeConfig> = {
  Bioreactor: {
    label: 'STR Bioreactor',
    dot: 'bg-emerald-500',
    hasSim: true,
    defaultProperties: {
      workingVolume: 100,
      maxVolume: 150,
      kLa: 200,
      doSetpoint: 40,
      impellerSpeed: 200,
      spargeRate: 1.0,
      headspace: 15,
      scale: 'pilot',
      cipPath: false,
      sipPath: false,
    },
    propertySchema: [
      { key: 'workingVolume', label: 'Working Volume', unit: 'L', min: 0.1, max: 50000, pilotRange: [50, 500] },
      { key: 'maxVolume', label: 'Max Volume', unit: 'L', min: 0.1, max: 60000 },
      { key: 'kLa', label: 'kLa (O₂ transfer)', unit: 'h⁻¹', min: 0, max: 1000, pilotRange: [100, 400] },
      { key: 'doSetpoint', label: 'DO Setpoint', unit: '%', min: 0, max: 100, pilotRange: [20, 60] },
      { key: 'impellerSpeed', label: 'Impeller Speed', unit: 'RPM', min: 0, max: 1000, pilotRange: [100, 400] },
      { key: 'spargeRate', label: 'Sparge Rate', unit: 'L/min', min: 0, max: 50, pilotRange: [0.5, 5] },
      { key: 'headspace', label: 'Headspace', unit: 'L', min: 0, max: 500 },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
      { key: 'cipPath', label: 'CIP Path', unit: '', type: 'boolean' },
      { key: 'sipPath', label: 'SIP Path', unit: '', type: 'boolean' },
    ],
  },

  Fermenter: {
    label: 'Fermenter',
    dot: 'bg-lime-500',
    hasSim: true,
    defaultProperties: {
      workingVolume: 200,
      maxVolume: 300,
      kLa: 150,
      doSetpoint: 30,
      impellerSpeed: 150,
      spargeRate: 2.0,
      scale: 'pilot',
      cipPath: false,
    },
    propertySchema: [
      { key: 'workingVolume', label: 'Working Volume', unit: 'L', pilotRange: [50, 500] },
      { key: 'maxVolume', label: 'Max Volume', unit: 'L' },
      { key: 'kLa', label: 'kLa', unit: 'h⁻¹', pilotRange: [80, 300] },
      { key: 'doSetpoint', label: 'DO Setpoint', unit: '%', pilotRange: [10, 50] },
      { key: 'impellerSpeed', label: 'Agitator Speed', unit: 'RPM', pilotRange: [80, 300] },
      { key: 'spargeRate', label: 'Aeration Rate', unit: 'L/min', pilotRange: [1, 10] },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
      { key: 'cipPath', label: 'CIP Path', unit: '', type: 'boolean' },
    ],
  },

  Centrifuge: {
    label: 'Centrifuge',
    dot: 'bg-rose-500',
    hasSim: false,
    defaultProperties: { residenceTime: 0.1, scale: 'pilot' },
    propertySchema: [
      { key: 'residenceTime', label: 'Residence Time', unit: 'h', min: 0.01, max: 2 },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
    ],
  },

  ChromatographyColumn: {
    label: 'Chrom. Column',
    dot: 'bg-violet-500',
    hasSim: false,
    defaultProperties: {
      workingVolume: 5,
      residenceTime: 0.5,
      scale: 'pilot',
      cipPath: false,
    },
    propertySchema: [
      { key: 'workingVolume', label: 'Column Volume (CV)', unit: 'L', pilotRange: [1, 50] },
      { key: 'residenceTime', label: 'Residence Time', unit: 'CV', min: 0.1, max: 10 },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
      { key: 'cipPath', label: 'CIP Path', unit: '', type: 'boolean' },
    ],
  },

  UfDfSkid: {
    label: 'UF/DF Skid',
    dot: 'bg-sky-500',
    hasSim: false,
    defaultProperties: {
      heatTransferArea: 5,
      residenceTime: 1,
      scale: 'pilot',
    },
    propertySchema: [
      { key: 'heatTransferArea', label: 'Membrane Area', unit: 'm²', pilotRange: [1, 20] },
      { key: 'residenceTime', label: 'Processing Time', unit: 'h', min: 0.5, max: 10 },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
    ],
  },

  Lyophilizer: {
    label: 'Lyophilizer',
    dot: 'bg-indigo-400',
    hasSim: false,
    defaultProperties: { scale: 'pilot', cipPath: false },
    propertySchema: [
      { key: 'workingVolume', label: 'Chamber Volume', unit: 'L', pilotRange: [50, 500] },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
    ],
  },

  WfiGenerator: {
    label: 'WFI Generator',
    dot: 'bg-teal-400',
    hasSim: false,
    defaultProperties: { workingVolume: 500, scale: 'production', cipPath: true },
    propertySchema: [
      { key: 'workingVolume', label: 'Storage Volume', unit: 'L' },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
    ],
  },

  CleanSteamGenerator: {
    label: 'Clean Steam Gen.',
    dot: 'bg-orange-300',
    hasSim: false,
    defaultProperties: { heatTransferArea: 2, scale: 'pilot', sipPath: true },
    propertySchema: [
      { key: 'heatTransferArea', label: 'Heat Transfer Area', unit: 'm²' },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
      { key: 'sipPath', label: 'SIP Supply', unit: '', type: 'boolean' },
    ],
  },

  ChilledWaterUnit: {
    label: 'Chilled Water',
    dot: 'bg-cyan-300',
    hasSim: false,
    defaultProperties: { heatTransferArea: 10, uValue: 500, scale: 'pilot' },
    propertySchema: [
      { key: 'heatTransferArea', label: 'HX Area', unit: 'm²' },
      { key: 'uValue', label: 'U-value', unit: 'W/(m²·K)' },
      { key: 'scale', label: 'Scale', unit: '', type: 'select', options: ['lab', 'pilot', 'production'] },
    ],
  },

  TransferPanel: {
    label: 'Transfer Panel',
    dot: 'bg-slate-300',
    hasSim: false,
    defaultProperties: { cipPath: true },
    propertySchema: [
      { key: 'cipPath', label: 'CIP Supply Point', unit: '', type: 'boolean' },
      { key: 'sipPath', label: 'SIP Supply Point', unit: '', type: 'boolean' },
    ],
  },

  InstrumentLoop: {
    label: 'Instrument Loop',
    dot: 'bg-yellow-300',
    hasSim: false,
    defaultProperties: {},
    propertySchema: [],
  },
}

// Warning thresholds for pilot-scale parameters
export const PILOT_RANGE_WARNINGS: Partial<Record<keyof EquipmentProperties, { min: number; max: number; unit: string }>> = {
  workingVolume: { min: 50, max: 500, unit: 'L' },
  impellerSpeed: { min: 50, max: 500, unit: 'RPM' },
  kLa: { min: 50, max: 600, unit: 'h⁻¹' },
  spargeRate: { min: 0.1, max: 20, unit: 'L/min' },
}

export function checkPilotRangeWarnings(
  type: string,
  props: EquipmentProperties,
): Array<{ field: string; value: number; message: string }> {
  const warnings: Array<{ field: string; value: number; message: string }> = []
  const config = EQUIPMENT_CATALOG[type]
  if (!config) return warnings

  for (const schema of config.propertySchema) {
    if (schema.pilotRange && props[schema.key] !== undefined) {
      const value = props[schema.key] as number
      const [lo, hi] = schema.pilotRange
      if (value < lo || value > hi) {
        warnings.push({
          field: schema.label,
          value,
          message: `${schema.label} (${value} ${schema.unit}) is outside the typical pilot range ${lo}–${hi} ${schema.unit}.`,
        })
      }
    }
  }
  return warnings
}

export function getDefaultProperties(type: string): EquipmentProperties {
  return { ...(EQUIPMENT_CATALOG[type]?.defaultProperties ?? {}) }
}

export const ZONE_CLASSIFICATIONS: Array<{ value: string; label: string; color: string }> = [
  { value: 'ISO 5', label: 'ISO 5 (Class 100)', color: '#22c55e' },
  { value: 'ISO 7', label: 'ISO 7 (Class 10,000)', color: '#3b82f6' },
  { value: 'ISO 8', label: 'ISO 8 (Class 100,000)', color: '#f59e0b' },
  { value: 'CNC', label: 'Controlled Non-Classified', color: '#6b7280' },
]

export function scaleMultiplier(from: EquipmentScale, to: EquipmentScale): number {
  const factors: Record<EquipmentScale, number> = { lab: 1, pilot: 10, production: 100 }
  return factors[to] / factors[from]
}
