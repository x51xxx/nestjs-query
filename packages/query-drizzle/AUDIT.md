# Query Drizzle audit

Date: 2026-08-08

This file preserves an external audit of the adapter and tracks its resolution against the current
implementation. Line numbers from the original report are intentionally omitted because the fixes move them.

## Verification baseline

- PostgreSQL: 18.4 in Docker
- Drizzle ORM: `1.0.0-rc.4` installed; peer range accepts `>=1.0.0-rc.4 <1.0.0`
- Unit tests use the real Drizzle `pg-proxy` SQL builder: 180 tests.
- E2E tests use `node-postgres` and assert results plus SQL statement counts for batched relations.
- The rc.5 `EmptyFilter` branch is covered by re-importing the compat module against a stubbed `drizzle-orm`, so it
  does not depend on which release candidate happens to be installed.

## Findings

| ID  | Severity | Finding                                                                                              | Current status                                                                                            |
| --- | -------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1  | Critical | `useSoftDelete` was silently converted into a permanent delete                                       | Fixed: delete methods reject the option before SQL                                                        |
| C2  | Critical | `relations` passed to `drizzle()` and `forFeature()` could disagree until the first relation request | Fixed: service constructor validates `db.query[tableName]`                                                |
| H1  | High     | Relation filters reached an unknown column and produced a plain internal error                       | Superseded: relation filters are now supported (see 2026-09-07 below); a key that is neither a column nor a relation still throws `BadRequestException` |
| H2  | High     | EmptyFilter compatibility compared against a guessed `Symbol.for()` value                            | Fixed: comparison uses the actual optional Drizzle export; peer range is `^1.0.0-rc.4` (widened 2026-10-10, see C3) and the sentinel branch is unit-tested against a stubbed rc.5 export |
| H3  | High     | Docs described Drizzle schema FK declarations as PostgreSQL runtime metadata                         | Fixed: docs, typings, fixtures and example schema use and describe `.references()` accurately             |
| H5  | High     | Adding `.references()` everywhere moved coverage off the primary-key inference fallback              | Fixed: `inferredRelations`/`ambiguousRelations` fixtures declare no FKs, so both inference branches and the `'ambiguous'` rejection paths are exercised |
| H6  | High     | Composite join keys took an untested branch when batching relation aggregates                        | Fixed: `compositeKeyRelations` fixture covers the OR-of-ANDs batching for counts and aggregates           |
| H4  | High     | Relation count/aggregate SQL lacked real PostgreSQL coverage                                         | Fixed: PG18 E2E covers direct/through counts, grouped aggregates, aliases and `setRelations`              |
| M1  | Medium   | Read-modify-write CRUD operations were split across statements                                       | Mostly fixed: create/update/delete use one atomic statement; multi-step `setRelations` remains documented |
| M2  | Medium   | `updateOne` could return `undefined` despite `Promise<Entity>`                                       | Fixed: atomic update throws `NotFoundException` when `RETURNING` is empty                                 |
| M3  | Medium   | `createMany` issued one existence SELECT per row                                                     | Fixed: one atomic multi-row INSERT; unique violation maps to `ConflictException`                          |
| M4  | Medium   | Bulk update/delete returns every id to calculate the affected count                                  | Deferred: `RETURNING` is the only portable affected-row mechanism across the supported Drizzle PG drivers |
| M5  | Medium   | Relation count/aggregate issued one query per parent                                                 | Fixed: one grouped query per DataLoader batch, including through relations                                |
| M6  | Medium   | Re-adding a junction relation produced `23505` or duplicates                                         | Fixed: junction insert uses `onConflictDoNothing()`; example declares a composite PK                      |
| M7  | Medium   | Misspelled `relationOptions` keys were ignored                                                       | Fixed: constructor validates every key against the table relation config                                  |
| M8  | Medium   | Database provider had to come from a global Nest module                                              | Fixed: `forFeature()` accepts and forwards `imports`                                                      |
| M9  | Medium   | Unused `class-transformer` peer dependency                                                           | Fixed: removed from the package manifest and lockfile                                                     |

## Lower-priority observations

| ID  | Observation                                                                             | Current status                                                                      |
| --- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| L1  | `TableMeta.fieldFor()` scanned all columns repeatedly                                   | Fixed with a reverse column map                                                     |
| L2  | Builders are allocated repeatedly in some relation mutation/scalar paths                | Open; low allocation cost compared with SQL I/O                                     |
| L3  | Empty bulk filters intentionally update/delete every row                                | Open; parity with other adapters, worth highlighting in general bulk-operation docs |
| L4  | Internal relation service is not part of the public package surface                     | Accepted; extension point is `DrizzleQueryService`                                  |
| L5  | Aggregate `sum`/`avg` uses `Number()` and can lose arbitrary numeric precision          | Open; existing cross-adapter response contract returns numbers                      |
| L6  | Removing a source-side relation clears the FK without verifying the supplied related id | Accepted for parity with the TypeORM adapter                                        |
| L7  | Eager relation selections in find options are ignored                                   | Documented behavior                                                                 |
| L8  | Aliased column lookup could silently fall back to an unaliased column                   | Fixed: missing aliases now throw immediately                                        |

## 2026-09-07 — Drizzle rc.5 review and follow-up work

