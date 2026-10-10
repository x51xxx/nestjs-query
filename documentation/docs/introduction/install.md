---
title: Install
sidebar_label: Install
---

## @ptc-org/nestjs-query-core

```sh
npm i @ptc-org/nestjs-query-core @nestjs/common class-transformer
```

## @ptc-org/nestjs-query-graphql

```sh
npm i @ptc-org/nestjs-query-graphql @nestjs/common @nestjs/graphql graphql graphql-subscriptions class-transformer class-validator dataloader
```

**NOTE** `@ptc-org/nestjs-query-graphql` has opted for peer dependencies to follow nest conventions and to prevent duplicate installations of packages.

## @ptc-org/nestjs-query-typeorm

```sh
npm i @ptc-org/nestjs-query-typeorm @nestjs/common @nestjs/typeorm class-transformer typeorm
```

**NOTE** `@ptc-org/nestjs-query-typeorm` has opted for peer dependencies to follow nest conventions and to prevent duplicate installations of packages.

## @ptc-org/nestjs-query-drizzle

```sh
npm i @ptc-org/nestjs-query-drizzle @nestjs/common class-transformer drizzle-orm@1.0.0-rc.4
```

**NOTE** `@ptc-org/nestjs-query-drizzle` has opted for peer dependencies to follow nest conventions and to prevent duplicate installations of packages.

**NOTE** The `drizzle-orm` peer range covers the v1 release candidates (`>=1.0.0-rc.4 <1.0.0`), and the adapter is verified against `1.0.0-rc.4` and the `1.0.0-rc.5` line. Pin an exact version in your own app: the v1 relations API this adapter builds on is still changing between RCs. PostgreSQL is the only supported dialect.

## @ptc-org/nestjs-query-sequelize

```sh
npm i @ptc-org/nestjs-query-sequelize @nestjs/common @nestjs/sequelize sequelize sequelize-typescript
```

**NOTE** `@ptc-org/nestjs-query-sequelize` has opted for peer dependencies to follow nest conventions and to prevent duplicate installations of packages.

## @ptc-org/nestjs-query-mongoose

```sh
npm i @ptc-org/nestjs-query-mongoose @nestjs/common @nestjs/mongoose mongoose mongodb
```

**NOTE** `@ptc-org/nestjs-query-mongoose` has opted for peer dependencies to follow nest conventions and to prevent duplicate installations of packages.

## @ptc-org/nestjs-query-typegoose

```sh
npm i @ptc-org/nestjs-query-typegoose @nestjs/common @typegoose/typegoose nestjs-typegoose mongoose mongodb
```

**NOTE** `@ptc-org/nestjs-query-typegoose` has opted for peer dependencies to follow nest conventions and to prevent duplicate installations of packages.
