import { expect, test } from 'bun:test'
import { PACKAGE } from './index'

test('the library reports its own package name', () => {
  expect(PACKAGE).toBe('__NAME__')
})
