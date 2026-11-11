import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRICE_VERSION, PRICES_CNY, addRequest, beijingClock, cacheAnomalyCost, cacheHitPct,
  compactionEconomics, costOfUsage, costSplit, decideEffort, detectCacheAnomaly,
  emptyTotals, formatInt, formatMoney, isPeak, normalizeModelKey, resolvePrices,
  LEDGER_DEFAULT_KEEP_FILES, LEDGER_DEFAULT_MAX_BYTES, ledgerRotationPlan, priceTableAgeDays,
  firstShellToken, isSimpleShellCommand, outputLimitSuffix, sanitizeSwitchOverrides,
} from '../governance.js'

const BEIJING = (y, month, day, hour, minute = 0) => Date.UTC(y, month - 1, day, hour - 8, minute)

test('price version is pinned', () => {
  assert.equal(PRICE_VERSION, '2026-11-11')
})

test('normalizeModelKey maps DeepSeek ids', () => {
  assert.equal(normalizeModelKey('deepseek-flash'), 'deepseek-flash')
  assert.equal(normalizeModelKey('deepseek-ai/deepseek-v4.1-flash'), 'deepseek-flash')
  assert.equal(normalizeModelKey('deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(normalizeModelKey('claude-opus-4'), 'deepseek-v4-pro')
  assert.equal(normalizeModelKey('some-custom-model'), undefined)
})

test('beijingClock shifts UTC to Beijing wall time', () => {
  const clock = beijingClock(BEIJING(2026, 11, 11, 9, 5))
  assert.equal(clock.hour, 9)
  assert.equal(clock.minute, 5)
  assert.equal(clock.dateKey, '2026-11-11')
  assert.equal(clock.day, 3) // Wednesday
})

test('isPeak follows the official peak windows', () => {
  assert.equal(isPeak(BEIJING(2026, 11, 11, 9, 0)), true)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 11, 59)), true)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 12, 0)), false)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 13, 59)), false)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 14, 0)), true)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 17, 59)), true)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 18, 0)), false)
  assert.equal(isPeak(BEIJING(2026, 11, 11, 8, 59)), false)
  // weekend is always off-peak
  assert.equal(isPeak(BEIJING(2026, 11, 14, 10, 0)), false)
  // configured holiday is off-peak
  assert.equal(isPeak(BEIJING(2026, 11, 11, 10, 0), ['2026-11-11']), false)
})

test('resolvePrices returns official per-token CNY prices and tier', () => {
  const peak = resolvePrices('deepseek-flash', BEIJING(2026, 11, 11, 10, 0), { currency: 'CNY' })
  assert.equal(peak.tier, 'peak')
  assert.equal(peak.known, true)
  assert.equal(peak.hit, PRICES_CNY['deepseek-flash'].peak.hit / 1e6)
  assert.equal(peak.miss, PRICES_CNY['deepseek-flash'].peak.miss / 1e6)
  assert.equal(peak.out, PRICES_CNY['deepseek-flash'].peak.out / 1e6)

  const off = resolvePrices('deepseek-v4-pro', BEIJING(2026, 11, 11, 20, 0), { currency: 'CNY' })
  assert.equal(off.tier, 'off')
  assert.equal(off.out, PRICES_CNY['deepseek-v4-pro'].off.out / 1e6)
})

test('resolvePrices supports USD and unknown models', () => {
  const usd = resolvePrices('deepseek-flash', BEIJING(2026, 11, 11, 20, 0), { currency: 'USD' })
  assert.equal(usd.currency, 'USD')
  assert.equal(usd.miss, 0.15 / 1e6)
  const unknown = resolvePrices('minimax-m3', Date.now(), { currency: 'CNY' })
  assert.equal(unknown.known, false)
  assert.equal(unknown.hit, 0)
})

test('resolvePrices applies per-model overrides', () => {
  const overridden = resolvePrices('my-model', BEIJING(2026, 11, 11, 10, 0), {
    currency: 'CNY',
    modelPrices: { 'my-model': { hit: 1, miss: 10, out: 20 } },
  })
  assert.equal(overridden.known, true)
  assert.equal(overridden.hit, 1 / 1e6)
  assert.equal(overridden.out, 20 / 1e6)
  const tiered = resolvePrices('my-model', BEIJING(2026, 11, 11, 20, 0), {
    currency: 'CNY',
    modelPrices: { 'my-model': { peak: { hit: 2, miss: 20, out: 40 }, off: { hit: 1, miss: 10, out: 20 } } },
  })
  assert.equal(tiered.hit, 1 / 1e6)
})

test('costOfUsage prices the three billed buckets', () => {
  const prices = resolvePrices('deepseek-flash', BEIJING(2026, 11, 11, 10, 0), { currency: 'CNY' })
  const cost = costOfUsage({ inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 }, prices)
  assert.equal(cost.missTokens, 1000)
  assert.equal(cost.hitTokens, 2000)
  assert.equal(cost.outputTokens, 500)
  assert.ok(Math.abs(cost.missCost - 1000 * 2e-6) < 1e-12)
  assert.ok(Math.abs(cost.hitCost - 2000 * 4e-8) < 1e-12)
  assert.ok(Math.abs(cost.outCost - 500 * 8e-6) < 1e-12)
  assert.ok(Math.abs(cost.total - (cost.missCost + cost.hitCost + cost.outCost)) < 1e-12)
})

