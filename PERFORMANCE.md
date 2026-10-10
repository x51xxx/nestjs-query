# Designing schemas and services for performance

*[Українська версія](./PERFORMANCE.uk.md)*

Practical guidance for building on `nestjs-query`, derived from the cross-adapter benchmark in
[`examples/perf`](./examples/perf).

**Every claim here is backed by a measurement taken with that suite**, and the measurement is shown. Where a number
is quoted it came from an Apple M-series laptop running Postgres 14 and MongoDB 5 in Docker, 200 000 `todo_item`
rows with 600 000 sub tasks. Absolute values are machine-specific; the *ratios* and the *shapes* are what transfer.
Where something is a judgement call rather than a measurement, it says so.

---

## 1. Index the columns you filter on — together, and in the right order

This is the single highest-leverage thing in this document, and it is easy to get wrong even when you think you
have indexed correctly.

A GraphQL query like this:

```graphql
todoItems(filter: { completed: { is: false }, priority: { gte: 5 } }, paging: { first: 25 }) {
  totalCount
  edges { node { id title } }
}
```

produces `WHERE completed = false AND priority >= 5`. With an index on `priority` **alone**, Postgres finds the
candidate rows cheaply and then reads the table to check `completed`:

| Index | `COUNT(*)` time | Buffers touched | Plan |
| --- | --- | --- | --- |
| `(priority)` | 17.7 ms | 1 542 | Bitmap Heap Scan — 1 461 heap blocks |
| `(completed, priority)` | 9.9 ms | 1 530 | still Bitmap Heap Scan |
| `(completed, priority)` + `VACUUM` | **5.7 ms** | **69** | **Index Only Scan** |

Three lessons:

**Put the equality column first, the range column second.** `(completed, priority)` works for
`completed = X AND priority >= Y`; `(priority, completed)` does not let the second column be used for the range.
A B-tree can only use columns up to and including the first inequality.

**A bitmap scan always touches the heap.** Adding the composite index alone only halved the time. What removed the
heap access entirely was the query becoming an *index-only scan*.

**Index-only scans need `VACUUM`.** Postgres consults the visibility map to know a row is visible to everyone
without reading it. A freshly bulk-loaded table has an empty visibility map, so index-only scans silently degrade
to heap reads. `ANALYZE` alone is not enough — it updates statistics, not visibility.

> In production, autovacuum handles this. It matters for anything that loads data and immediately measures it:
> benchmarks, integration test fixtures, migration verification. This repo's own benchmark had this bug.

**Also index:** the foreign key on the *child* side of every has-many relation, and both directions of a
many-to-many junction table. A composite primary key on `(a_id, b_id)` covers lookups by `a_id` but **not** by
`b_id` — the reverse direction needs its own index.

---

## 2. `totalCount` is not free, and how expensive depends on your adapter

A cursor connection with `enableTotalCount` issues a second query that counts every matching row. Fetching 25 rows
is O(25); counting is O(matching rows).

Measured at 200 000 rows, before and after the index fix from section 1:

| | `flat_query` | `+ totalCount` | overhead |
| --- | --- | --- | --- |
| **Before** — `(priority)` index | 9.4 ms | 19.2 ms | +9.8 ms |
| **After** — `(completed, priority)` + `VACUUM` | 13.7 ms | 14.6 ms | **+0.9 ms** |

With a covering index the count became almost free for the drizzle adapter. It did **not** become free for the
others, and that difference only became visible once the shared heap-scan cost was removed:

| adapter | `flat_query` | `+ totalCount` | overhead |
| --- | --- | --- | --- |
| drizzle | 13.7 | 14.6 | +0.9 ms |
| typeorm | 14.4 | 34.2 | +19.8 ms |
| sequelize | 13.2 | 40.4 | +27.2 ms |

**Recommendations**

- Make the filterable columns index-covered before assuming `totalCount` is inherently expensive. Most of the cost
  usually is not the count.
