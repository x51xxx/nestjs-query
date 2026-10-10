# Repository Guidelines

## Project Structure & Module Organization

This repository is a Yarn 4/Nx TypeScript monorepo. Publishable libraries live in `packages/` (for example, `core`, `query-graphql`, and persistence adapters), with implementation code under each package's `src/`. Unit tests mirror source paths under `packages/<name>/__tests__/`; shared fixtures and Jest snapshots stay beside those tests. Runnable NestJS integrations and E2E specs are in `examples/`. Docusaurus content lives in `documentation/docs/`, while static images belong in `documentation/static/`. Build and coverage outputs are generated in `dist/` and `coverage/` and should not be committed.

## Build, Test, and Development Commands

- `yarn install` installs the pinned Yarn 4 workspace dependencies.
- `yarn nx run-many -t build` builds all library projects and their dependencies.
- `yarn nx run-many -t lint` runs ESLint across projects.
- `yarn nx run-many -t test` runs Jest unit tests; add `--configuration=ci` for coverage.
- `yarn test:e2e` runs example integration tests serially. Start required databases first with `yarn docker up -d`.
- `yarn nx test core` (or another project name) runs a focused test suite.
- `yarn nx serve documentation` previews documentation locally.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation. Prettier enforces single quotes, no semicolons, a 130-character line width, and no trailing commas. ESLint uses Airbnb, TypeScript, Jest, Nx module-boundary, and sorted-import rules. Prefer named exports; default exports are prohibited in TypeScript. Use kebab-case filenames such as `filter-query.builder.ts`, PascalCase for classes and types, and camelCase for functions and variables. Keep public exports in the relevant `src/index.ts` barrel.

## Testing Guidelines

Jest and `ts-jest` power unit and E2E tests. Name tests `*.spec.ts`, mirror the corresponding `src/` directory beneath `__tests__/`, and keep reusable data in `__fixtures__/`. Unit tests must avoid persistent storage and cover normal, conditional, and error paths. Add E2E coverage under the closest existing example for full-stack behavior; update snapshots intentionally with the focused Jest target.

## Commit & Pull Request Guidelines

Follow Conventional Commits: `<type>(<scope>): <present-tense summary>`, for example `fix(query-typeorm): handle empty relation filters`. Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `style`, and `chore`; mark breaking changes with `!` and a `BREAKING CHANGE` footer. Pull requests should link the originating issue, describe behavior and verification, include tests for code changes, update docs for new features, and pass build, lint, and test checks. Include screenshots only for documentation or visible UI changes.
