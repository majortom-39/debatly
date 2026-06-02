// =============================================================================
// shared/trace.mjs  —  A debate run's "flight recorder".
// =============================================================================
//
// A trace is a simple notebook of what each node did, in order. Nodes append
// steps to it; nothing breaks if a node forgets. We use it for debugging the
// live pipeline without digging through giant log files.
// =============================================================================

export function createTrace(label = "live") {
  return {
    label,
    startedAt: Date.now(),
    steps: []
  };
}

export function logStep(trace, step, payload = {}) {
  if (!trace || !Array.isArray(trace.steps)) return;
  trace.steps.push({ step, ...payload, timestamp: Date.now() });
}