test('format helpers are stable', () => {
  assert.equal(formatInt(1234567), '1,234,567')
  assert.equal(formatMoney(0.5548, 'CNY'), '¥0.5548')
  assert.equal(formatMoney(1.5, 'USD'), '$1.50')
})

test('decideEffort downshifts max on continuation steps only', () => {
  const policy = { enabled: true, continuationEffort: 'high', onlyDownshiftMax: true }
  const max = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }
  assert.deepEqual(decideEffort({ selection: max, phase: 'continuation', policy, originalEffort: 'max' }), {
    reasoningEffort: 'high', reason: 'max->high (continuation)',
  })
  // not max -> never touch
  const high = { ...max, reasoningEffort: 'high' }
  assert.equal(decideEffort({ selection: high, phase: 'continuation', policy, originalEffort: 'high' }), null)
  // disabled
  assert.equal(decideEffort({ selection: max, phase: 'continuation', policy: { ...policy, enabled: false }, originalEffort: 'max' }), null)
  // missing route
  assert.equal(decideEffort({ selection: { reasoningEffort: 'max' }, phase: 'continuation', policy, originalEffort: 'max' }), null)
  // invalid desired effort
  assert.equal(decideEffort({ selection: max, phase: 'continuation', policy: { ...policy, continuationEffort: 'turbo' }, originalEffort: 'max' }), null)
})

test('decideEffort escalates back to the original effort after a failure', () => {
  const policy = { enabled: true, continuationEffort: 'high', onlyDownshiftMax: true }
  const high = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }
  assert.deepEqual(decideEffort({ selection: high, phase: 'escalated', policy, originalEffort: 'max' }), {
    reasoningEffort: 'max', reason: 'high->max (escalated)',
  })
  // already at the original effort: no-op
  assert.equal(decideEffort({ selection: { ...high, reasoningEffort: 'max' }, phase: 'escalated', policy, originalEffort: 'max' }), null)
})

test('decideEffort can downgrade below max when onlyDownshiftMax is off', () => {
  const policy = { enabled: true, continuationEffort: 'low', onlyDownshiftMax: false }
  const high = { provider: 'p', model: 'm', reasoningEffort: 'high' }
  assert.deepEqual(decideEffort({ selection: high, phase: 'continuation', policy, originalEffort: 'max' }), {
    reasoningEffort: 'low', reason: 'high->low (continuation)',
  })
})

test('detectCacheAnomaly flags an unexpected prefix miss', () => {
  const cfg = { minPromptTokens: 5000, hitRateFloor: 0.5 }
  assert.equal(detectCacheAnomaly({ prevPromptTokens: 0, usage: { cacheReadTokens: 0, inputTokens: 100 } }, cfg), null)
  assert.equal(detectCacheAnomaly({ prevPromptTokens: 10000, usage: { cacheReadTokens: 9000, inputTokens: 1200 } }, cfg), null)
  const hit = detectCacheAnomaly({ prevPromptTokens: 10000, usage: { cacheReadTokens: 1000, inputTokens: 11000 } }, cfg)
  assert.equal(hit.extraMissTokens, 9000)
})

test('cacheAnomalyCost prices the miss-vs-hit delta', () => {
  const prices = resolvePrices('deepseek-flash', BEIJING(2026, 11, 11, 20, 0), { currency: 'CNY' })
  const lost = cacheAnomalyCost(100000, prices)
  assert.ok(Math.abs(lost - 100000 * (1e-6 - 2e-8)) < 1e-9)
})

test('totals fold and rates', () => {
  const totals = emptyTotals()
  addRequest(totals, { kind: 'main', missTokens: 1000, hitTokens: 9000, outputTokens: 500, cost: 0.01, missCost: 0.002, hitCost: 0.001, outCost: 0.007, tier: 'off', finish: '' })
  addRequest(totals, { kind: 'aux', missTokens: 100, hitTokens: 0, outputTokens: 50, cost: 0.0005, missCost: 0.0001, hitCost: 0, outCost: 0.0004, tier: 'peak', finish: 'error' })
  assert.equal(totals.requests, 2)
  assert.equal(totals.mainRequests, 1)
  assert.equal(totals.auxRequests, 1)
  assert.equal(totals.finishErrors, 1)
  assert.equal(totals.offPeakRequests, 1)
  assert.equal(totals.peakRequests, 1)
  assert.ok(Math.abs(cacheHitPct(totals) - (9000 / 10100) * 100) < 1e-9)
  const split = costSplit(totals)
  assert.ok(Math.abs(split.missPct + split.hitPct + split.outPct - 100) < 1e-9)
})

