# Cross-adapter benchmark

Runs the **same GraphQL API** against all five nestjs-query persistence adapters and compares latency, so a change
to one adapter can be judged against the others rather than in isolation.

```sh
yarn docker up -d postgres mongo
yarn perf:compare                    # all five adapters
yarn perf:compare drizzle typeorm    # just these two
yarn perf:adapter mongoose           # one adapter, with k6's own live output
```

Requires [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) on the PATH.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TODO_ITEMS` | `100000` | Seeded todo items (each gets 3 sub tasks and ~3 tags) |
| `VUS` | `5` | Virtual users per scenario |
| `DURATION` | `10s` | Duration **per scenario** — scenarios run one after another |
| `WARMUP` | `10s` | Warm-up before any scenario is measured |
| `PERF_RESEED` | – | Set to `1` to force the mongo adapters to rebuild an already-matching dataset |

A full run is `WARMUP + 6 × DURATION` per adapter, so the defaults take roughly six minutes for all five.

## What makes the comparison fair

Everything above the persistence layer is shared, and the things that would otherwise dominate the numbers are
controlled for:

* **One set of DTOs and resolver options.** `src/dto/` defines the GraphQL types and `src/dto/resolvers.ts` the
  resolver configuration; adapters supply only entities and a connection. The runner then **diffs the generated
  SDL** across adapters and reports any difference — if two adapters do not answer the same questions, their
  latencies are not comparable.
* **Identical data.** Same row counts, same deterministic tag distribution, same `priority` values.
* **Index parity.** Every adapter indexes the has-many foreign key, the many-to-many lookup key and the composite
  `completed`/`priority` filter used by read scenarios.
  A missing index moves these numbers far more than any adapter does.
* **Seeding bypasses nestjs-query.** Rows go in through raw SQL / the mongo driver's `bulkWrite`, never through
  `createMany`, so a slow adapter shows up as slow requests rather than slow setup.
* **One adapter per process.** `compare.ts` spawns a child process per adapter; loading five ORMs into one process
  would make the first adapter measured differ from the last for reasons unrelated to the adapters.
* **No id-based filters.** Ids are integers in SQL and ObjectIds in mongo, so scenarios randomise over `priority`
  instead — the same query text runs everywhere.
* **Scenarios run one at a time, never concurrently.** The app under test is a single Node process with one event
  loop; run in parallel, a CPU-heavy scenario inflates every other scenario's latency and the numbers stop being
  about the queries. This mattered enormously — see below.
* **A warm-up phase precedes measurement.** Straight after a bulk load the buffer pool and working set are cold,
  and that cost would otherwise be charged to whichever scenario happened to touch a page first.

## What it still cannot control for

* **Different database engines.** `mongoose`/`typegoose` run on MongoDB, the rest on PostgreSQL. Differences
  between those columns are as much about the engine and its driver as about the adapter. Compare
  drizzle↔typeorm↔sequelize and mongoose↔typegoose *within* their groups for a clean signal.
* **Relation modelling is not equivalent.** SQL adapters resolve many-to-many through a junction table; the
  document adapters store an array of references on the document. That is the idiomatic modelling for each, not a
  handicap, but it is not the same work.
* **One known schema difference.** The document adapters do not expose `avg`/`sum` aggregates over their ObjectId
  primary key, so eight aggregate types present in the SQL schemas are absent there. No benchmarked scenario uses
  them; the runner prints the difference so it stays visible rather than silently assumed away.

## Scenarios

| Scenario | What it exercises |
| --- | --- |
| `flat_query` | filter + sort + cursor paging on one collection/table |
| `relation_has_many` | 25 parents each loading 5 sub tasks |
| `relation_many_to_many` | 25 parents each loading 5 tags |
| `aggregate` | `count`/`avg`/`max` with `groupBy` |
| `mutation` | create + delete, each iteration touching only its own row |

## Correctness guards

A load suite that measures nothing, or measures failing requests, is worse than no suite. Two guards:

* Every request asserts that the response carries `data` and no `errors` — **a GraphQL error returns HTTP 200**, so
  checking the status alone would report excellent latency for a query failing every time.
* `http_reqs: ['count > 0']` fails a run that produced no traffic at all, because a threshold over an empty metric
  otherwise passes.

Per-scenario thresholds exist only to make k6 materialise the tagged sub-metrics the table reads; they are set
absurdly high on purpose and gate nothing. This suite reports, it does not gate — for a pass/fail regression gate
on the drizzle adapter specifically, see `examples/drizzle/perf`.

## Reading the output

`p95` in milliseconds, lower is better. Absolute values are machine specific; what carries over between machines is
the *ratio* between columns and the shape across scenarios.

### Why the dataset is large by default

Apple M-series laptop, Postgres 14 and MongoDB 5 in Docker, `VUS=5`, `DURATION=8s`, `WARMUP=6s`. p95 in ms.

**5 000 todo items:**

| scenario | drizzle | typeorm | sequelize | mongoose | typegoose |
| --- | --- | --- | --- | --- | --- |
| `flat_query` | 7.2 | 3.9 | 4.0 | 18.7 | 7.6 |
| `flat_query_total_count` | 6.1 | 4.5 | 9.1 | 26.3 | 11.2 |
| `relation_has_many` | 30.2 | **10.5** | 49.7 | 61.3 | 62.2 |
| `relation_many_to_many` | 50.7 | **13.5** | 58.0 | 73.4 | 61.9 |
| `aggregate` | 3.0 | 2.7 | 2.3 | 9.0 | 6.5 |
| `mutation` | 3.7 | 13.3 | 3.9 | 3.4 | 2.8 |

**200 000 todo items:**

| scenario | drizzle | typeorm | sequelize | mongoose | typegoose |
| --- | --- | --- | --- | --- | --- |
| `flat_query` | 9.4 | 10.1 | 10.7 | 242.1 | 224.5 |
| `flat_query_total_count` | 19.2 | 22.9 | 22.5 | 429.9 | 423.6 |
| `relation_has_many` | **24.4** | 44.8 | 40.8 | 85.4 | 70.3 |
| `relation_many_to_many` | 26.6 | **11.0** | 46.6 | 56.1 | 72.1 |
| `aggregate` | 25.4 | 25.6 | 28.2 | 245.9 | 250.5 |
| `mutation` | 3.7 | 34.1 | 3.7 | 3.1 | 3.7 |

**The size changes the conclusion, which is why the default is 100 000 and not 5 000.** At 5k the three SQL
adapters are within a few milliseconds of each other on flat queries and typeorm looks clearly fastest on
relations. At 200k the SQL adapters have barely moved on flat queries (4–7 ms → 9–11 ms) while the document
adapters have degraded by more than an order of magnitude (7–19 ms → 224–242 ms), and drizzle has overtaken
typeorm on `relation_has_many`. A benchmark run at 5k would have reported the opposite ranking for the scenario
this whole comparison exists to measure.

### Read these numbers carefully

* **Single runs on a non-idle machine.** Variance of tens of percent is normal, and some cells clearly carry it:
  typeorm's `relation_many_to_many` (11.0) against its `relation_has_many` (44.8) at the same size is not a
  difference the queries justify. Re-run before concluding anything from a single cell.
* **Compare within an engine group.** mongoose/typegoose run on MongoDB, the rest on PostgreSQL.
* **An earlier version of this suite ran all scenarios concurrently and reported `sequelize` and `typegoose` as
  15–20x slower on relations.** That was an artefact: the scenarios were competing for one Node event loop. After
  serialising them the gap mostly disappeared. If you change the scenario schedule, expect the numbers to move for
  reasons that have nothing to do with the adapters.