| ID  | Severity | Finding                                                                                          | Status                                                                                                    |
| --- | -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| H7  | High     | `setRelations` detached by parent key alone, so replacing a relation that declares a predefined `where` cleared the foreign key of rows the relation never contained | Fixed: `detachAllFromParent` applies the relation's filter (through relations via a subquery on the junction key); covered by unit and e2e tests |
| M10 | Medium   | Relations declaring a predefined `where` were rejected outright, on the incorrect premise that `relationsFilterToSQL` was module-private | Fixed: it is a public export in both RCs. The filter is reproduced on the count, aggregate and relation-mutation queries. Only the reverse-inferred case is still rejected, because there the filter is scoped to the declaring table, which those queries never select from |
| M11 | Medium   | The generated schema advertised relation filters (`TodoItemFilter.subTasks`) that the adapter rejected at runtime | Fixed: a relation key compiles to a correlated `EXISTS` (aliases `__nq_rel` / `__nq_rel_through`). The nested filter recurses through the adapter's own `WhereBuilder`, so relation filters keep the same operator vocabulary and OR-per-field composition as any other filter |
| L9  | Low      | The compat spec asserted rc.4's `undefined` return unconditionally and failed on an rc.5 install | Fixed: the assertion follows whatever the installed Drizzle exports                                        |

Notes worth keeping:

- **rc.5 compatibility.** Verified on `1.0.0-rc.4` and `1.0.0-rc.5-169397b` (no plain `1.0.0-rc.5` exists on npm).
  rc.5 makes `undefined` inside a relation filter throw rather than be skipped, and renames `Relation.isReversed`
  to `isFilterReversed`; both are absorbed by `src/query/drizzle-compat.utils.ts`.
- **Aliasing.** A relation's cached `predefinedWhere` names the real table and cannot be reused inside an `EXISTS`
  subquery, where the target is aliased; `RelationMeta.predefinedWhereOn(table)` re-renders it. Drizzle types a
  relation's `where` as `TableFilter` (columns only), so it can never itself name a relation -- which is why the
  `depth` argument of `relationsFilterToSQL` is unreachable here.
- **`EXISTS` rather than a join.** `query-typeorm` left-joins and de-duplicates; a correlated `EXISTS` expresses
  "has at least one matching row" without inflating `totalCount`. An empty relation filter (`{ subTasks: {} }`) is
  a no-op, matching TypeORM's left join.

## 2026-10-10 — pre-PR review

| ID  | Severity | Finding                                                                                          | Status                                                                                                    |
| --- | -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| H8  | High     | `setRelations` validated new ids against `relationFilter` but detached every related row, so an authorizer's filter did not protect rows the caller cannot see | Fixed: the detach applies `relationFilter` on both sides (junctions via a subquery), as `query-typeorm` does. `setRelation` on a has-one still detaches the previous holder unconditionally, also as TypeORM does |
| H9  | High     | Date `groupBy` buckets were Postgres `date` values that node-postgres leaves as strings; GraphQL `DateTime` turned them into `null` (an error on the non-null field) | Fixed: `DATE_TRUNC` cast back to the column's SQL type and decoded with `.mapWith(column)`; e2e groups by `created(by: DAY)` |
| M12 | Medium   | `updateOne(id, {})` failed with Drizzle's "No values to set" (500); a non-column key rendered an invalid `SET` | Fixed: updates are restricted to columns; an empty `updateOne` returns `getById`, an empty `updateMany` is a `BadRequestException` |
| C3  | Medium   | Peer range `>=1.0.0-rc.4 <1.0.0` excluded the v1 release itself                                  | Fixed: `^1.0.0-rc.4`                                                                                      |
| M13 | Medium   | Relation filters on a nested relation connection/count/aggregate (`subTasks(filter: { todoItem: ... })`) throw `Unknown field`, although the schema advertises them; the target-side `FilterQueryBuilder`s are built without a relation resolver | Open |
| L10 | Low      | Object prototype keys (`constructor`, `__proto__`) pass the column whitelist in `TableMeta.column` and the relation checks; unreachable through validated GraphQL input | Open: switch the lookups to own-property checks |
| L11 | Low      | `src/index.ts` exports the `@internal` builders (`AggregateBuilder`, `WhereBuilder`, ...), unlike `query-typeorm` | Open: decide before the upstream PR |



1. Decide whether to add an adapter-level transaction abstraction for multi-statement relation replacement. Every
   driver an application would actually deploy (`node-postgres`, `postgres-js`, `neon-serverless`) supports
   transactions; the blocker is `pg-proxy`, which the unit fixtures use and which throws
   `Transactions are not supported by the Postgres Proxy driver`. So this is a test-harness constraint rather than a
   production one — either feature-detect `db.transaction` with a sequential fallback, or move the unit fixtures to
   `pglite`, which is a real in-process PostgreSQL and supports transactions.
2. Consider an optional affected-row extractor per driver to remove bulk `RETURNING id`. Drizzle's generic
   `PgAsyncDatabase` does not expose one portable result shape (`rowCount`, `count`, and other shapes vary).
3. Add chunking/deduplication for unusually large relation aggregate batches before approaching PostgreSQL's bind
   parameter limit. GraphQL currently caps a page at 50 by default, so this is defense in depth.
4. Keep the request-scoped k6 SQL instrumentation covered when adding another PostgreSQL client. It currently
   instruments the example's `node-postgres` Pool and isolates counters through `AsyncLocalStorage`.

## Performance evidence

With 25 parents, 5 VUs and 10 seconds on PostgreSQL 18.4:

| Path                   | SQL statements/request |  Average |     p95 |
| ---------------------- | ---------------------: | -------: | ------: |
| Batched relation count |                      2 | 0.961 ms | 1.30 ms |
| Deliberate N+1 control |                     26 |  7.54 ms | 9.11 ms |

The deliberate N+1 path was 8.06x slower on average. See `examples/drizzle/perf/README.md` for the scenario and
portability caveats.
