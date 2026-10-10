import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getQueryServiceToken, QueryService, SortDirection } from '@ptc-org/nestjs-query-core'
import { DrizzleDatabase } from '@ptc-org/nestjs-query-drizzle'
import { Pool } from 'pg'
import request from 'supertest'

import { AppModule } from '../src/app.module'
import { DRIZZLE_DB } from '../src/schema'
import { SubTaskDTO } from '../src/sub-task/dto/sub-task.dto'
import { TodoItemDTO } from '../src/todo-item/dto/todo-item.dto'
import { createSchema, refresh } from './fixtures'

interface GraphqlResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any
  errors?: { message: string }[]
}

const graphql = async (app: INestApplication, query: string): Promise<GraphqlResponse> => {
  const { body } = await request(app.getHttpServer()).post('/graphql').send({ query }).expect(200)

  return body as GraphqlResponse
}

/** Narrows an untyped GraphQL list before mapping over it. */
const asList = <T>(value: unknown): T[] => value as T[]

interface Edge<T> {
  node: T
}

describe('Drizzle adapter (e2e)', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication()
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
    await createSchema(app.get<DrizzleDatabase>(DRIZZLE_DB))
  })

  beforeEach(() => refresh(app.get<DrizzleDatabase>(DRIZZLE_DB)))

  // `app.close()` fires `DatabaseModule.onApplicationShutdown`, which ends the pool -- closing it here as well
  // would throw "Called end on pool more than once".
  afterAll(() => app.close())

  describe('query', () => {
    it('should find a todo item by id', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItem(id: 1) {
              id
              title
              completed
              priority
            }
          }
        `
      )

      expect(body.data.todoItem).toEqual({ id: '1', title: 'Create Nest App', completed: true, priority: 0 })
    })

    it('should error for a missing id', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItem(id: 999) {
              id
            }
          }
        `
      )

      expect(body.errors[0].message).toContain('Unable to find TodoItemDTO with id: 999')
    })

    it('should filter, sort and page', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItems(
              filter: { completed: { is: false } }
              sorting: [{ field: priority, direction: DESC }]
              paging: { first: 2 }
            ) {
              totalCount
              edges {
                node {
                  title
                  priority
                }
              }
            }
          }
        `
      )

      expect(body.data.todoItems.totalCount).toBe(4)
      expect(asList<Edge<{ priority: number }>>(body.data.todoItems.edges).map((e) => e.node.priority)).toEqual([4, 3])
    })

    it('should OR multiple operators on a single field', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItems(filter: { priority: { lt: 1, gt: 3 } }) {
              totalCount
            }
          }
        `
      )

      // priority < 1 OR priority > 3 -> priorities 0 and 4
      expect(body.data.todoItems.totalCount).toBe(2)
    })

    it('should filter by a has-many relation without duplicating parents', async () => {
      // Two sub tasks, but they belong to two distinct todo items -- an EXISTS keeps the parent count honest where
      // a join would return one row per matching child.
      const body = await graphql(
        app,
        `
          {
            todoItems(
              filter: { subTasks: { title: { in: ["Create Nest App - Sub Task 1", "Create Nest App - Sub Task 2"] } } }
              sorting: [{ field: id, direction: ASC }]
            ) {
              totalCount
              edges {
                node {
                  id
                  title
                }
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      expect(body.data.todoItems.totalCount).toBe(1)
      expect(asList<Edge<{ title: string }>>(body.data.todoItems.edges).map((edge) => edge.node.title)).toEqual([
        'Create Nest App'
      ])
    })

    it('should filter by a many-to-many relation through the junction table', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItems(filter: { tags: { name: { eq: "Work" } } }, sorting: [{ field: id, direction: ASC }]) {
              totalCount
              edges {
                node {
                  id
                }
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      // Tag 3 ("Work") is attached to todo items 2 and 3.
      expect(body.data.todoItems.totalCount).toBe(2)
      expect(asList<Edge<{ id: string }>>(body.data.todoItems.edges).map((edge) => edge.node.id)).toEqual(['2', '3'])
    })

    it('should honour a relation`s predefined `where` inside a relation filter', async () => {
      // Sub task 2 of todo item 1 is *not* completed, so it is outside `completedSubTasks` even though it matches
      // the title. This is the assertion that catches a predefined `where` rendered against the unaliased table.
      const body = await graphql(
        app,
        `
          {
            viaCompleted: todoItems(filter: { completedSubTasks: { title: { eq: "Create Nest App - Sub Task 2" } } }) {
              totalCount
            }
            viaAll: todoItems(filter: { subTasks: { title: { eq: "Create Nest App - Sub Task 2" } } }) {
              totalCount
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      expect(body.data.viaCompleted.totalCount).toBe(0)
      expect(body.data.viaAll.totalCount).toBe(1)
    })

    it('should combine relation filters with column filters and `or`', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItems(
              filter: { completed: { is: false }, or: [{ tags: { name: { eq: "Work" } } }, { title: { eq: "Create Entity" } }] }
              sorting: [{ field: id, direction: ASC }]
            ) {
              totalCount
              edges {
                node {
                  id
                }
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      expect(asList<Edge<{ id: string }>>(body.data.todoItems.edges).map((edge) => edge.node.id)).toEqual(['2', '3'])
    })

    it('should filter by a belongs-to relation', async () => {
      const body = await graphql(
        app,
        `
          {
            subTasks(filter: { todoItem: { title: { like: "Create Entity%" } } }) {
              totalCount
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      // "Create Entity" and "Create Entity Service", three sub tasks each.
      expect(body.data.subTasks.totalCount).toBe(6)
    })

    it('should filter by the reverse side of the many-to-many', async () => {
      const body = await graphql(
        app,
        `
          {
            tags(filter: { todoItems: { title: { like: "Create Entity%" } } }, sorting: [{ field: id, direction: ASC }]) {
              totalCount
              edges {
                node {
                  name
                }
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      // Todo items 2 and 3 carry tags 1, 3 and 5 between them -- distinct, not one row per junction match.
      expect(asList<Edge<{ name: string }>>(body.data.tags.edges).map((edge) => edge.node.name)).toEqual([
        'Urgent',
        'Work',
        'Blocked'
      ])
      expect(body.data.tags.totalCount).toBe(3)
    })

    it('should treat an empty relation filter as no constraint', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItems(filter: { subTasks: {} }) {
              totalCount
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      // Parity with query-typeorm, whose left join keeps every parent when the relation filter carries no predicate.
      expect(body.data.todoItems.totalCount).toBe(5)
    })

    it('should aggregate', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItemAggregate {
              count {
                id
              }
              sum {
                priority
              }
              avg {
                priority
              }
              max {
                priority
              }
            }
          }
        `
      )

      const [agg] = body.data.todoItemAggregate
      expect(agg.count.id).toBe(5)
      expect(agg.sum.priority).toBe(10)
      expect(agg.avg.priority).toBe(2)
      expect(agg.max.priority).toBe(4)
    })

    it('should group an aggregate', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItemAggregate(filter: {}) {
              groupBy {
                completed
              }
              count {
                id
              }
            }
          }
        `
      )

      const byCompleted = Object.fromEntries(
        asList<{ groupBy: { completed: boolean }; count: { id: number } }>(body.data.todoItemAggregate).map((a) => [
          String(a.groupBy.completed),
          a.count.id
        ])
      )
      expect(byCompleted).toEqual({ true: 1, false: 4 })
    })

    it('should bucket a date groupBy into a DateTime, not null', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItemAggregate(filter: {}) {
              groupBy {
                created(by: DAY)
              }
              count {
                id
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      // Every fixture row is inserted with `created = now()`, so they all land in one bucket at midnight.
      const groups = asList<{ groupBy: { created: string | null }; count: { id: number } }>(body.data.todoItemAggregate)
      expect(groups).toHaveLength(1)
      expect(groups[0].count.id).toBe(5)
      expect(groups[0].groupBy.created).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
    })
  })

  describe('mutations', () => {
    it('should create, update and delete', async () => {
      const created = await graphql(
        app,
        `
          mutation {
            createOneTodoItem(input: { todoItem: { title: "New Item", priority: 9 } }) {
              id
              title
              priority
            }
          }
        `
      )
      const id = created.data.createOneTodoItem.id
      expect(created.data.createOneTodoItem).toEqual({ id, title: 'New Item', priority: 9 })

      const updated = await graphql(
        app,
        `mutation { updateOneTodoItem(input: { id: ${id}, update: { title: "Renamed" } }) { id title } }`
      )
      expect(updated.data.updateOneTodoItem.title).toBe('Renamed')

      const deleted = await graphql(app, `mutation { deleteOneTodoItem(input: { id: ${id} }) { title } }`)
      expect(deleted.data.deleteOneTodoItem.title).toBe('Renamed')

      const body = await graphql(app, `{ todoItem(id: ${id}) { id } }`)
      expect(body.errors[0].message).toContain(`Unable to find TodoItemDTO with id: ${id}`)
    })

    it('should treat an empty update as a no-op', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            updateOneTodoItem(input: { id: 1, update: {} }) {
              id
              title
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      expect(body.data.updateOneTodoItem).toEqual({ id: '1', title: 'Create Nest App' })
    })

    it('should report how many rows updateMany touched', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            updateManyTodoItems(input: { filter: { completed: { is: false } }, update: { completed: true } }) {
              updatedCount
            }
          }
        `
      )

      expect(body.data.updateManyTodoItems.updatedCount).toBe(4)
    })

    it('should report how many rows deleteMany touched', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            deleteManyTodoItems(input: { filter: { priority: { gte: 3 } } }) {
              deletedCount
            }
          }
        `
      )

      expect(body.data.deleteManyTodoItems.deletedCount).toBe(2)
    })
  })

  describe('relations', () => {
    it('should read a has-many relation with per-parent paging', async () => {
      const querySpy = jest.spyOn(app.get(Pool), 'query')
      const body = await graphql(
        app,
        `
          {
            todoItems(paging: { first: 2 }, sorting: [{ field: id, direction: ASC }]) {
              edges {
                node {
                  id
                  title
                  subTasks(paging: { first: 2 }) {
                    totalCount
                    edges {
                      node {
                        title
                      }
                    }
                  }
                }
              }
            }
          }
        `
      )

      const nodes = asList<Edge<{ subTasks: { edges: unknown[]; totalCount: number } }>>(body.data.todoItems.edges).map(
        (e) => e.node
      )
      expect(nodes).toHaveLength(2)
      // Each parent gets its own limit of 2, rather than 2 rows shared across both parents.
      for (const node of nodes) {
        expect(node.subTasks.edges).toHaveLength(2)
        expect(node.subTasks.totalCount).toBe(3)
      }

      // Parent rows, all relation rows and all relation counts: the number of SQL statements stays constant as
      // the number of parents grows.
      expect(querySpy).toHaveBeenCalledTimes(3)
      querySpy.mockRestore()
    })

    it('should read a belongs-to relation', async () => {
      const body = await graphql(
        app,
        `
          {
            subTask(id: 1) {
              title
              todoItem {
                id
                title
              }
            }
          }
        `
      )

      expect(body.data.subTask.todoItem).toEqual({ id: '1', title: 'Create Nest App' })
    })

    it('should read a many-to-many relation through the junction table', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItem(id: 1) {
              tags(sorting: [{ field: name, direction: ASC }]) {
                edges {
                  node {
                    name
                  }
                }
              }
            }
          }
        `
      )

      expect(asList<Edge<{ name: string }>>(body.data.todoItem.tags.edges).map((e) => e.node.name)).toEqual(['Home', 'Urgent'])
    })

    it('should batch through-relation counts across parents', async () => {
      const querySpy = jest.spyOn(app.get(Pool), 'query')
      const body = await graphql(
        app,
        `
          {
            todoItems(paging: { first: 2 }, sorting: [{ field: id, direction: ASC }]) {
              edges {
                node {
                  tags {
                    totalCount
                  }
                }
              }
            }
          }
        `
      )

      expect(
        asList<Edge<{ tags: { totalCount: number } }>>(body.data.todoItems.edges).map((e) => e.node.tags.totalCount)
      ).toEqual([2, 2])
      const queryCount = querySpy.mock.calls.length
      querySpy.mockRestore()
      expect(queryCount).toBe(3)
    })

    it('should batch direct and through relation aggregates on the real PostgreSQL driver', async () => {
      const querySpy = jest.spyOn(app.get(Pool), 'query')
      const body = await graphql(
        app,
        `
          {
            todoItems(paging: { first: 2 }, sorting: [{ field: id, direction: ASC }]) {
              edges {
                node {
                  subTasksAggregate {
                    groupBy {
                      completed
                    }
                    count {
                      id
                    }
                  }
                  tagsAggregate {
                    count {
                      id
                    }
                  }
                }
              }
            }
          }
        `
      )

      const nodes = asList<
        Edge<{
          subTasksAggregate: { groupBy: { completed: boolean }; count: { id: number } }[]
          tagsAggregate: { count: { id: number } }[]
        }>
      >(body.data.todoItems.edges).map((edge) => edge.node)

      for (const node of nodes) {
        expect(node.subTasksAggregate).toEqual(
          expect.arrayContaining([
            { groupBy: { completed: false }, count: { id: 2 } },
            { groupBy: { completed: true }, count: { id: 1 } }
          ])
        )
        expect(node.tagsAggregate).toEqual([{ count: { id: 2 } }])
      }
      const queryCount = querySpy.mock.calls.length
      querySpy.mockRestore()
      expect(queryCount).toBe(3)
    })

    it('should honour a relation`s predefined `where` across read, count and aggregate alike', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItems(paging: { first: 2 }, sorting: [{ field: id, direction: ASC }]) {
              edges {
                node {
                  subTasks(paging: { first: 10 }) {
                    totalCount
                  }
                  completedSubTasks(paging: { first: 10 }) {
                    totalCount
                    edges {
                      node {
                        completed
                      }
                    }
                  }
                  completedSubTasksAggregate {
                    count {
                      id
                    }
                  }
                }
              }
            }
          }
        `
      )

      const nodes = asList<
        Edge<{
          subTasks: { totalCount: number }
          completedSubTasks: { totalCount: number; edges: Edge<{ completed: boolean }>[] }
          completedSubTasksAggregate: { count: { id: number } }[]
        }>
      >(body.data.todoItems.edges).map((edge) => edge.node)

      expect(nodes).toHaveLength(2)
      for (const node of nodes) {
        // The unfiltered relation sees all three; the filtered one only the single completed sub task, and the
        // count and aggregate paths -- which build their SQL by hand -- have to arrive at the same number.
        expect(node.subTasks.totalCount).toBe(3)
        expect(node.completedSubTasks.totalCount).toBe(1)
        expect(node.completedSubTasks.edges).toEqual([{ node: { completed: true } }])
        expect(node.completedSubTasksAggregate).toEqual([{ count: { id: 1 } }])
      }
    })

    it('should read the reverse side of the many-to-many', async () => {
      const body = await graphql(
        app,
        `
          {
            tag(id: 1) {
              name
              todoItems {
                totalCount
              }
            }
          }
        `
      )

      expect(body.data.tag).toEqual({ name: 'Urgent', todoItems: { totalCount: 2 } })
    })

    it('should filter a relation connection by the related table`s own relation', async () => {
      // `SubTaskFilter` offers `todoItem`, so the generated `subTasks` connection accepts it too.
      const body = await graphql(
        app,
        `
          {
            todoItems(filter: { id: { in: [1, 2] } }, sorting: [{ field: id, direction: ASC }]) {
              edges {
                node {
                  id
                  subTasks(filter: { todoItem: { title: { eq: "Create Nest App" } } }) {
                    totalCount
                    edges {
                      node {
                        id
                      }
                    }
                  }
                  subTasksAggregate(filter: { todoItem: { title: { eq: "Create Nest App" } } }) {
                    count {
                      id
                    }
                  }
                  tags(filter: { todoItems: { title: { eq: "Create Entity" } } }) {
                    totalCount
                  }
                }
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      const nodes = asList<
        Edge<{
          id: string
          subTasks: { totalCount: number; edges: Edge<{ id: string }>[] }
          subTasksAggregate: { count: { id: number } }[]
          tags: { totalCount: number }
        }>
      >(body.data.todoItems.edges).map((edge) => edge.node)

      expect(nodes.map((node) => node.subTasks.edges.map((edge) => edge.node.id))).toEqual([['1', '2', '3'], []])
      expect(nodes.map((node) => node.subTasks.totalCount)).toEqual([3, 0])
      expect(nodes.map((node) => node.subTasksAggregate[0]?.count.id ?? 0)).toEqual([3, 0])
      // Tag "Urgent" (1) is on both items 1 and 2 ("Create Entity"), "Home" (2) only on item 1.
      expect(nodes.map((node) => node.tags.totalCount)).toEqual([1, 2])
    })

    it('should filter a relation', async () => {
      const body = await graphql(
        app,
        `
          {
            todoItem(id: 1) {
              subTasks(filter: { completed: { is: true } }) {
                totalCount
              }
            }
          }
        `
      )

      expect(body.data.todoItem.subTasks.totalCount).toBe(1)
    })

    it('should add and remove rows on a junction table', async () => {
      const added = await graphql(
        app,
        `
          mutation {
            addTagsToTodoItem(input: { id: 1, relationIds: [3] }) {
              tags {
                totalCount
              }
            }
          }
        `
      )
      expect(added.data.addTagsToTodoItem.tags.totalCount).toBe(3)

      const removed = await graphql(
        app,
        `
          mutation {
            removeTagsFromTodoItem(input: { id: 1, relationIds: [3] }) {
              tags {
                totalCount
              }
            }
          }
        `
      )
      expect(removed.data.removeTagsFromTodoItem.tags.totalCount).toBe(2)
    })

    it('should make repeated junction additions idempotent', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            addTagsToTodoItem(input: { id: 1, relationIds: [1] }) {
              tags {
                totalCount
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()
      expect(body.data.addTagsToTodoItem.tags.totalCount).toBe(2)
    })

    it('should replace all rows through setRelations', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            setTagsOnTodoItem(input: { id: 1, relationIds: [2, 3] }) {
              tags(sorting: [{ field: name, direction: ASC }]) {
                edges {
                  node {
                    name
                  }
                }
              }
            }
          }
        `
      )

      expect(asList<Edge<{ name: string }>>(body.data.setTagsOnTodoItem.tags.edges).map((edge) => edge.node.name)).toEqual([
        'Home',
        'Work'
      ])
    })

    it('should keep a filtered relation`s detach inside the relation when replacing it', async () => {
      // Sub tasks 1-3 belong to todo item 1 and only 1 is completed; sub task 4 is todo item 2's completed one.
      const body = await graphql(
        app,
        `
          mutation {
            setCompletedSubTasksOnTodoItem(input: { id: 1, relationIds: [4] }) {
              subTasks(paging: { first: 10 }, sorting: [{ field: id, direction: ASC }]) {
                edges {
                  node {
                    id
                    completed
                  }
                }
              }
              completedSubTasks(paging: { first: 10 }) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          }
        `
      )

      expect(body.errors).toBeUndefined()

      const result = body.data.setCompletedSubTasksOnTodoItem as {
        subTasks: { edges: Edge<{ id: string; completed: boolean }>[] }
        completedSubTasks: { edges: Edge<{ id: string }>[] }
      }

      // Sub task 1 was detached and 4 attached, but the *incomplete* 2 and 3 were never part of this relation and
      // must still point at todo item 1.
      expect(result.subTasks.edges.map((edge) => edge.node.id)).toEqual(['2', '3', '4'])
      expect(result.completedSubTasks.edges.map((edge) => edge.node.id)).toEqual(['4'])
    })

    it('should leave rows outside the relationFilter attached when replacing a relation', async () => {
      // What an authorizer passes down: the caller may only see completed sub tasks. Sub tasks 1-3 belong to todo
      // item 1 and only 1 is completed; sub task 4 is todo item 2's completed one.
      const todoItems = app.get<QueryService<TodoItemDTO>>(getQueryServiceToken(TodoItemDTO))

      await todoItems.setRelations<SubTaskDTO>('subTasks', 1, [4], { relationFilter: { completed: { is: true } } })

      const subTasks = await todoItems.queryRelations(SubTaskDTO, 'subTasks', { id: 1 } as TodoItemDTO, {
        sorting: [{ field: 'id', direction: SortDirection.ASC }]
      })
      expect(subTasks.map((subTask) => subTask.id)).toEqual([2, 3, 4])
    })

    it('should repoint a belongs-to relation', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            setTodoItemOnSubTask(input: { id: 1, relationId: 2 }) {
              id
              todoItem {
                id
                title
              }
            }
          }
        `
      )

      expect(body.data.setTodoItemOnSubTask.todoItem).toEqual({ id: '2', title: 'Create Entity' })
    })

    it('should reject relation ids that do not exist', async () => {
      const body = await graphql(
        app,
        `
          mutation {
            addTagsToTodoItem(input: { id: 1, relationIds: [999] }) {
              id
            }
          }
        `
      )

      expect(body.errors[0].message).toContain('Unable to find all tags')
    })
  })
})
