# Drizzle adapter — k6 performance suite

Load tests for the `@ptc-org/nestjs-query-drizzle` adapter, driven through the GraphQL API of the
`examples/drizzle` application. The point is **regression detection**, not benchmarking: absolute latency depends
entirely on the machine, so only relative change between runs is meaningful.

## Running

Requires [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) on the PATH and the Postgres container from
`examples/docker-compose.yml`:

```sh
yarn docker up -d postgres
yarn perf:drizzle
```

The harness (`main.ts`) boots the Nest app on a free port, rebuilds and seeds the schema, runs k6 against it, then
shuts down and exits with k6's exit code — so a crossed threshold fails the command.

Tunable via environment variables:

| Variable     | Default | Meaning                                               |
| ------------ | ------- | ----------------------------------------------------- |
| `TODO_ITEMS` | `5000`  | Seeded todo items (each gets 3 sub tasks and ~3 tags) |
| `VUS`        | `5`     | Virtual users per scenario                            |
| `DURATION`   | `10s`   | Duration per scenario                                 |

```sh
TODO_ITEMS=500 DURATION=5s VUS=3 yarn perf:drizzle   # quick smoke run
```

### N+1 relation regression

The focused comparison models the relation N+1 problem through `DrizzleQueryService` itself:

```sh
yarn perf:drizzle:n-plus-one

# Change the number of parents in each relation batch (2-100):
RELATION_PARENTS=50 VUS=5 DURATION=10s yarn perf:drizzle:n-plus-one

# The default compares countRelations; row loading can be checked separately:
RELATION_OPERATION=rows yarn perf:drizzle:n-plus-one
```

For every iteration k6 counts the same parent rows' three `subTasks` in two ways:

| Path                    | SQL shape                             | Meaning                                                                     |
| ----------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| `relationCountBatch`    | `1 parent query + 1 relation query`   | Current loader; one `IN (...)` query grouped by the relation's parent key   |
| `relationCountNPlusOne` | `1 parent query + N relation queries` | Deliberately regressed control; calls `countRelations` once for each parent |

Both paths run behind one HTTP request, use the same service methods and return the same counts. This avoids making
the control artificially worse with N extra HTTP round trips or GraphQL parsing. Request order alternates on every
iteration to reduce cache-order bias. Set `RELATION_OPERATION=rows` to run the same comparison for
`queryRelations` and its lateral join.

The useful output metrics are:

- `relation_batch_ms` and `relation_n_plus_one_ms` — end-to-end latency distributions;
- `relation_n_plus_one_slowdown` — per-iteration N+1 latency divided by batched latency;
- `relation_sql_queries{mode:...}` — actual SQL statement counts measured per request by an instrumented
  `node-postgres` Pool and isolated between concurrent VUs with `AsyncLocalStorage`.

The checks also assert the structural invariant: for the default `RELATION_PARENTS=25`, the batched response must
report 2 SQL statements and the control must report 26. `relation_n_plus_one_slowdown` must remain above `1` on
average. Compare p50/p95 and request throughput between commits; the ratio is more portable than a fixed
millisecond threshold.

One local baseline on an Apple M-series laptop with PostgreSQL 18.4 in Docker, `RELATION_PARENTS=25`, `VUS=5` and
`DURATION=10s`:

| Path        | SQL queries/request |  average |     p95 |
| ----------- | ------------------: | -------: | ------: |
| Batched     |                   2 | 0.961 ms | 1.30 ms |
| N+1 control |                  26 |  7.54 ms | 9.11 ms |

The run completed 5,797 paired iterations with no failed checks or requests. N+1 was 8.06x slower on average (the
p95 of the per-iteration slowdown was 10.10x). Treat these numbers as a shape to compare, not a portable latency
budget: hardware, PostgreSQL settings and concurrent local workloads will move the absolute values.

## Scenarios

| Scenario                | What it exercises                                                        |
| ----------------------- | ------------------------------------------------------------------------ |
| `flat_query`            | filter + sort + cursor paging on a single table                          |
| `relation_lateral`      | has-many relations — the `LEFT JOIN LATERAL` path with per-parent paging |
| `relation_many_to_many` | many-to-many resolved through the junction table                         |
| `aggregate`             | `count`/`avg`/`max` with `groupBy`                                       |
| `mutation`              | create + delete; each iteration only touches the row it created          |

## Two things that make the numbers mean something

**Foreign keys are indexed.** `seed.ts` creates indexes on `sub_task.todo_item_id`, `todo_item_tags.tag_id` and
`todo_item.priority`. Without them the relation scenarios degrade into a sequential scan per parent, and the suite
would be measuring a missing index rather than the adapter's relation-loading strategy. (`todo_item_tags`'
composite primary key already covers `(todo_item_id, tag_id)`; only the reverse direction needs its own index.)

**Seeding bypasses the adapter.** Data is inserted with raw SQL and `generate_series`, never through
`createMany` — otherwise a slow adapter would show up as slow setup instead of as slow requests.

## Baselines

Recorded on an Apple M-series laptop, Postgres 14 in Docker, `TODO_ITEMS=5000`, `VUS=5`, `DURATION=10s`,
0 failed requests. The range is across three runs on a machine that was not otherwise idle — run-to-run variance
of ~50% on p95 is normal here, which is why a single number would be misleading:

| Scenario                | p95 (3 runs) | threshold | headroom vs worst |
| ----------------------- | ------------ | --------- | ----------------- |
| `aggregate`             | 47–65 ms     | 120 ms    | ~1.9x             |
| `mutation`              | 69–98 ms     | 180 ms    | ~1.8x             |
| `flat_query`            | 77–114 ms    | 200 ms    | ~1.8x             |
| `relation_lateral`      | 107–159 ms   | 280 ms    | ~1.8x             |
| `relation_many_to_many` | 107–165 ms   | 280 ms    | ~1.7x             |

**Re-measure before trusting these on different hardware** — the absolute values are not portable, and on a
noticeably slower machine the thresholds will need raising. What is portable is the shape: relation scenarios cost
roughly 1.5x a flat query, and nothing should be an order of magnitude off.

## Guards against a silently-green run

Two failure modes that make load suites lie, both explicitly defended against here:

- **A GraphQL error returns HTTP 200.** Every request asserts that `data` is present and `errors` is absent, and
  `checks: ['rate == 1.0']` fails the run if any assertion misses. Checking status alone would report excellent
  latency for a query failing on every request.
- **A threshold over an empty metric passes.** `http_reqs: ['count > 0']` fails a run where no traffic reached the
  server at all — which is exactly what happened during development when the harness blocked its own event loop.

## Not covered

No cross-adapter comparison. Benchmarking this against `examples/typeorm` would be the interesting question, but
that app has a different schema, an auth guard and extra audit columns, so the comparison would not be
apples-to-apples without a purpose-built pair of applications.
