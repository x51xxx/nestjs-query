import { check } from 'k6'
import http from 'k6/http'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000'
const VUS = Number(__ENV.VUS || 5)
const DURATION = __ENV.DURATION || '10s'
const TODO_ITEMS = Number(__ENV.TODO_ITEMS || 5000)

/**
 * Thresholds are deliberately generous (roughly 2.5x the baseline recorded in ../README.md). Absolute latency is
 * machine specific; what this suite is for is catching a regression that changes the numbers by an order of
 * magnitude, plus any scenario that starts erroring.
 */
export const options = {
  scenarios: {
    flat_query: scenario('flatQuery'),
    relation_lateral: scenario('relationLateral'),
    relation_many_to_many: scenario('relationManyToMany'),
    aggregate: scenario('aggregate'),
    mutation: scenario('mutation')
  },
  thresholds: {
    // A threshold over an empty metric passes, so an accidentally-silent run (no traffic at all) would report
    // green on every other check. This is the guard against that.
    http_reqs: ['count > 0'],
    // A GraphQL error still returns HTTP 200, so correctness is asserted by the `checks` metric, not by status.
    checks: ['rate == 1.0'],
    http_req_failed: ['rate < 0.01'],
    // Roughly 2.5x the baselines recorded in ../README.md -- tight enough to catch an order-of-magnitude
    // regression, loose enough not to fail on a slower machine.
    'http_req_duration{scenario:flat_query}': ['p(95) < 200'],
    'http_req_duration{scenario:relation_lateral}': ['p(95) < 280'],
    'http_req_duration{scenario:relation_many_to_many}': ['p(95) < 280'],
    'http_req_duration{scenario:aggregate}': ['p(95) < 120'],
    'http_req_duration{scenario:mutation}': ['p(95) < 180']
  }
}

function scenario(exec) {
  return { executor: 'constant-vus', vus: VUS, duration: DURATION, exec, gracefulStop: '5s' }
}

function gql(query, name) {
  const res = http.post(BASE_URL + '/graphql', JSON.stringify({ query }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name }
  })

  // Checking only the status code is the classic way a GraphQL load test reports great latency for a query that
  // is failing on every single request.
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

/** A random id from the seeded range, so scenarios do not all hammer the same row/page. */
function randomId() {
  return 1 + Math.floor(Math.random() * TODO_ITEMS)
}

export function flatQuery() {
  // Paging is cursor based here, so the offset is varied through the filter rather than an `offset` argument
  // (`CursorPaging` only exposes first/last/after/before).
  gql(
    `{
      todoItems(
        filter: { completed: { is: false }, id: { gte: ${randomId()} } }
        sorting: [{ field: priority, direction: DESC }]
        paging: { first: 25 }
      ) { totalCount edges { node { id title priority completed } } }
    }`,
    'flatQuery'
  )
}

/** The distinctive path: relations resolved through a LEFT JOIN LATERAL with per-parent paging. */
export function relationLateral() {
  gql(
    `{
      todoItems(paging: { first: 25 }, filter: { id: { gte: ${randomId()} } }) {
        edges { node { id title subTasks(paging: { first: 5 }) { totalCount edges { node { id title completed } } } } }
      }
    }`,
    'relationLateral'
  )
}

/** Many-to-many resolved through the junction table. */
export function relationManyToMany() {
  gql(
    `{
      todoItems(paging: { first: 25 }, filter: { id: { gte: ${randomId()} } }) {
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

/**
 * The write path. Each iteration creates and then deletes its own row, so it never mutates the rows the read
 * scenarios page over -- otherwise their latency would drift with VU count for reasons unrelated to the adapter.
 */
export function mutation() {
  const created = gql(
    `mutation { createOneTodoItem(input: { todoItem: { title: "perf-${__VU}-${__ITER}", priority: 5 } }) { id } }`,
    'mutationCreate'
  )

  let id
  try {
    id = created.json().data.createOneTodoItem.id
  } catch (e) {
    return
  }

  gql(`mutation { deleteOneTodoItem(input: { id: ${id} }) { id } }`, 'mutationDelete')
}
