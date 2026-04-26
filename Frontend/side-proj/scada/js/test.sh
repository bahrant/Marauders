#!/bin/bash
# Regression test runner for BioReactor SCADA app
# Runs vitest in CI mode, logs errors, and exits with appropriate code

set -e

echo "=== BioReactor SCADA Regression Test Suite ==="
echo "Running tests with Vitest (CI mode)..."

# Ensure we're in the js directory
cd "$(dirname "$0")"

# Run tests and capture output
LOG_FILE="test-errors.log"
echo "Test run started at $(date)" > "$LOG_FILE"

if npm run test:run -- --reporter=verbose 2>&1 | tee -a "$LOG_FILE"; then
  echo "✅ All tests passed successfully!"
  echo "Test completed successfully at $(date)" >> "$LOG_FILE"
  exit 0
else
  echo "❌ Tests failed. See $LOG_FILE for details."
  echo "Test failed at $(date)" >> "$LOG_FILE"
  # Extract only errors for summary
  grep -E "(Error|FAIL|failed|✕)" "$LOG_FILE" > "test-summary.log" || true
  exit 1
fi
