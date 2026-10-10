import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SIZES } from './src/adapter'
import { AdapterResult, readK6Summary } from './src/k6-summary'
import { ADAPTER_NAMES } from './src/registry'

const RESULTS_DIR = join(__dirname, '.results')
const SCENARIOS = ['flat_query', 'flat_query_total_count', 'relation_has_many', 'relation_many_to_many', 'aggregate', 'mutation']

/**
 * Each adapter runs in its own child process. Loading five ORMs and three sets of GraphQL types into one process
 * would let them interfere with each other -- and would make the first adapter benchmarked look different from the
 * last simply because of what else was resident.
 */
const runInChildProcess = (adapter: string, todoItems: number): AdapterResult | undefined => {
  console.log(`\n=== ${adapter} ===`)

  const result = spawnSync(
    'ts-node',
    ['-r', 'tsconfig-paths/register', '-P', 'examples/tsconfig.app.json', 'examples/perf/run-adapter.ts', adapter],
    {
      stdio: 'inherit',
      cwd: join(__dirname, '..', '..'),
      env: { ...process.env, TODO_ITEMS: String(todoItems), PERF_QUIET: '1' }
    }
  )

  if (result.status !== 0) {
    console.error(`  ${adapter} FAILED — excluded from the comparison`)

    return undefined
  }

  const summaryFile = join(RESULTS_DIR, `${adapter}.summary.json`)
  if (!existsSync(summaryFile)) {
    return undefined
  }

  return readK6Summary(summaryFile, adapter)
}

/**
 * Guards the whole comparison: if two adapters do not serve byte-identical GraphQL schemas then they are not
 * answering the same questions, and comparing their latencies is meaningless.
 */
const assertSchemasMatch = (adapters: string[]): void => {
  const schemas = adapters
    .map((adapter) => ({ adapter, file: join(RESULTS_DIR, `${adapter}.schema.gql`) }))
    .filter(({ file }) => existsSync(file))
    .map(({ adapter, file }) => ({ adapter, sdl: readFileSync(file, 'utf8') }))

  if (schemas.length < 2) return

  const typeNames = (sdl: string): Set<string> => new Set(Array.from(sdl.matchAll(/^(?:type|input) (\w+)/gm)).map((m) => m[1]))

  const [reference, ...rest] = schemas
  const referenceTypes = typeNames(reference.sdl)
  const mismatched = rest
    .filter(({ sdl }) => sdl !== reference.sdl)
    .map(({ adapter, sdl }) => {
      const types = typeNames(sdl)

      return {
        adapter,
        missing: [...referenceTypes].filter((t) => !types.has(t)),
        extra: [...types].filter((t) => !referenceTypes.has(t))
      }
    })

  if (!mismatched.length) {
    console.log(`\nSchema check: all ${schemas.length} adapters serve an identical GraphQL schema.`)

    return
  }

  console.log(`\nSchema check: differences against "${reference.adapter}":`)
  for (const { adapter, missing, extra } of mismatched) {
    console.log(`  ${adapter}: ${missing.length} missing, ${extra.length} extra`)
    if (missing.length) console.log(`    missing: ${missing.join(', ')}`)
    if (extra.length) console.log(`    extra:   ${extra.join(', ')}`)
  }
  console.log(
    '  Only matters if a *benchmarked operation* differs. The document adapters legitimately lack numeric\n' +
      '  aggregates over their ObjectId primary key; the scenarios never use those. See README.md.'
  )
}

const pad = (value: string, width: number) => value.padEnd(width)
const padLeft = (value: string, width: number) => value.padStart(width)

const printTable = (results: AdapterResult[]): void => {
  const colWidth = 14

  console.log('\np95 latency in ms (lower is better)\n')
  console.log(pad('scenario', 24) + results.map((r) => padLeft(r.adapter, colWidth)).join(''))
  console.log('-'.repeat(24 + results.length * colWidth))

  for (const scenario of SCENARIOS) {
    const cells = results.map((r) => {
      const value = r.scenarios[scenario]

      return padLeft(value ? value.p95.toFixed(1) : '-', colWidth)
    })
    console.log(pad(scenario, 24) + cells.join(''))
  }

  console.log('-'.repeat(24 + results.length * colWidth))
  console.log(pad('total requests', 24) + results.map((r) => padLeft(String(r.totalRequests), colWidth)).join(''))
  console.log('\n(absolute numbers are machine specific; compare columns, not runs)')
}

const main = (): void => {
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
  const adapters = requested.length ? requested : ADAPTER_NAMES
  const todoItems = Number(process.env.TODO_ITEMS ?? DEFAULT_SIZES.todoItems)

  console.log(`Benchmarking ${adapters.join(', ')} with ${todoItems} todo items each.`)

  const results = adapters
    .map((adapter) => runInChildProcess(adapter, todoItems))
    .filter((result): result is AdapterResult => result !== undefined)

  if (!results.length) {
    console.error('\nNo adapter completed successfully.')
    process.exit(1)
  }

  assertSchemasMatch(results.map((r) => r.adapter))
  printTable(results)

  if (results.length < adapters.length) {
    process.exit(1)
  }
}

main()