test('compactionEconomics matches the flash break-even ballpark', () => {
  const prices = resolvePrices('deepseek-flash', BEIJING(2026, 11, 11, 10, 0), { currency: 'CNY' })
  const economics = compactionEconomics({ newPrefixTokens: 130000, removedTokens: 600000, prices })
  assert.ok(economics.breakEvenTurns > 9 && economics.breakEvenTurns < 12)
})

test('ledgerRotationPlan is a no-op below the limit', () => {
  assert.deepEqual(ledgerRotationPlan('/x/ledger.jsonl', 0), [])
  assert.deepEqual(ledgerRotationPlan('/x/ledger.jsonl', LEDGER_DEFAULT_MAX_BYTES), [])
  assert.deepEqual(ledgerRotationPlan('', LEDGER_DEFAULT_MAX_BYTES + 1), [])
})

test('ledgerRotationPlan shifts archives then rotates the live file', () => {
  const plan = ledgerRotationPlan('/x/ledger.jsonl', LEDGER_DEFAULT_MAX_BYTES + 1)
  assert.deepEqual(plan[0], { op: 'unlink', path: '/x/ledger.jsonl.3' })
  assert.deepEqual(plan[1], { op: 'rename', from: '/x/ledger.jsonl.2', to: '/x/ledger.jsonl.3' })
  assert.deepEqual(plan[2], { op: 'rename', from: '/x/ledger.jsonl.1', to: '/x/ledger.jsonl.2' })
  assert.deepEqual(plan.at(-1), { op: 'rename', from: '/x/ledger.jsonl', to: '/x/ledger.jsonl.1' })
  assert.equal(plan.length, 4)
})

test('ledgerRotationPlan honours custom keepFiles', () => {
  const plan = ledgerRotationPlan('/x/l.jsonl', 10, 5, 1)
  assert.deepEqual(plan, [
    { op: 'unlink', path: '/x/l.jsonl.1' },
    { op: 'rename', from: '/x/l.jsonl', to: '/x/l.jsonl.1' },
  ])
  // invalid limits fall back to safe defaults rather than rotating at 0 bytes
  assert.deepEqual(ledgerRotationPlan('/x/l.jsonl', 100, 0, 3), [])
})

test('priceTableAgeDays reads the pinned baseline date', () => {
  const at = Date.parse('2026-11-21T12:00:00+08:00')
  assert.equal(priceTableAgeDays(PRICE_VERSION, at), 10)
  assert.equal(priceTableAgeDays('2026-11-11', Date.parse('2026-11-10T00:00:00+08:00')), -1)
  assert.equal(priceTableAgeDays('not-a-date', at), null)
})

test('isSimpleShellCommand only accepts single simple commands', () => {
  assert.equal(isSimpleShellCommand('cat app.log'), true)
  assert.equal(isSimpleShellCommand('  git status  '), true)
  assert.equal(isSimpleShellCommand('cat a.log | tail -n 5'), false)
  assert.equal(isSimpleShellCommand('cat a.log > out.txt'), false)
  assert.equal(isSimpleShellCommand('cat a.log && cat b.log'), false)
  assert.equal(isSimpleShellCommand('cat a.log; echo done'), false)
  assert.equal(isSimpleShellCommand('echo `whoami`'), false)
  assert.equal(isSimpleShellCommand('echo $(whoami)'), false)
  assert.equal(isSimpleShellCommand('cat a.log\nrm -rf /'), false)
  assert.equal(isSimpleShellCommand(''), false)
  assert.equal(isSimpleShellCommand(undefined), false)
})

test('outputLimitSuffix picks a shell-appropriate cap', () => {
  assert.equal(outputLimitSuffix('bash', 400), ' | head -n 400')
  assert.equal(outputLimitSuffix('run_command', 50), ' | head -n 50')
  assert.equal(outputLimitSuffix('pwsh', 400), ' | Select-Object -First 400')
  assert.equal(outputLimitSuffix('pwsh', 0), null)
  assert.equal(outputLimitSuffix('read', 400), null)
  assert.equal(firstShellToken('  Git status'), 'git')
})

test('outputLimitSuffix clamps tiny caps and rejects invalid line counts', () => {
  assert.equal(outputLimitSuffix('shell', 1), ' | head -n 20')
  assert.equal(outputLimitSuffix('powershell', 'abc'), null)
  assert.equal(outputLimitSuffix('shell_pwsh', 120), ' | Select-Object -First 120')
  assert.equal(firstShellToken(undefined), '')
})

test('sanitizeSwitchOverrides keeps only known boolean switches', () => {
  assert.deepEqual(
    sanitizeSwitchOverrides({ outputGuard: false, sourceLimits: true, stale: true, bad: 'yes' }, ['outputGuard', 'sourceLimits', 'bad']),
    { outputGuard: false, sourceLimits: true },
  )
  assert.deepEqual(sanitizeSwitchOverrides(null, ['a']), {})
  assert.deepEqual(sanitizeSwitchOverrides([1], ['a']), {})
  assert.deepEqual(sanitizeSwitchOverrides({ a: 1, b: true }, []), { b: true })
})
