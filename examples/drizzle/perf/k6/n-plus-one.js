import { check } from 'k6'
import http from 'k6/http'
import { Counter, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const VUS = Number(__ENV.VUS || 5)
const DURATION = __ENV.DURATION || '10s'
const TODO_ITEMS = Number(__ENV.TODO_ITEMS || 5000)
const RELATION_PARENTS = Number(__ENV.RELATION_PARENTS || 25)
const RELATION_OPERATION = __ENV.RELATION_OPERATION === 'rows' ? 'rows' : 'count'

if (!Number.isInteger(RELATION_PARENTS) || RELATION_PARENTS < 2 || RELATION_PARENTS > 100) {
  throw new Error('RELATION_PARENTS must be an integer between 2 and 100')
}
if (!Number.isInteger(TODO_ITEMS) || TODO_ITEMS < RELATION_PARENTS) {
  throw new Error('TODO_ITEMS must be an integer greater than or equal to RELATION_PARENTS')
}

const batchDuration = new Trend('relation_batch_ms', true)
const nPlusOneDuration = new Trend('relation_n_plus_one_ms', true)
const slowdown = new Trend('relation_n_plus_one_slowdown')
const sqlQueries = new Counter('relation_sql_queries')

export const options = {
  scenarios: {
    relation_n_plus_one_comparison: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      exec: 'compareRelationLoading',
      gracefulStop: '5s'
    }
  },
  thresholds: {
    http_reqs: ['count > 0'],
    checks: ['rate == 1.0'],
    http_req_failed: ['rate < 0.01'],
    // The control should be slower on average. This relative assertion is portable across development machines.
    relation_n_plus_one_slowdown: ['avg > 1'],
    'relation_sql_queries{mode:batch}': ['count > 0'],
    'relation_sql_queries{mode:n-plus-one}': ['count > 0']
  }
}

function request(mode, startId) {
  const operationName = RELATION_OPERATION === 'count' ? 'Count' : 'Rows'
  const name = mode === 'batch' ? `relation${operationName}Batch` : `relation${operationName}NPlusOne`
  const response = http.get(
    `${BASE_URL}/perf/relations/${mode}?operation=${RELATION_OPERATION}&parents=${RELATION_PARENTS}&startId=${startId}`,
    { tags: { name } }
  )

  let body
  try {
    body = response.json()
  } catch (e) {
    body = null
  }

  const expectedQueries = mode === 'batch' ? 2 : RELATION_PARENTS + 1
  check(response, {
    [`${name} returned 200`]: (r) => r.status === 200,
    [`${name} returned every parent and relation`]: () =>
      body &&
      body.operation === RELATION_OPERATION &&
      body.parents === RELATION_PARENTS &&
      body.relatedRows === RELATION_PARENTS * 3,
    [`${name} used the expected SQL query shape`]: () => body && body.sqlQueries === expectedQueries
  })

  // `sqlQueries` is measured by request-scoped Pool instrumentation in the Node harness, not inferred here.
  sqlQueries.add(body?.sqlQueries || 0, { mode })

  return response.timings.duration
}

export function compareRelationLoading() {
  const maxStart = Math.max(1, TODO_ITEMS - RELATION_PARENTS + 1)
  const startId = 1 + Math.floor(Math.random() * maxStart)
  let batchMs
  let nPlusOneMs

  // Alternate order to avoid consistently giving either path the warmer cache.
  if ((__VU + __ITER) % 2 === 0) {
    batchMs = request('batch', startId)
    nPlusOneMs = request('n-plus-one', startId)
  } else {
    nPlusOneMs = request('n-plus-one', startId)
    batchMs = request('batch', startId)
  }

  batchDuration.add(batchMs)
  nPlusOneDuration.add(nPlusOneMs)
  slowdown.add(nPlusOneMs / Math.max(batchMs, 0.001))
}
