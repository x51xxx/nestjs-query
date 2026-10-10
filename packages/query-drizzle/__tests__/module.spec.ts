import { getQueryServiceToken } from '@ptc-org/nestjs-query-core'

import { NestjsQueryDrizzleModule } from '../src/module'
import { testRelations } from './__fixtures__/relations.fixture'
import { TestEntityDTO } from './__fixtures__/test-table'

describe('NestjsQueryDrizzleModule', () => {
  it('should create a dynamic module with a query service provider per model', () => {
    const dynamicModule = NestjsQueryDrizzleModule.forFeature([{ DTOClass: TestEntityDTO, tableName: 'testTable' }], {
      dbToken: 'TEST_DB',
      relations: testRelations
    })

    expect(dynamicModule.module).toBe(NestjsQueryDrizzleModule)
    expect(dynamicModule.providers).toHaveLength(1)
    expect(dynamicModule.providers?.[0]).toMatchObject({ provide: getQueryServiceToken(TestEntityDTO) })
    expect(dynamicModule.exports).toEqual(dynamicModule.providers)
  })

  it('should forward imports that provide the database token', () => {
    class DatabaseModule {}
    const dynamicModule = NestjsQueryDrizzleModule.forFeature([{ DTOClass: TestEntityDTO, tableName: 'testTable' }], {
      imports: [DatabaseModule],
      dbToken: 'TEST_DB',
      relations: testRelations
    })

    expect(dynamicModule.imports).toEqual([DatabaseModule])
  })
})
