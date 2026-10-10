# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository overview

`nestjs-query` is an Nx-managed Yarn workspace monorepo that generates GraphQL CRUD resolvers for NestJS backed by
pluggable ORM adapters. Published packages live in `packages/*`, runnable sample apps and e2e tests live in
`examples/*`, and the docs site (Docusaurus) lives in `documentation/`.

Package manager is **Yarn 4** (`packageManager: yarn@4.13.0`) — use `yarn`, not `npm`.

## Common commands

All build/test/lint targets are run through **Nx**, not directly through `jest`/`eslint`/`tsc`.

```bash
# Install deps
yarn

# Build all packages (respects dependency graph)
yarn nx run-many --target=build --all
# Build a single package
yarn nx build query-graphql

# Lint all / one package
yarn nx run-many --target=lint --all
yarn nx lint core

# Unit tests, all packages (this is what CI runs per package)
yarn nx run-many --target=test --all
# Unit tests for one package
yarn nx test query-typeorm
# Single test file / pattern via the underlying jest args
yarn nx test query-typeorm --testFile=filter-query.builder.spec.ts
yarn nx test core -t "should build the where clause"

# E2E tests (require backing DB services)
cd examples && docker compose up -d && cd ..
yarn nx run-many --target=e2e --all
# or just:
yarn test:e2e   # === nx e2e examples

# Run one example app locally
nx serve <example-name>   # e.g. nx serve basic
```

Notes:
- `jest.config.ts` at the repo root wires the jest "projects" (`core`, `query-graphql`, `query-typeorm`,
  `query-typegoose`, `query-sequelize`, `query-mongoose`, `examples`). `jest.preset.js` maps the
  `@ptc-org/nestjs-query-*` package names directly to each package's `src` (not `dist`), so tests run against
  source, not build output.
- E2E specs live under `examples/**/e2e/**/*.spec.ts` and are matched by `jest.e2e.ts`. They require Postgres/MySQL
  containers from `examples/docker-compose.yml` (see `examples/init-scripts/{mysql,postgres}` for DB bootstrap SQL).
- `query-mikro-orm` is not currently wired into the root `jest.config.ts` projects list — check its own
  `packages/query-mikro-orm/jest.config.ts` when working there.
- Commit messages must follow **Conventional Commits** (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, ...),
  optionally scoped by package (`feat(typeorm): ...`). This is enforced by commitlint/husky.
- New/changed behavior needs a corresponding `.spec.ts` under the package's `src`-mirroring test path, and
  cross-cutting features should get e2e coverage under `examples/`.

## Architecture

### Package layering

```
core             — ORM-agnostic contracts, DTO<->entity assemblers, filter/sort/page helpers
  ↑
query-typeorm / query-sequelize / query-mongoose / query-typegoose / query-mikro-orm / query-drizzle
  — implement `QueryService` for one ORM, translating the core Filter/Query into native queries
  ↑
query-graphql    — turns any `QueryService` into GraphQL resolvers, types, and decorators
```

`query-graphql` and every ORM adapter depend only on `core`'s abstractions — they never depend on each other. This
means the GraphQL layer works identically no matter which ORM adapter backs a given DTO.

### `core`: the `QueryService` contract and DI wiring

- `services/query.service.ts` defines the `QueryService<DTO, C, U>` interface (query/aggregate/count/findById/
  createOne/updateOne/deleteOne/relation CRUD, etc.) — every adapter implements this.
- DI uses **string tokens**, not classes: `getQueryServiceToken(DTOClass) => "${DTOClass.name}QueryService"`
  (`decorators/helpers.ts`). `@InjectQueryService(SomeDto)` injects whatever is registered under that token, so
  the GraphQL resolver layer never needs to know which ORM backs a DTO.
- `helpers/{filter,sort,page,comparison}.builder.ts` provide ORM-agnostic building blocks that adapters reuse when
  translating a `Filter<DTO>`/`Query<DTO>` into their native query language.
- `assemblers/` handle DTO ↔ Entity conversion when the GraphQL DTO doesn't map 1:1 to the persistence entity.

### ORM adapters (`query-typeorm`, `query-sequelize`, `query-mongoose`, `query-typegoose`, `query-mikro-orm`)

