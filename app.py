from flask import Flask, request, jsonify
from flask_cors import CORS
import json
import random
from datetime import datetime
import traceback
from bioreactor_simulator import CHOBioreactorSimulator

app = Flask(__name__)
CORS(app)  # Enable CORS for localhost frontend

# Global simulator instance for stateful simulation
simulator = None

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "healthy",
        "service": "bio-reactor-simulator-api",
        "version": "1.0.0",
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/simulate', methods=['POST'])
def simulate():
    """Main endpoint for running bioreactor simulation.
    
    Accepts expanded config for joint.js + SCADA workflow (from input.txt fields):
    {
      "runName": "CHO-Run-001",
      "cellLine": "CHO-K1",
      "n_reactors": 4,
      "run_days": 14,
      "targetTiter": 3.0,
      "seedingDensity": 0.5,
      "pH": {"min": 6.8, "max": 7.2},
      "dissolvedOxygen": {"min": 30, "max": 60},
      "temperature": {"min": 36.5, "max": 37.5},
      "glucoseFloor": 0.9,
      "lactateCeiling": 1.8,
      "osmolalityMax": 390,
      "pco2Max": 150,
      "feedMode": "bolus",           // derived from joint.js link style
      "bolusFeedDays": [3, 5, 7, 9],
      "temperatureShift": false,
      "tempShiftDay": 7,
      "postShiftTemperature": 33.0,
      "autonomyLevel": "Full Auto",
      "escalationThreshold": 2,
      "samplingInterval": 30,
      "alertRole": "Scientist",
      "kalmanFilterMode": "Adaptive",
      "faultSensitivity": "Balanced",
      "probeTrustFloor": 0.4,
      "monitorSpike": true,
      "monitorDrift": true,
      "monitorFrozen": true,
      "monitorFouling": true,
      "chartTimeWindow": "Full run",
      "alertSeverityFilter": ["CRITICAL", "WARNING"],
      "seed": 42
    }
    
    Core params drive CHOBioreactorSimulator; others update thresholds/strategies (future Kalman/agent logic).
    Backward-compatible with previous 4-field payload and joint.js frontend.
    
    Returns expected output format with history, summaries, and current readings.
    """
    global simulator
    
    data = request.get_json() or {}
    
    # Expanded inputs with defaults (maps directly to input.txt fields)
    n_reactors = int(data.get('n_reactors', 4))
    run_days = int(data.get('run_days', 14))
    temp_shift = bool(data.get('temperatureShift', data.get('temp_shift', True)))
    seed = data.get('seed')
    
    if seed is not None:
        random.seed(int(seed))
    
    # Additional config from input.txt (for thresholds, strategies, agent/Kalman)
    # These can be passed to simulator in future extensions
    config = {
        'target_titer': float(data.get('targetTiter', 3.0)),
        'seeding_density': float(data.get('seedingDensity', 0.5)),
        'pH': data.get('pH', {'min': 6.8, 'max': 7.2}),
        'dissolved_oxygen': data.get('dissolvedOxygen', {'min': 30, 'max': 60}),
        'temperature_range': data.get('temperature', {'min': 36.5, 'max': 37.5}),
        'glucose_floor': float(data.get('glucoseFloor', 0.9)),
        'lactate_ceiling': float(data.get('lactateCeiling', 1.8)),
        'osmolality_max': int(data.get('osmolalityMax', 390)),
        'pco2_max': int(data.get('pco2Max', 150)),
        'feed_mode': data.get('feedMode', 'bolus'),
        'bolus_feed_days': data.get('bolusFeedDays', [3, 5, 7, 9]),
        'temp_shift_day': int(data.get('tempShiftDay', 7)),
        'post_shift_temp': float(data.get('postShiftTemperature', 33.0)),
        'autonomy_level': data.get('autonomyLevel', 'Full Auto'),
        'escalation_threshold': int(data.get('escalationThreshold', 2)),
        'sampling_interval': int(data.get('samplingInterval', 30)),
        'kalman_mode': data.get('kalmanFilterMode', 'Adaptive'),
        'fault_sensitivity': data.get('faultSensitivity', 'Balanced'),
        'probe_trust_floor': float(data.get('probeTrustFloor', 0.4)),
        'monitor_spike': bool(data.get('monitorSpike', True)),
        # ... (other Kalman/display fields available in data)
    }
    
    # Initialize or reset simulator (dummy version runs full sim on each call)
    try:
        simulator = CHOBioreactorSimulator(
            n_reactors=n_reactors,
            run_days=run_days,
            temp_shift=temp_shift
        )
        # TODO: simulator.apply_config(config)  # for future full integration
        
        # Run the full simulation
        history = simulator.run_full_simulation()
        summary = simulator.get_titer_summary()
        current_readings = simulator.get_current_readings()
    except Exception as e:
        print("ERROR in simulate():", str(e))
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc(),
            "parameters": {
                "n_reactors": n_reactors,
                "run_days": run_days,
                "temp_shift": temp_shift,
                "seed": seed
            }
        }), 500
    
    response = {
        "success": True,
        "simulation_id": f"sim_{datetime.now().strftime('%Y%m%d_%H%M%S')}",
        "parameters": {
            "n_reactors": n_reactors,
            "run_days": run_days,
            "temp_shift": temp_shift,
            "seed": seed
        },
        "summary": summary,
        "current_readings": current_readings,
        "history": history,  # Full time-series data per reactor
        "metadata": {
            "total_steps": run_days * n_reactors,
            "model": "CHO Fed-Batch mAb Production (López-Meza et al. 2016)",
            "timestamp": datetime.now().isoformat()
        }
    }
    
    return jsonify(response)

