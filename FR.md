1. Functional Requirements
User Story for FR1:
As a process engineer, I want semantic and topological validation in the Lab Setup page so that I cannot create physically impossible or unbalanced plant designs (pumps feeding against each other, missing recirculation, dead legs, no CIP paths, etc.) and receive automatic material-balance checks and HAZOP-style analysis.

Detailed Requirements (FR1):

The system shall run topological validation on every connection change, on save, and before simulation start.
It shall detect and visually highlight:
Pumps/valves in opposing flow configurations.
Tanks without balanced inlets/outlets.
Dead-legs exceeding a configurable threshold.
Missing recirculation or CIP/SIP paths.
Automatic material-balance verification shall run and flag discrepancies > 5% with a report panel.
A configurable rule engine shall drive all connectivity and balance rules.
A HAZOP Assistant mode shall suggest standard deviations for selected equipment and allow recording of engineer responses.
Validation results shall appear in a dedicated side panel with severity, explanation, and suggested fixes.
Validation can be disabled for free sketching but must be re-enabled for simulation or export.


FR2 – Physics-Based Simulation Engine

The simulation shall solve dynamic mass and energy balances using numerical integration (e.g., Euler or Runge-Kutta) instead of random noise.
The simulation shall incorporate basic kinetic models (Monod growth, oxygen transfer rate kLa, substrate consumption) for bioreactors and fermenters.
The simulation shall respect equipment parameters (hold-up volume, residence time, heat transfer area, impeller power number) supplied by the user or looked up from an equipment database.
The simulation shall support recycle streams, phase changes (e.g., evaporation in utilities), and configurable time steps with pause/step/accelerate controls.
Tank and pipe objects shall expose configurable attributes (headspace, sparging rate, impeller speed, U-value) that directly influence the simulation.
FR3 – Expanded Equipment Library

The palette shall include at minimum: Stirred-Tank Bioreactor (with agitation/aeration/sparging controls), Fermenter, Centrifuge, Chromatography Column, UF/DF Skid, Lyophilizer, WFI Generator, Clean-Steam Generator, Chilled-Water Unit, Transfer Panel, and Redundant Instrument Loop.
Each equipment type shall have a domain-specific property panel (e.g., bioreactor: working volume, max volume, kLa vs. agitation curve, DO setpoint).
Equipment shall support "scale-specific" parameters (pilot vs. lab vs. production) with automatic unit conversion and warning when parameters fall outside typical pilot ranges (50–500 L).

FR4 – Hierarchical & Multi-Scale Modeling

The canvas shall support nested diagrams: top-level view shows skids and utility systems; double-clicking a skid opens a detailed sub-diagram.
CIP/SIP circuits and upstream/downstream integration shall be modeled as explicit connections with flow direction and cleaning validation flags.
Zones shall be promoted from visual labels to logical containers that can enforce classification rules (e.g., ISO 5 vs. ISO 8) and aggregate metrics (total volume, power consumption).

FR5 – Export & Interoperability

The system shall export the current diagram as:
ISA S5.1-compliant P&ID PDF/SVG with tag numbering.
JSON model suitable for import into Aspen Plus, SuperPro Designer, or Pyomo.
ISA-88 recipe skeleton (unit procedures, operations, phases) based on equipment and connections.
The export shall include all configured parameters, simulation equations, and validation results as metadata.
One-click "Generate Simulation Script" shall produce a Python stub (using SciPy.integrate.odeint or similar) pre-populated with the current balances and kinetics.
FR6 – Integration with Existing Application

Changes in the Lab Setup diagram shall be able to drive or be driven by the SCADA P&ID view, ReactorGrid, and backend simulation API.
Agent actions (from useAgentActions) shall be able to suggest or auto-apply corrections for detected validation issues.
2. Non-Functional Requirements
NFR1 – Performance

Diagram with up to 50 equipment items and 100 connections shall render and simulate at ≥ 10 Hz on standard developer hardware.
Validation and balance checks shall complete in < 500 ms.
NFR2 – Usability & Learnability

The interface shall remain intuitive for process engineers; new validation/simulation features shall be opt-in with clear toggle and explanatory overlays.
Property panels shall use domain terminology and include tooltips with typical pilot-plant values.
NFR3 – Extensibility

Equipment library and validation rules shall be data-driven (JSON/config files) so new unit operations or rules can be added without code changes.
Simulation engine shall support pluggable solvers (simple balance → full kinetic model → FMU import).
NFR4 – Reliability & Traceability

All validation warnings, balance calculations, and simulation results shall be logged with timestamps and user-editable notes for audit/GMP purposes.
Undo/redo stack shall capture both visual and parametric changes.
NFR5 – Technology & Maintainability

All new code shall be written in TypeScript and integrate cleanly with existing JointJS+ custom shapes and React hooks.
Simulation logic shall be separable from the UI so it can be moved to a Web Worker or backend service in the future.
The solution shall not increase the current bundle size by more than 15% (excluding optional heavy libraries like numeric solvers).
