/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-var-requires, global-require */
import { PerfAdapter } from './adapter'

/**
 * Adapters are required lazily by name, never imported eagerly: each one pulls in its own ORM and registers its
 * own entity metadata, and a single process should only ever load the one it is benchmarking.
 */
const ADAPTERS: Record<string, () => PerfAdapter> = {
  drizzle: () => require('./adapters/drizzle').drizzleAdapter as PerfAdapter,
  typeorm: () => require('./adapters/typeorm').typeormAdapter as PerfAdapter,
  sequelize: () => require('./adapters/sequelize').sequelizeAdapter as PerfAdapter,
  mongoose: () => require('./adapters/mongoose').mongooseAdapter as PerfAdapter,
  typegoose: () => require('./adapters/typegoose').typegooseAdapter as PerfAdapter
}

export const ADAPTER_NAMES = Object.keys(ADAPTERS)

export const getAdapter = (name: string): PerfAdapter => {
  const factory = ADAPTERS[name]

  if (!factory) {
    throw new Error(`Unknown adapter "${name}". Available: ${ADAPTER_NAMES.join(', ')}`)
  }

  return factory()
}
