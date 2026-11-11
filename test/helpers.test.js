import test from 'node:test'
import assert from 'node:assert/strict'
import { changedToolLines, lineSimilarity, normalizeToolLine } from '../governance.js'

test('normalizeToolLine strips volatile tokens but keeps metrics', () => {
  const a = normalizeToolLine('2026-11-11T03:00:00Z job 1234 took 17ms id deadbeefdeadbeef')
  const b = normalizeToolLine('2026-11-12T04:05:06Z job 1234 took 17ms id 0123456789ab')
  assert.equal(a, b)
  assert.match(a, /job 1234 took 17ms/)
})

test('lineSimilarity and changedToolLines detect small edits', () => {
  const previous = ['a', 'b', 'c', 'd']
  const current = ['a', 'b', 'c', 'e']
  assert.ok(lineSimilarity(current, previous) > 0.5)
  assert.ok(lineSimilarity(current, previous) < 0.8)
  assert.deepEqual(changedToolLines(current, previous, 5), ['e'])
  assert.equal(lineSimilarity([], []), 1)
})