Every adapter follows the same three-part structure:
- `module.ts` — a static `forFeature()` that wraps the ORM's own Nest module (e.g. `TypeOrmModule.forFeature`) and
  additionally registers a `QueryService` provider per entity.
- `providers.ts` — a factory provider keyed by `getQueryServiceToken(Entity)` that injects the ORM's native
  repository/model and constructs the adapter's `QueryService` implementation from it.
- `services/*-query.service.ts` — the class implementing `QueryService`, e.g. `TypeOrmQueryService`,
  `MongooseQueryService`. App code typically `extends` this class when custom logic is needed, then annotates it
  with `@QueryService(Entity)`.
- `query/` — the ORM-specific translation layer: `filter-query.builder.ts`, `where.builder.ts`,
  `(sql-)comparison.builder.ts`, `aggregate.builder.ts`. This is where an abstract `Filter<DTO>` becomes a real
  SQL `WHERE`/Mongo query/etc.

Adapter-specific notes:
- `query-typeorm` / `query-sequelize`: relational, JOIN-based relation loading via a shared `RelationQueryService`.
- `query-mongoose` / `query-typegoose`: document-based, so relations use a separate `ReferenceQueryService`
  (populate / manual `$in` queries) instead of JOINs. `query-typegoose` wraps Typegoose's class-decorator model
  definitions on top of the same Mongoose primitives.
- `query-mikro-orm` is the only adapter with its own `assemblers/` — MikroORM distinguishes entity instances from
  plain objects more strictly, so it needs adapter-specific DTO conversion.
- `query-drizzle` (PostgreSQL only, targets `drizzle-orm@1.0.0-rc.x`) breaks the pattern in two ways: Drizzle
  tables are plain objects with no class identity, so `forFeature` takes an explicit `{ DTOClass, tableName }`
  mapping plus a DI token for the app-provided `db`; and there is no ORM Nest module to wrap. Relation reads go
  through Drizzle's relational query builder (`db.query.*`), whose lateral joins apply relation paging per parent,
  while counts/aggregates build SQL directly. Conditions handed to that query builder must be built from the
  aliased table its callbacks provide — using the original column objects emits invalid SQL.

### `query-graphql`: resolvers built from mixins

Resolvers are composed via TypeScript mixins, not inheritance chains you'd find in one file — reading
`resolvers/crud.resolver.ts` alongside `create.resolver.ts` / `read.resolver.ts` / `update.resolver.ts` /
`delete.resolver.ts` / `aggregate.resolver.ts` / `relations/` is necessary to see the full picture. A `CRUDResolver`
is built by mixing `Creatable` + `Readable` + `Updatable` + `Deletable` + `Aggregateable` (+ `Relatable` for
relations), each contributing its own GraphQL fields/mutations gated by options (e.g. `enableSubscriptions`,
`pagingStrategy`, `enableAggregate`). Other notable subsystems under `query-graphql/src/`:
- `decorators/` — DTO-facing decorators (`@FilterableField`, `@IDField`, `@Relation`, `@Authorize`, hooks, etc.)
  that drive both GraphQL schema generation and query behavior.
- `federation/` and `resolvers/federation/` — Apollo Federation support.
- `subscription/`, `loader/` (dataloaders), `auth/`, `hooks/`, `pipes/`, `interceptors/` — cross-cutting resolver
  behavior.
- `types/` — the paging strategies (`CURSOR`/`OFFSET`/etc.) and connection type generation.

### Examples (`examples/*`)

Each subdirectory is a standalone runnable NestJS app (registered in `examples/nest-cli.json`) demonstrating one
feature or ORM combination (e.g. `typeorm`, `mongoose`, `sequelize`, `typegoose`, `federation`, `auth`, `filters`,
`custom-service`). These double as the e2e test targets — when adding a feature that needs integration coverage,
prefer extending an existing example over creating a new one unless the feature is fundamentally new. New examples
using TypeORM/Sequelize need DB init scripts under `examples/init-scripts/{mysql,postgres}/init-<name>.sql`.

## Documentation

Docs source lives in `documentation/` (Docusaurus). New pages must be added to `documentation/sidebars.js`. Serve
locally with `nx serve documentation`.
