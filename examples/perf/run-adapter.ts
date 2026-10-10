import { INestApplication, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { spawn } from 'child_process'
import { mkdirSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'

import { DEFAULT_SIZES, SeedSizes } from './src/adapter'
import { ensurePerfDatabase } from './src/adapters/postgres.config'
import { AppModule } from './src/app.module'
import { AdapterResult, readK6Summary } from './src/k6-summary'
import { getAdapter } from './src/registry'

export type { AdapterResult, ScenarioResult } from './src/k6-summary'

const RESULTS_DIR = join(__dirname, '.results')

const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })

/**
 * k6 must run as a child process without blocking this one: the Nest server lives in this same process, so a
 * synchronous spawn would leave it accepting connections it never answers.
 */
const runK6 = (port: number, summaryFile: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'k6',
      [
        'run',
        '--summary-export',
        summaryFile,
        '-e',
        `BASE_URL=http://localhost:${port}`,
        ...(process.env.VUS ? ['-e', `VUS=${process.env.VUS}`] : []),
        ...(process.env.DURATION ? ['-e', `DURATION=${process.env.DURATION}`] : []),
        join(__dirname, 'k6', 'graphql.js')
      ],
      { stdio: process.env.PERF_QUIET ? 'ignore' : 'inherit' }
    )

    child.on('error', (error) => {
      console.error('\nFailed to run k6. Is it installed? https://grafana.com/docs/k6/latest/set-up/install-k6/')
      reject(error)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })

export const runAdapter = async (name: string, sizes: SeedSizes = DEFAULT_SIZES): Promise<AdapterResult> => {
  const adapter = getAdapter(name)
  let app: INestApplication | undefined

  mkdirSync(RESULTS_DIR, { recursive: true })
  const summaryFile = join(RESULTS_DIR, `${name}.summary.json`)

  try {
    if (adapter.backend === 'postgres') {
      await ensurePerfDatabase()
    }

    const port = await findFreePort()

    app = await NestFactory.create(AppModule.forAdapter(name, join(RESULTS_DIR, `${name}.schema.gql`)), {
      logger: ['error', 'warn']
    })
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    await app.init()

    const seedStart = Date.now()
    await adapter.seed(app, sizes)
    const seedMs = Date.now() - seedStart

    await app.listen(port)

    const exitCode = await runK6(port, summaryFile)
    const result = readK6Summary(summaryFile, name, seedMs)

    if (exitCode !== 0 || result.failedChecks > 0) {
      throw new Error(`k6 run for "${name}" failed (exit ${exitCode}, ${result.failedChecks} failed checks)`)
    }

    return result
  } finally {
    await app?.close()
  }
}

if (require.main === module) {
  const name = process.argv[2] ?? process.env.PERF_ADAPTER ?? 'drizzle'
  const sizes: SeedSizes = { ...DEFAULT_SIZES, todoItems: Number(process.env.TODO_ITEMS ?? DEFAULT_SIZES.todoItems) }

  runAdapter(name, sizes)
    .then((result) => {
      console.log(`\n${result.adapter}: seeded in ${result.seedMs}ms, ${result.totalRequests} requests`)
      process.exit(0)
    })
    .catch((error: Error) => {
      console.error(error.message)
      process.exit(1)
    })
}
