import { Connection, Types } from 'mongoose'

import { SeedSizes } from '../adapter'

export const MONGO_DATABASE = process.env.PERF_MONGO_DATABASE ?? 'perf'
export const MONGO_URI = process.env.PERF_MONGO_URI ?? `mongodb://localhost/${MONGO_DATABASE}`

/** Documents per insert batch -- keeps peak heap flat regardless of dataset size. */
const BATCH = 10_000

/**
 * Re-seeding millions of documents on every run makes large datasets impractical to iterate on, so an existing
 * dataset of the right size is reused. `PERF_RESEED=1` forces a rebuild.
 */
const isAlreadySeeded = async (connection: Connection, sizes: SeedSizes): Promise<boolean> => {
  if (process.env.PERF_RESEED) {
    return false
  }

  const db = connection.db
  const [todoCount, subTaskCount, tagCount] = await Promise.all([
    db.collection('todo_item').countDocuments(),
    db.collection('sub_task').countDocuments(),
    db.collection('tag').countDocuments()
  ])

  // The mutation scenario adds and removes rows, so the todo count is allowed to drift slightly.
  const todoMatches = Math.abs(todoCount - sizes.todoItems) <= sizes.todoItems * 0.01

  return todoMatches && subTaskCount === sizes.todoItems * sizes.subTasksPerItem && tagCount === sizes.tags
}

/**
 * Seeds the document adapters with data equivalent to the SQL ones.
 *
 * Inserts go straight through the driver, never through mongoose models or the nestjs-query service, so the code
 * path under test does not leak into setup time. Indexes mirror the SQL adapters' so that neither side of the
 * comparison is handicapped by a missing index.
 *
 * Documents are generated and inserted in batches: materialising every sub task up front is millions of objects on
 * the JS heap at the sizes this benchmark is meant to run at.
 */
export const seedMongo = async (connection: Connection, sizes: SeedSizes): Promise<void> => {
  const { todoItems, subTasksPerItem, tags, tagsPerItem } = sizes

  // `TypegooseModule.forRoot` returns before the socket is open, so `connection.db` can still be undefined here.
  if (!connection.db) {
    await connection.asPromise()
  }

  const db = connection.db
  const todoCollection = db.collection('todo_item')
  const subTaskCollection = db.collection('sub_task')
  const tagCollection = db.collection('tag')

  // Indexes are ensured on every run, before the data check: `createIndex` is idempotent, and skipping it along
  // with the data would silently benchmark a reused dataset against a stale index set.
  const ensureIndexes = async (): Promise<void> => {
    // Older benchmark schemas declared `priority` as independently indexed. Remove that stale index as well as
    // avoiding its recreation, otherwise reused Mongo datasets would still carry more write overhead than SQL.
    const indexes = await todoCollection.indexes()
    const standalonePriorityIndexes = indexes.filter(
      ({ key }) => Object.keys(key).length === 1 && Object.prototype.hasOwnProperty.call(key, 'priority')
    )

    await Promise.all(standalonePriorityIndexes.map(({ name }) => todoCollection.dropIndex(name)))
    await Promise.all([
      // Mirrors the SQL adapters' composite index: every read scenario filters on completed + priority, and an
      // index covering only `priority` would leave `completed` to be checked per document.
      todoCollection.createIndex({ completed: 1, priority: 1 }),
      todoCollection.createIndex({ tags: 1 }),
      subTaskCollection.createIndex({ todoItem: 1 })
    ])
  }

  if (await isAlreadySeeded(connection, sizes)) {
    await ensureIndexes()

    return
  }

  await Promise.all([todoCollection.deleteMany({}), subTaskCollection.deleteMany({}), tagCollection.deleteMany({})])

  const tagIds = Array.from({ length: tags }, () => new Types.ObjectId())
  await tagCollection.insertMany(tagIds.map((_id, index) => ({ _id, name: `Tag ${index + 1}` })))

  for (let start = 0; start < todoItems; start += BATCH) {
    const size = Math.min(BATCH, todoItems - start)
    const todoDocs = Array.from({ length: size }, (_, offset) => {
      const n = start + offset + 1

      return {
        _id: new Types.ObjectId(),
        title: `Todo Item ${n}`,
        completed: n % 4 === 0,
        priority: n % 10,
        // Same deterministic spread as the SQL adapters' junction rows.
        tags: Array.from({ length: tagsPerItem }, (__, s) => tagIds[(n * 7 + (s + 1) * 13) % tags])
      }
    })

    await todoCollection.insertMany(todoDocs)
    await subTaskCollection.insertMany(
      todoDocs.flatMap((todo) =>
        Array.from({ length: subTasksPerItem }, (_, s) => ({
          _id: new Types.ObjectId(),
          title: `${todo.title} - Sub Task ${s + 1}`,
          completed: s === 0,
          todoItem: todo._id
        }))
      )
    )
  }

  await ensureIndexes()
}
