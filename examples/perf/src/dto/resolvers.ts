import {
  CreateSubTaskInput,
  CreateTagInput,
  CreateTodoItemInput,
  UpdateSubTaskInput,
  UpdateTagInput,
  UpdateTodoItemInput
} from './inputs'

export interface ResolverSpec {
  /** Key used by an adapter to find its own entity/table for this DTO. */
  key: 'todoItem' | 'subTask' | 'tag'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  CreateDTOClass: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UpdateDTOClass: any
}

/**
 * Single source of truth for resolver options, so no adapter can accidentally expose a different API surface and
 * make the comparison meaningless. `run-adapter.ts` additionally diffs the generated schemas as a hard check.
 */
export const RESOLVER_SPECS: ResolverSpec[] = [
  { key: 'todoItem', CreateDTOClass: CreateTodoItemInput, UpdateDTOClass: UpdateTodoItemInput },
  { key: 'subTask', CreateDTOClass: CreateSubTaskInput, UpdateDTOClass: UpdateSubTaskInput },
  { key: 'tag', CreateDTOClass: CreateTagInput, UpdateDTOClass: UpdateTagInput }
]
