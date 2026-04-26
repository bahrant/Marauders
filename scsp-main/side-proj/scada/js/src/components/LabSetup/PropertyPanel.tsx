import { useState, useEffect } from 'react'
import type { EquipmentProperties, HazopDeviation } from '../../types'
import { EQUIPMENT_CATALOG, checkPilotRangeWarnings, type PropertyFieldSchema } from '../../lib/equipment/equipmentConfig'
import { generateHazopDeviations } from '../../lib/validation/topologyValidator'

interface PropertyPanelProps {
  elementId: string
  elementType: string
  elementName: string
  properties: EquipmentProperties
  onApply: (id: string, props: EquipmentProperties) => void
  onClose: () => void
}

const RISK_COLOR = {
  low: 'text-green-400 bg-green-900/30',
  medium: 'text-yellow-400 bg-yellow-900/30',
  high: 'text-orange-400 bg-orange-900/30',
  critical: 'text-red-400 bg-red-900/30',
}

function NumberField({ schema, value, onChange }: { schema: PropertyFieldSchema; value: number | undefined; onChange: (v: number) => void }) {
  const [local, setLocal] = useState(String(value ?? ''))
  const inPilotRange = schema.pilotRange
    ? (value !== undefined && value >= schema.pilotRange[0] && value <= schema.pilotRange[1])
    : true

  useEffect(() => { setLocal(String(value ?? '')) }, [value])

  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <label className="text-xs text-slate-400">{schema.label}</label>
        {schema.pilotRange && value !== undefined && !inPilotRange && (
          <span className="text-xs text-yellow-400">⚠ out of pilot range</span>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          className="w-full bg-slate-700 border border-slate-600 text-white text-xs px-2 py-1 rounded focus:border-blue-500 outline-none font-mono"
          value={local}
          min={schema.min}
          max={schema.max}
          onChange={e => { setLocal(e.target.value); const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(n) }}
          onBlur={() => setLocal(String(value ?? ''))}
        />
        {schema.unit && <span className="text-xs text-slate-500 shrink-0">{schema.unit}</span>}
      </div>
      {schema.pilotRange && (
        <p className="text-slate-600 text-xs mt-0.5">Pilot range: {schema.pilotRange[0]}–{schema.pilotRange[1]} {schema.unit}</p>
      )}
    </div>
  )
}

function BoolField({ schema, value, onChange }: { schema: PropertyFieldSchema; value: boolean | undefined; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={value ?? false}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 accent-blue-500 cursor-pointer"
      />
      <span className="text-xs text-slate-300">{schema.label}</span>
    </label>
  )
}

function SelectField({ schema, value, onChange }: { schema: PropertyFieldSchema; value: string | undefined; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-slate-400 block mb-0.5">{schema.label}</label>
      <select
        value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-slate-700 border border-slate-600 text-white text-xs px-2 py-1 rounded focus:border-blue-500 outline-none"
      >
        {(schema.options ?? []).map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  )
}

export function PropertyPanel({ elementId, elementType, elementName, properties, onApply, onClose }: PropertyPanelProps) {
  const [props, setProps] = useState<EquipmentProperties>({ ...properties })
  const [activeTab, setActiveTab] = useState<'properties' | 'hazop'>('properties')
  const [hazopItems, setHazopItems] = useState<HazopDeviation[]>(() =>
    generateHazopDeviations(elementType, elementId)
  )

  const config = EQUIPMENT_CATALOG[elementType]
  const warnings = checkPilotRangeWarnings(elementType, props)

  const setField = <K extends keyof EquipmentProperties>(key: K, value: EquipmentProperties[K]) => {
    setProps(p => ({ ...p, [key]: value }))
  }

  const updateHazopResponse = (id: string, response: string) => {
    setHazopItems(prev => prev.map(d => d.id === id ? { ...d, engineerResponse: response } : d))
  }

  if (!config) {
    return (
      <div className="w-64 bg-slate-900 border border-slate-600 rounded-lg shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <p className="text-sm font-semibold text-white">{elementName}</p>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
        </div>
        <div className="px-4 py-3">
          <p className="text-xs text-slate-400">No configurable properties for this element type.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-72 bg-slate-900 border border-slate-600 rounded-lg shadow-2xl flex flex-col max-h-[70vh]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 shrink-0">
        <div>
          <p className="text-sm font-semibold text-white">{elementName}</p>
          <p className="text-xs text-slate-400">{config.label}</p>
        </div>
        <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">&times;</button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-700 shrink-0">
        {(['properties', 'hazop'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab
                ? 'bg-slate-800 text-white border-b-2 border-blue-500'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab === 'properties' ? 'Properties' : `HAZOP (${hazopItems.length})`}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'properties' && (
          <div className="px-4 py-3 space-y-3">
            {warnings.length > 0 && (
              <div className="bg-yellow-900/30 border border-yellow-700/50 rounded p-2">
                {warnings.map((w, i) => (
                  <p key={i} className="text-yellow-300 text-xs">{w.message}</p>
                ))}
              </div>
            )}

            {config.propertySchema.map(schema => {
              const val = props[schema.key]
              if (schema.type === 'boolean') {
                return (
                  <BoolField
                    key={schema.key}
                    schema={schema}
                    value={val as boolean | undefined}
                    onChange={v => setField(schema.key, v)}
                  />
                )
              }
              if (schema.type === 'select') {
                return (
                  <SelectField
                    key={schema.key}
                    schema={schema}
                    value={val as string | undefined}
                    onChange={v => setField(schema.key, v as EquipmentProperties[typeof schema.key])}
                  />
                )
              }
              return (
                <NumberField
                  key={schema.key}
                  schema={schema}
                  value={val as number | undefined}
                  onChange={v => setField(schema.key, v)}
                />
              )
            })}
          </div>
        )}

        {activeTab === 'hazop' && (
          <div className="p-3 space-y-3">
            <p className="text-xs text-slate-500">
              Standard HAZOP deviations for {config.label}. Record engineering responses.
            </p>
            {hazopItems.map(dev => (
              <div key={dev.id} className="bg-slate-800 rounded border border-slate-700 p-2.5 space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-white text-xs font-bold uppercase">{dev.guideword}</span>
                  <span className="text-slate-400 text-xs">{dev.parameter}</span>
                  <span className={`ml-auto text-xs rounded px-1.5 py-0.5 ${RISK_COLOR[dev.riskLevel]}`}>
                    {dev.riskLevel}
                  </span>
                </div>
                <p className="text-xs text-slate-500"><span className="text-slate-400">Cause:</span> {dev.cause}</p>
                <p className="text-xs text-slate-500"><span className="text-slate-400">Consequence:</span> {dev.consequence}</p>
                <div>
                  <label className="text-xs text-slate-500 block mb-0.5">Engineer response / safeguards:</label>
                  <textarea
                    className="w-full bg-slate-700 border border-slate-600 text-white text-xs px-2 py-1 rounded focus:border-blue-500 outline-none resize-none"
                    rows={2}
                    placeholder="Enter safeguards, actions, or notes..."
                    value={dev.engineerResponse}
                    onChange={e => updateHazopResponse(dev.id, e.target.value)}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Apply button */}
      {activeTab === 'properties' && (
        <div className="px-4 py-3 border-t border-slate-700 shrink-0">
          <button
            onClick={() => { onApply(elementId, props); onClose() }}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm py-1.5 rounded font-medium transition-colors"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  )
}
