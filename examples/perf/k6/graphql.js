import { check } from 'k6'
import http from 'k6/http'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const VUS = Number(__ENV.VUS || 5)
const DURATION = __ENV.DURATION || '10s'
const WARMUP = __ENV.WARMUP || '10s'

/**
 * Scenarios deliberately avoid filtering on `id`: it is an integer in the SQL adapters and an ObjectId string in
 * the document ones, so an id-based filter would not be portable. Randomisation goes through `priority` instead,
 * which every adapter stores identically.
 *
 * Thresholds beyond the correctness ones are intentionally absent: this script produces a *comparison*, where the
 * interesting output is the relative p95 between adapters, not a pass/fail gate.
 */
/**
 * Scenarios run strictly one after another, never concurrently.
 *
 * The application under test is a single Node process with one event loop. Run in parallel, a CPU-heavy scenario
 * inflates the latency of every other scenario, and the reported numbers stop being about the query each scenario
 * issues. This was not visible on a small dataset and became the dominant effect on a large one.
 */
const MEASURED = [
  ['flat_query', 'flatQuery'],
  ['flat_query_total_count', 'flatQueryTotalCount'],
  ['relation_has_many', 'relationHasMany'],
  ['relation_many_to_many', 'relationManyToMany'],
  ['aggregate', 'aggregate'],
  ['mutation', 'mutation']
]

const DURATION_UNIT_MS = {
  ns: 1e-6,
  us: 1e-3,
  'µs': 1e-3,
  'μs': 1e-3,
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000
}

/** Parses the same simple and compound duration units accepted by k6, such as `500ms`, `1m`, or `1m30s`. */
const milliseconds = (value) => {
  const duration = String(value)
  const segment = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g
  let total = 0
  let consumed = 0
  let match = segment.exec(duration)

  while (match) {
    if (match.index !== consumed) {
      throw new Error(`Invalid k6 duration: ${duration}`)
    }

    total += Number(match[1]) * DURATION_UNIT_MS[match[2]]
    consumed = segment.lastIndex
    match = segment.exec(duration)
  }

  if (!consumed || consumed !== duration.length) {
    throw new Error(`Invalid k6 duration: ${duration}`)
  }

  return total
}

export const options = {
  scenarios: {
    // Runs first and alone. Right after a bulk load the buffer pool / working set is cold, and without this the
    // measured p95 would partly be "time spent filling caches" -- charged to whichever scenario happened to touch
    // a given page first. Its metrics land in the `warmup` bucket and are excluded from the reported table.
    warmup: { executor: 'constant-vus', vus: VUS, duration: WARMUP, exec: 'warmup', gracefulStop: '2s' },
    ...Object.fromEntries(MEASURED.map(([name, exec], index) => [name, measured(exec, index)]))
  },
  thresholds: {
    // A threshold over an empty metric passes, so this guards against a run that measured nothing at all.
    http_reqs: ['count > 0'],
    // A GraphQL error still returns HTTP 200, so correctness is asserted on the body, not the status code.
    checks: ['rate == 1.0'],
    // k6 only materialises a tagged sub-metric when a threshold references it, and `--summary-export` can only
    // export what exists. These bounds are deliberately absurd: their job is to create the per-scenario metrics
    // the comparison table reads, not to gate anything.
    'http_req_duration{scenario:flat_query}': ['p(95) < 600000'],
    'http_req_duration{scenario:flat_query_total_count}': ['p(95) < 600000'],
    'http_req_duration{scenario:relation_has_many}': ['p(95) < 600000'],
    'http_req_duration{scenario:relation_many_to_many}': ['p(95) < 600000'],
    'http_req_duration{scenario:aggregate}': ['p(95) < 600000'],
    'http_req_duration{scenario:mutation}': ['p(95) < 600000']
  }
}

/** Each measured scenario starts after the warm-up plus every scenario queued ahead of it. */
function measured(exec, index) {
  return {
    executor: 'constant-vus',
    vus: VUS,
    duration: DURATION,
    exec,
    startTime: `${milliseconds(WARMUP) + index * milliseconds(DURATION)}ms`,
    gracefulStop: '2s'
  }
}

function gql(query, name) {
  const res = http.post(BASE_URL + '/graphql', JSON.stringify({ query }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name }
  })

  check(res, {
    [name + ' returned 200']: (r) => r.status === 200,
    [name + ' returned data without errors']: (r) => {
      try {
        const body = r.json()
        return body && body.data != null && body.errors == null
      } catch (e) {
        return false
      }
    }
  })

  return res
}

/** Priorities are seeded as `n % 10`, so this spreads load across the dataset without touching ids. */
function randomPriority() {
  return Math.floor(Math.random() * 10)
}

function flatQueryBody(withTotalCount) {
  return `{
    todoItems(
      filter: { completed: { is: false }, priority: { gte: ${randomPriority()} } }
      sorting: [{ field: priority, direction: DESC }]
      paging: { first: 25 }
    ) { ${withTotalCount ? 'totalCount' : ''} edges { node { id title priority completed } } }
  }`
}

/** Page of 25 rows, no count. */
export function flatQuery() {
  gql(flatQueryBody(false), 'flatQuery')
}

/**
 * The same page plus `totalCount`. Split out on purpose: at large row counts the COUNT dominates and is roughly
 * equal across the SQL adapters, so folding it into `flat_query` would compress exactly the differences this
 * benchmark exists to show. The gap between these two rows is the cost of the count.
 */
export function flatQueryTotalCount() {
  gql(flatQueryBody(true), 'flatQueryTotalCount')
}

export function relationHasMany() {
  gql(
    `{
      todoItems(paging: { first: 25 }, filter: { priority: { gte: ${randomPriority()} } }) {
        edges { node { id title subTasks(paging: { first: 5 }) { totalCount edges { node { id title completed } } } } }
      }
    }`,
    'relationHasMany'
  )
}

export function relationManyToMany() {
  gql(
    `{
      todoItems(paging: { first: 25 }, filter: { priority: { gte: ${randomPriority()} } }) {
        edges { node { id tags(paging: { first: 5 }) { totalCount edges { node { id name } } } } }
      }
    }`,
    'relationManyToMany'
  )
}

export function aggregate() {
  gql(
    `{
      todoItemAggregate(filter: { completed: { is: false } }) {
        groupBy { completed }
        count { id }
        avg { priority }
        max { priority }
      }
    }`,
    'aggregate'
  )
}

export function mutation() {
  const created = gql(
    `mutation { createOneTodoItem(input: { todoItem: { title: "perf-${__VU}-${__ITER}", completed: false, priority: 5 } }) { id } }`,
    'mutationCreate'
  )

  let id
  try {
    id = created.json().data.createOneTodoItem.id
  } catch (e) {
    return
  }

  // Quoted so the same mutation works for both integer and ObjectId primary keys.
  gql(`mutation { deleteOneTodoItem(input: { id: "${id}" }) { id } }`, 'mutationDelete')
}

/** Touches every measured code path so no scenario pays for a cold cache on someone else's behalf. */
export function warmup() {
  flatQuery()
  flatQueryTotalCount()
  relationHasMany()
  relationManyToMany()
  aggregate()
}
