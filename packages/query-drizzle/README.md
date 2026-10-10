<p align="center">
  <a href="https://tripss.github.io/nestjs-query" target="blank"><img src="https://tripss.github.io/nestjs-query/img/logo.svg" width="120" alt="Nestjs-query Logo" /></a>
</p>

# `@ptc-org/nestjs-query-drizzle`

Drizzle ORM adapter for [nestjs-query](https://github.com/tripss/nestjs-query), implementing the
`QueryService` contract from `@ptc-org/nestjs-query-core`.

Targets **Drizzle v1 (`1.0.0-rc.x`)** and **PostgreSQL only**, and is built on Drizzle's
[Relations v2](https://orm.drizzle.team/docs/relations-v1-v2) (`defineRelations`) API.

## Installation

```sh
npm i @ptc-org/nestjs-query-drizzle drizzle-orm@1.0.0-rc.5
```

The `drizzle-orm` peer dependency accepts only the exact release candidates this adapter is written against
(`1.0.0-rc.4` and `1.0.0-rc.5`) — the v1 relations API is still changing between RCs, and rc.5 replaced the
`undefined` a relation's absent `where` used to be with an `EmptyFilter` sentinel. The adapter handles both. The
range will widen once `drizzle-orm@1.0.0` is released.

CI installs `1.0.0-rc.4`; if you are on rc.5, relation reads go through the sentinel branch of
`isEmptyRelationsFilter`.

## Docs

See the [Drizzle getting started guide](https://tripss.github.io/nestjs-query/docs/persistence/drizzle/getting-started)
for schema setup, module wiring, supported relation layouts and the current limitations.
