import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeUniformJsonArray } from '../governance.js'

/** Decode the encoder's TSV back to JSON data (test-side inverse). */
function decodeTsv(encoded) {
  const lines = encoded.split('\n')
  assert.ok(lines[0].startsWith('#tsv lossless'), 'meta header')
  const fields = lines[1].split('\t')
  const rows = lines.slice(2).map((line) => {
    const cells = line.split('\t')
    const row = {}
    for (let i = 0; i < fields.length; i += 1) {
      const cell = cells[i]
      if (cell === '\\N') row[fields[i]] = null
      else if (/^(true|false)$/.test(cell)) row[fields[i]] = cell === 'true'
      else if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(cell)) row[fields[i]] = Number(cell)
      else row[fields[i]] = cell
    }
    return row
  })
  return rows
}

const rows = []
for (let i = 0; i < 20; i += 1) {
  rows.push({
    id: i + 1,
    model: `model-${i + 1}`,
    hit: Number((0.02 + i * 0.001).toFixed(4)),
    miss: Number((1 + i * 0.1).toFixed(2)),
    active: i % 2 === 0,
    note: i === 3 ? null : `note-${i + 1}`,
  })
}

test('uniform array JSON -> TSV is lossless and smaller', () => {
  const json = JSON.stringify(rows)
  const encoded = encodeUniformJsonArray(json, { minRows: 4, minSavingRatio: 0.2 })
  assert.ok(encoded !== null)
  assert.ok(encoded.after < encoded.before)
  assert.match(encoded.text, /^#tsv lossless rows=20 fields=id,model,hit,miss,active,note/)
  assert.deepEqual(decodeTsv(encoded.text), rows)
})

test('wrapper object with a single array is preserved', () => {
  const payload = { prices: rows }
  const encoded = encodeUniformJsonArray(JSON.stringify(payload), { minRows: 4, minSavingRatio: 0.2 })
  assert.ok(encoded !== null)
  assert.match(encoded.text, /wrapper=prices/)
  assert.deepEqual(decodeTsv(encoded.text), rows)
})

test('rejects ambiguous or non-uniform inputs', () => {
  // too few rows
  assert.equal(encodeUniformJsonArray(JSON.stringify(rows.slice(0, 2)), { minRows: 4 }), null)
  // heterogeneous keys
  const heterogeneous = rows.map((row, index) => (index === 0 ? { ...row, extra: 1 } : row))
  assert.equal(encodeUniformJsonArray(JSON.stringify(heterogeneous)), null)
  // tabs/newlines inside strings cannot be encoded losslessly
  const withTab = rows.map((row, index) => (index === 0 ? { ...row, note: 'a\tb' } : row))
  assert.equal(encodeUniformJsonArray(JSON.stringify(withTab)), null)
  // one level of nested objects is flattened losslessly
  const nested = rows.map((row, index) => (index === 0 ? { ...row, note: { deep: true } } : row))
  assert.equal(encodeUniformJsonArray(JSON.stringify(nested)), null)
  // nested objects are flattened instead of rejected
  const flatNested = rows.map((row, index) => (index === 0 ? { ...row, meta: { deep: 'x' } } : { ...row, meta: { deep: 'y' } }))
  const encodedNested = encodeUniformJsonArray(JSON.stringify(flatNested), { minRows: 4, minSavingRatio: 0.2 })
  assert.ok(encodedNested !== null)
  assert.match(encodedNested.text, /meta\.deep/)
  // JSONL input is treated as an array of rows
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n')
  const encodedJsonl = encodeUniformJsonArray(jsonl, { minRows: 4, minSavingRatio: 0.2 })
  assert.ok(encodedJsonl !== null)
  assert.deepEqual(decodeTsv(encodedJsonl.text), rows)
  // non-JSON text
  assert.equal(encodeUniformJsonArray('plain log line\nanother line'), null)
  // not worth the saving
  assert.equal(encodeUniformJsonArray(JSON.stringify(rows), { minRows: 4, minSavingRatio: 0.99 }), null)
})
