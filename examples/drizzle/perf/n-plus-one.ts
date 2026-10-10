import { INestApplication } from '@nestjs/common'
import { getQueryServiceToken, SortDirection } from '@ptc-org/nestjs-query-core'
import { DrizzleQueryService } from '@ptc-org/nestjs-query-drizzle'
import { AsyncLocalStorage } from 'async_hooks'
import { Request, Response } from 'express'
import { Pool } from 'pg'

import { SubTaskDTO } from '../src/sub-task/dto/sub-task.dto'
import { TodoItemDTO } from '../src/todo-item/dto/todo-item.dto'

const MAX_PARENTS = 100

interface SqlQueryContext {
  count: number
}

const integerParam = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN

  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback
}

/**
 * Registers two perf-only endpoints that execute the same relation load in different shapes:
 *
 * - `batch` passes every parent to the relation operation, resulting in one parent query plus one relation query;
 * - `n-plus-one` deliberately calls the same operation once per parent, resulting in one parent query plus N
 *   relation queries. This models the adapter regression without adding GraphQL parsing, HTTP fan-out or DataLoader
 *   behavior to only one side of the comparison.
 */
export const registerRelationNPlusOneRoutes = (app: INestApplication): void => {
  const service = app.get<DrizzleQueryService<TodoItemDTO>>(getQueryServiceToken(TodoItemDTO))
  const pool = app.get(Pool)
  const queryContext = new AsyncLocalStorage<SqlQueryContext>()
  const originalQuery = pool.query.bind(pool) as Pool['query']
  const executeQuery = originalQuery as unknown as (...args: unknown[]) => unknown

  pool.query = ((...args: unknown[]): unknown => {
    const context = queryContext.getStore()
    if (context) {
      context.count += 1
    }

    return executeQuery(...args)
  }) as Pool['query']

  app.getHttpAdapter().get('/perf/relations/:mode', (req: Request, res: Response) =>
    queryContext.run({ count: 0 }, async () => {
      try {
        const requestedParents = integerParam(req.query.parents, 25, MAX_PARENTS)
        const startId = integerParam(req.query.startId, 1, Number.MAX_SAFE_INTEGER)
        const operation = req.query.operation === 'rows' ? 'rows' : 'count'
        const parents = await service.query({
          filter: { id: { gte: startId } },
          paging: { limit: requestedParents },
          sorting: [{ field: 'id', direction: SortDirection.ASC }]
        })

        let relatedRows = 0

        if (req.params.mode === 'batch') {
          if (operation === 'count') {
            const loaded = await service.countRelations(SubTaskDTO, 'subTasks', parents, {})
            relatedRows = Array.from(loaded.values()).reduce((total, count) => total + count, 0)
          } else {
            const loaded = await service.queryRelations(SubTaskDTO, 'subTasks', parents, { paging: { limit: 3 } })
            relatedRows = Array.from(loaded.values()).reduce((total, rows) => total + rows.length, 0)
          }
        } else if (req.params.mode === 'n-plus-one') {
          for (const parent of parents) {
            if (operation === 'count') {
              relatedRows += await service.countRelations(SubTaskDTO, 'subTasks', parent, {})
            } else {
              const loaded = await service.queryRelations(SubTaskDTO, 'subTasks', parent, { paging: { limit: 3 } })
              relatedRows += loaded.length
            }
          }
        } else {
          res.status(404).json({ error: `Unknown relation loading mode: ${req.params.mode}` })
          return
        }

        res.json({
          mode: req.params.mode,
          operation,
          parents: parents.length,
          relatedRows,
          sqlQueries: queryContext.getStore()?.count ?? 0
        })
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
      }
    })
  )
}