@app.route('/api/readings', methods=['GET'])
def get_readings():
    """Get current readings without running full simulation (for live monitoring)."""
    global simulator
    if simulator is None:
        try:
            simulator = CHOBioreactorSimulator(n_reactors=4, run_days=14)
            simulator.run_full_simulation()  # Initialize with some data
        except Exception as init_err:
            print("ERROR initializing simulator in get_readings():", str(init_err))
            traceback.print_exc()
            return jsonify({
                "success": False,
                "error": f"Simulator initialization failed: {str(init_err)}"
            }), 500
    
    return jsonify({
        "success": True,
        "current_readings": simulator.get_current_readings(),
        "timestamp": datetime.now().isoformat()
    })

@app.route('/api/step', methods=['POST'])
def step_simulation():
    """Advance simulation by one step (for interactive joint.js workflows)."""
    global simulator
    data = request.get_json() or {}
    reactor_id = data.get('reactor_id', 'R1')
    
    if simulator is None:
        try:
            simulator = CHOBioreactorSimulator(n_reactors=4, run_days=14)
            simulator.run_full_simulation()
        except Exception as init_err:
            print("ERROR initializing simulator in step_simulation():", str(init_err))
            traceback.print_exc()
            return jsonify({
                "success": False,
                "error": f"Simulator initialization failed: {str(init_err)}"
            }), 500
    
    try:
        state = simulator.step(reactor_id)
        snapshot = simulator._snapshot(state)
    except Exception as step_err:
        print("ERROR in step_simulation():", str(step_err))
        traceback.print_exc()
        return jsonify({
            "success": False,
            "error": str(step_err),
            "traceback": traceback.format_exc()
        }), 500
    
    return jsonify({
        "success": True,
        "reactor_id": reactor_id,
        "state": snapshot,
        "timestamp": datetime.now().isoformat()
    })

if __name__ == '__main__':
    print("Starting BioReactor Simulator API on http://localhost:5000")
    print("Endpoints:")
    print("  GET  /api/health")
    print("  POST /api/simulate")
    print("  GET  /api/readings")
    print("  POST /api/step")
    print("\nCORS enabled for localhost frontend.")
    app.run(host='0.0.0.0', port=5000, debug=True)
