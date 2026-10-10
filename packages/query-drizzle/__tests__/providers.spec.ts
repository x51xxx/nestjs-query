import { getQueryServiceToken } from '@ptc-org/nestjs-query-core'

import { createDrizzleQueryServiceProviders } from '../src/providers'
import { DrizzleQueryService } from '../src/services'
import { createStubDb } from './__fixtures__/db.fixture'
import { testRelations } from './__fixtures__/relations.fixture'
import { TestEntityDTO } from './__fixtures__/test-table'

const DB_TOKEN = 'TEST_DB'

describe('createDrizzleQueryServiceProviders', () => {
  it('should create a provider for the entity keyed by the DTO class', () => {
    const providers = createDrizzleQueryServiceProviders(
      [{ DTOClass: TestEntityDTO, tableName: 'testTable' }],
      DB_TOKEN,
      testRelations
    )

    expect(providers).toHaveLength(1)
    expect(providers[0].provide).toBe(getQueryServiceToken(TestEntityDTO))
    expect(providers[0].inject).toEqual([DB_TOKEN])

    const service = (providers[0].useFactory as (db: unknown) => DrizzleQueryService<TestEntityDTO>)(createStubDb().db)
    expect(service).toBeInstanceOf(DrizzleQueryService)
    expect(service.EntityClass).toBe(TestEntityDTO)
    expect(service.tableConfig).toBe(testRelations.testTable)
  })

  it('should pass relation ownership overrides to the service', () => {
    const providers = createDrizzleQueryServiceProviders(
      [
        {
          DTOClass: TestEntityDTO,
          tableName: 'testTable',
          relationOptions: { testRelations: { foreignKeySide: 'target' as const } }
        }
      ],
      DB_TOKEN,
      testRelations
    )
    const service = (providers[0].useFactory as (db: unknown) => DrizzleQueryService<TestEntityDTO>)(createStubDb().db)

    expect(service.relationOptions).toEqual({ testRelations: { foreignKeySide: 'target' } })
  })

  it('should create one provider per model', () => {
    const providers = createDrizzleQueryServiceProviders(
      [
        { DTOClass: TestEntityDTO, tableName: 'testTable' },
        { DTOClass: class OtherDTO {}, tableName: 'testTable' }
      ],
      DB_TOKEN,
      testRelations
    )

    expect(providers).toHaveLength(2)
  })
})
