import { readFileSync } from 'fs'

export interface ScenarioResult {
  p95: number
  avg: number
  requests: number
}

export interface AdapterResult {
  adapter: string
  seedMs: number
  totalRequests: number
  failedChecks: number
  scenarios: Record<string, ScenarioResult>
}

interface TrendMetric {
  'p(95)': number
  avg: number
  count?: number
}

interface K6Summary {
  metrics: Record<string, Partial<TrendMetric> & { count?: number; fails?: number; passes?: number }>
}

const SCENARIO_METRIC = /^http_req_duration\{scenario:(.+)\}$/

/**
 * Reads a `k6 --summary-export` file.
 *
 * Per-scenario entries only exist because the k6 script declares a threshold for each of them: k6 materialises a
 * tagged sub-metric only when something references it.
 */
export const readK6Summary = (file: string, adapter: string, seedMs = 0): AdapterResult => {
  const summary = JSON.parse(readFileSync(file, 'utf8')) as K6Summary
  const scenarios: Record<string, ScenarioResult> = {}

  for (const [key, metric] of Object.entries(summary.metrics)) {
    const match = SCENARIO_METRIC.exec(key)

    if (match) {
      scenarios[match[1]] = { p95: metric['p(95)'] ?? 0, avg: metric.avg ?? 0, requests: metric.count ?? 0 }
    }
  }

  return {
    adapter,
    seedMs,
    totalRequests: summary.metrics.http_reqs?.count ?? 0,
    failedChecks: summary.metrics.checks?.fails ?? 0,
    scenarios
  }
}
