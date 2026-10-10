import { INestApplication, ValidationPipe } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { DrizzleDatabase } from '@ptc-org/nestjs-query-drizzle'
import { spawn } from 'child_process'
import { createServer } from 'net'
import { join } from 'path'

import { AppModule } from '../src/app.module'
import { DRIZZLE_DB } from '../src/schema'
import { registerRelationNPlusOneRoutes } from './n-plus-one'
import { createPerfSchema, DEFAULT_SIZES, seed, SeedSizes } from './seed'

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

const sizes: SeedSizes = {
  ...DEFAULT_SIZES,
  todoItems: Number(process.env.TODO_ITEMS ?? DEFAULT_SIZES.todoItems)
}

const scriptName = process.argv.includes('--n-plus-one') ? 'n-plus-one.js' : 'graphql.js'

/**
 * Runs k6 as a child process.
 *
 * This must NOT use `spawnSync`: that blocks the Node event loop, so the Nest server sitting in this same process
 * would accept connections but never answer them. k6 then reports zero completed requests -- and, because a
 * threshold over an empty metric passes, the whole run looks green while measuring nothing.
 */
const runK6 = (port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      'k6',
      [
        'run',
        '-e',
        `BASE_URL=http://localhost:${port}`,
        '-e',
        `TODO_ITEMS=${sizes.todoItems}`,
        ...(process.env.VUS ? ['-e', `VUS=${process.env.VUS}`] : []),
        ...(process.env.DURATION ? ['-e', `DURATION=${process.env.DURATION}`] : []),
        ...(process.env.RELATION_PARENTS ? ['-e', `RELATION_PARENTS=${process.env.RELATION_PARENTS}`] : []),
        ...(process.env.RELATION_OPERATION ? ['-e', `RELATION_OPERATION=${process.env.RELATION_OPERATION}`] : []),
        join(__dirname, 'k6', scriptName)
      ],
      { stdio: 'inherit' }
    )

    child.on('error', (error) => {
      console.error('\nFailed to run k6. Is it installed? https://grafana.com/docs/k6/latest/set-up/install-k6/')
      reject(error)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })

async function main(): Promise<void> {
  let app: INestApplication | undefined
  let exitCode = 1

  try {
    const port = await findFreePort()

    app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] })
    // Register raw perf routes before `app.init()`, which appends Nest's final 404 middleware.
    registerRelationNPlusOneRoutes(app)
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        skipMissingProperties: false,
        forbidUnknownValues: true
      })
    )
    await app.init()

    const db = app.get<DrizzleDatabase>(DRIZZLE_DB)

    console.log(`Seeding ${sizes.todoItems} todo items (${sizes.subTasksPerItem} sub tasks each)...`)
    const seedStart = Date.now()
    await createPerfSchema(db)
    await seed(db, sizes)
    console.log(`Seeded in ${Date.now() - seedStart}ms`)

    await app.listen(port)
    console.log(`App listening on http://localhost:${port}/graphql\n`)

    exitCode = await runK6(port)
  } finally {
    // `app.close()` triggers DatabaseModule.onApplicationShutdown, which ends the pool.
    await app?.close()
  }

  process.exit(exitCode)
}

// eslint-disable-next-line no-void
void main()
