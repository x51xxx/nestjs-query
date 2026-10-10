import * as drizzleOrm from 'drizzle-orm'

import { isEmptyRelationsFilter, toDrizzleRelationsFilter } from '../../src/query/drizzle-compat.utils'

type Compat = typeof import('../../src/query/drizzle-compat.utils')

/** Re-imports the module against a stubbed `drizzle-orm`, so the rc.5 branch can run on an rc.4 install. */
const loadWithEmptyFilter = async (emptyFilter: symbol): Promise<Compat> => {
  let compat: Compat | undefined

  await jest.isolateModulesAsync(async () => {
    jest.doMock('drizzle-orm', () => ({ ...jest.requireActual<object>('drizzle-orm'), EmptyFilter: emptyFilter }))
    compat = await import('../../src/query/drizzle-compat.utils')
  })

  jest.dontMock('drizzle-orm')

  if (!compat) {
    throw new Error('failed to re-import drizzle-compat.utils')
  }

  return compat
}

describe('Drizzle relations compatibility', () => {
  describe('against the installed Drizzle', () => {
    it('should recognize rc.4 undefined and only the actual newer EmptyFilter export', () => {
      const emptyFilter = (drizzleOrm as unknown as { EmptyFilter?: symbol }).EmptyFilter

      expect(isEmptyRelationsFilter(undefined)).toBe(true)
      expect(isEmptyRelationsFilter(Symbol.for('drizzle:EmptyFilter'))).toBe(emptyFilter === Symbol.for('drizzle:EmptyFilter'))
      expect(isEmptyRelationsFilter(emptyFilter)).toBe(true)
      expect(isEmptyRelationsFilter({})).toBe(false)
    })

    it('should default an absent filter to whatever the installed Drizzle understands as empty', () => {
      const emptyFilter = (drizzleOrm as unknown as { EmptyFilter?: symbol }).EmptyFilter

      // rc.4 has no sentinel and accepts `undefined`; rc.5 rejects `undefined` in filters and wants the sentinel.
      expect(toDrizzleRelationsFilter(undefined)).toBe(emptyFilter)
      expect(toDrizzleRelationsFilter({ id: 1 })).toEqual({ id: 1 })
    })
  })

  /**
   * The peer range allows rc.5, whose sentinel is a unique symbol rather than `Symbol.for(...)`. Comparing against a
   * guessed registry key would reject *every* relation as declaring a predefined `where`, so the sentinel branch is
   * exercised here rather than left to whichever RC happens to be installed.
   */
  describe('against an rc.5 Drizzle exporting EmptyFilter', () => {
    const emptyFilter = Symbol('drizzle:EmptyFilter')

    it('should treat the exported sentinel as an empty filter', async () => {
      const compat = await loadWithEmptyFilter(emptyFilter)

      expect(compat.isEmptyRelationsFilter(emptyFilter)).toBe(true)
      expect(compat.isEmptyRelationsFilter(undefined)).toBe(true)
    })

    it('should not accept a same-keyed symbol that is not the export', async () => {
      const compat = await loadWithEmptyFilter(emptyFilter)

      expect(compat.isEmptyRelationsFilter(Symbol.for('drizzle:EmptyFilter'))).toBe(false)
      expect(compat.isEmptyRelationsFilter({})).toBe(false)
    })

    it('should default an absent filter to the sentinel instead of undefined', async () => {
      const compat = await loadWithEmptyFilter(emptyFilter)

      expect(compat.toDrizzleRelationsFilter(undefined)).toBe(emptyFilter)
      expect(compat.toDrizzleRelationsFilter({ id: 1 })).toEqual({ id: 1 })
    })
  })
})