- Turn it off where the UI does not show a total: `@QueryOptions({ enableTotalCount: false })`. Infinite scroll and
  "load more" rarely need it.
- If you need an approximate total on a very large table, `reltuples` from `pg_class` is O(1) — but it is an
  estimate, and wiring it in means a custom service method rather than the generated resolver.

---

## 3. Relation loading is where adapters actually differ

Everything else — a filtered page, an aggregate, a single-row mutation — lands within a few milliseconds of each
other across the SQL adapters. Loading relations does not:

| scenario | drizzle | typeorm | sequelize | mongoose | typegoose |
| --- | --- | --- | --- | --- | --- |
| `flat_query` | 13.7 | 14.4 | 13.2 | 168.1 | 184.1 |
| `relation_has_many` | 49.0 | 62.5 | 80.9 | 67.1 | 101.3 |
| `relation_many_to_many` | 92.1 | 30.6 | 66.2 | 57.5 | 87.4 |

The spread between the flat row and the relation rows is the number to watch when changing relation code. Note the
inconsistency in that `relation_many_to_many` row: 30.6 for typeorm against 62.5 on `relation_has_many` is not a
difference the queries justify. **These are single runs and they carry real noise** — treat any one cell as
indicative, not authoritative.

**Design implications**

- **Nested connections multiply.** `todoItems(first: 25) { subTasks(first: 5) }` is one query per level at best,
  and one query *per parent* at worst. Enable `@ptc-org/nestjs-query-graphql`'s dataloaders and keep page sizes
  small at depth.
- **Per-parent paging differs between adapters.** The drizzle adapter emits `LEFT JOIN LATERAL`, so `first: 5`
  applies to each parent. `query-typeorm`'s `batchSelect` applies paging globally across the batch. If you rely on
  per-parent limits, verify the behaviour of your adapter rather than assuming.
- **Prefer a shallow query plus a second round trip** over deep nesting when the client can tolerate it. Two fast
  queries usually beat one query with three levels of lateral joins.

---

## 4. Choosing an adapter

Based on the same run. This is guidance, not a verdict — pick for correctness and ecosystem fit first.

- **All three SQL adapters are equivalent for simple reads.** 13–14 ms at 200 k rows. Do not choose between them on
  flat-query performance.
- **They diverge on counting and on relations** (sections 2 and 3).
- **The document adapters degrade far more steeply with data volume.** `flat_query` went from ~8 ms at 5 000 rows
  to ~170–184 ms at 200 000; the SQL adapters went from ~4–7 ms to ~13–14 ms. Some of this is the engine and the
  driver rather than the adapter, and MongoDB with a matching compound index still examined only the 25 documents
  it returned — but the end-to-end cost is what your users experience.
- **Benchmark at your real data volume.** At 5 000 rows this suite ranked typeorm fastest on relations; at 200 000
  it ranked drizzle fastest. A benchmark run on a toy dataset can invert the answer.

---

## 5. Service design

**One query service per DTO, resolved by token.** Every adapter registers its service under
`getQueryServiceToken(DTOClass)` — the string `` `${DTOClass.name}QueryService` ``. That is why
`@InjectQueryService(SomeDto)` works regardless of which ORM backs it, and why swapping adapters is a module-level
change. Do not bypass it by injecting a repository directly into a resolver; you lose that portability.

**Extend the adapter's service for custom logic**, rather than wrapping it:

```ts
@QueryService(TodoItemDTO)
export class TodoItemService extends TypeOrmQueryService<TodoItemEntity> {
  constructor(@InjectRepository(TodoItemEntity) repo: Repository<TodoItemEntity>) {
    super(repo, { useSoftDelete: true })
  }
}
```

**Use an Assembler when the DTO and the persisted row differ.** Not every adapter converts for you — the drizzle
adapter returns rows as plain objects, so `class-transformer` decorators on the DTO have no effect there. If you
depend on transformation, make it explicit with an assembler instead of relying on adapter behaviour.

**Know the filter semantics.** Multiple operators on the *same* field are combined with `OR`, not `AND`:

```ts
{ age: { gt: 1, lt: 5 } }   // age > 1 OR age < 5   — NOT a range!
{ and: [{ age: { gt: 1 } }, { age: { lt: 5 } }] }   // this is the range
```

This surprises nearly everyone and is easy to ship by accident.

**Authorization belongs in a filter, not in a resolver guard.** `@Authorize` folds the rule into the WHERE clause,
so paging and `totalCount` stay correct. Filtering after the fact returns short pages and wrong totals.

---

## 6. Benchmarking your own schema

`examples/perf` is reusable — point it at your entities. Four mistakes it makes easy to avoid, each of which
produced badly wrong numbers here before being fixed:

**Run scenarios sequentially.** The application is one Node process with one event loop. Run concurrently, a
CPU-heavy scenario inflates every other scenario's latency. Before this was fixed, two adapters appeared 15–20×
slower on relations; after serialising the scenarios most of that gap disappeared. It was event-loop contention,
not the adapters.

**Warm up before measuring.** Straight after a bulk load the buffer pool is cold, and that cost gets charged to
whichever scenario happens to touch a page first.

**Check the response body, not the status code.** A GraphQL error returns **HTTP 200**. A load test asserting only
on status will report excellent latency for a query that is failing on every single request.

**Guard against measuring nothing.** A threshold over an empty metric passes. A harness that blocks its own event
loop can complete zero requests and still report every threshold green — this happened here. Assert
`http_reqs: ['count > 0']`.

Also: **seed with raw SQL, not through the ORM.** Otherwise a slow adapter shows up as slow setup instead of slow
requests, and you have hidden exactly the signal you were looking for.

---

## 7. Adapter-specific constraints worth knowing up front

**`@ptc-org/nestjs-query-drizzle`** (PostgreSQL only, targets `drizzle-orm@1.0.0-rc.x`)

- Single-column primary keys only — `findById` takes a scalar. A table without one fails at bootstrap.
- A relation's predefined `where` is honoured everywhere — the adapter reproduces it on the count, aggregate and
  relation-mutation queries it builds by hand, so `queryRelations` and `countRelations` agree. The exception is a
  relation that declares neither `from` nor `to`: it inherits that filter from the reverse relation, scoped to the
  declaring table, and is rejected.
- Filtering by relation fields compiles to a correlated `EXISTS` rather than the join `query-typeorm` uses, so a
  to-many relation filter needs no `DISTINCT` and does not inflate `totalCount`. Sorting by relation fields is not
  supported.
- Shared-primary-key one-to-one relations cannot be mutated — which side owns the foreign key is ambiguous.
- Rows are returned as-is; no assembler conversion.
- `withDeleted` is ignored — Drizzle has no soft-delete concept, so nothing is ever hidden.
- Relation mutations are not transactional: `setRelations` detaches then attaches as separate statements.
- Pass an existing client as `drizzle({ client: pool, relations })`. The positional form `drizzle(pool, ...)` is
  the v0 API; under v1 it is ignored and Drizzle silently builds its own pool from default connection settings.

**`@ptc-org/nestjs-query-typeorm`** — has a hand-written `count` that avoids TypeORM's `DISTINCT` when no
`isMany` join is present. Relation paging in `batchSelect` is applied globally, not per parent.

**Document adapters** (`mongoose`, `typegoose`) — no junction tables; many-to-many is an array of references on
the document. They do not expose `avg`/`sum` aggregates over their ObjectId primary key.

---

## Reproducing any number here

```sh
yarn docker up -d postgres mongo
yarn perf:compare                                   # all five adapters, 100 000 rows
TODO_ITEMS=5000 yarn perf:compare drizzle typeorm   # smaller, two adapters
```

See [`examples/perf/README.md`](./examples/perf/README.md) for what the suite controls for and what it cannot.
