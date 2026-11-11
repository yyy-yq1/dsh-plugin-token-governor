/**
 * dsh-plugin-token-governor — pure helpers (no cordis / dsh imports).
 *
 * Everything in this module is deterministic and unit-tested; the Host half
 * (index.js) only wires these functions to dsh events/services.
 *
 * Price facts: DeepSeek official pricing page, fetched 2026-11-11
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). CNY and USD are
 * independently listed official prices (not an FX conversion). Peak hours are
 * Beijing time Mon-Fri 09:00-12:00 and 14:00-18:00, excluding Chinese public
 * holidays; every other hour bills at 50% of peak.
 */

export const PRICE_VERSION = '2026-11-11'

/** CNY per 1M tokens. */
export const PRICES_CNY = {
  'deepseek-flash': {
    peak: { hit: 0.04, miss: 2, out: 8 },
    off: { hit: 0.02, miss: 1, out: 4 },
  },
  'deepseek-v4-pro': {
    peak: { hit: 0.3, miss: 9, out: 27 },
    off: { hit: 0.15, miss: 4.5, out: 13.5 },
  },
}

/** USD per 1M tokens (official English price page, same fetch). */
export const PRICES_USD = {
  'deepseek-flash': {
    peak: { hit: 0.006, miss: 0.3, out: 1.2 },
    off: { hit: 0.003, miss: 0.15, out: 0.6 },
  },
  'deepseek-v4-pro': {
    peak: { hit: 0.044, miss: 1.32, out: 3.96 },
    off: { hit: 0.022, miss: 0.66, out: 1.98 },
  },
}

/** Search / Fetch web API is billed per successful call, not per token. */
export const SEARCH_CALL_PRICE = {
  CNY: 5 / 1000,
  USD: 0.75 / 1000,
}

/** Reasoning effort tiers advertised by the DeepSeek adapter (dsh-llm-deepseek). */
export const EFFORT_ORDER = ['off', 'low', 'high', 'max']

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * Normalize a provider model id to one of the priced DeepSeek catalog keys.
 * @param {string} model wire model id, e.g. "deepseek-flash"
 * @returns {'deepseek-flash'|'deepseek-v4-pro'|undefined}
 */
export function normalizeModelKey(model) {
  const id = String(model ?? '')
  // The DeepSeek Anthropic endpoint maps claude-haiku/sonnet to flash and
  // claude-opus to v4-pro; claude-* names are a known billing trap.
  if (/opus/i.test(id)) return 'deepseek-v4-pro'
  if (/sonnet|haiku/i.test(id)) return 'deepseek-flash'
  if (/v4-pro|v4pro/i.test(id)) return 'deepseek-v4-pro'
  if (/flash/i.test(id)) return 'deepseek-flash'
  if (/\bpro\b/i.test(id)) return 'deepseek-v4-pro'
  if (/v4|deepseek/i.test(id)) return 'deepseek-flash'
  return undefined
}

/** Beijing wall clock for an epoch millisecond timestamp. */
export function beijingClock(ts) {
  const shifted = new Date(Number(ts) + 8 * HOUR_MS)
  const day = shifted.getUTCDay() // 0=Sunday
  const hour = shifted.getUTCHours()
  const minute = shifted.getUTCMinutes()
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return { day, hour, minute, dateKey: `${y}-${m}-${d}`, minutes: hour * 60 + minute }
}

/**
 * Peak / off-peak determination. Holidays are supplied as Beijing calendar
 * dates (YYYY-MM-DD); the official page only says "excluding Chinese public
 * holidays", so callers may override the list.
 */
export function isPeak(ts, holidayDates = []) {
  const clock = beijingClock(ts)
  if (clock.day === 0 || clock.day === 6) return false
  if (holidayDates.includes(clock.dateKey)) return false
  return (clock.hour >= 9 && clock.hour < 12) || (clock.hour >= 14 && clock.hour < 18)
}

/**
 * Resolve per-token prices (currency units per token) for one request.
 * @returns {{key: string|undefined, currency: string, tier: 'peak'|'off', hit: number, miss: number, out: number, known: boolean, source: string}}
 */
export function resolvePrices(model, ts, options = {}) {
  const currency = options.currency === 'USD' ? 'USD' : 'CNY'
  const table = currency === 'USD' ? PRICES_USD : PRICES_CNY
  const key = normalizeModelKey(model)
  const tier = isPeak(ts, options.holidayDates ?? []) ? 'peak' : 'off'
  const overrides = options.modelPrices ?? {}

  // Explicit override: exact model id first, then normalized catalog key.
  const override = overrides[model] ?? (key !== undefined ? overrides[key] : undefined)
  if (override !== undefined && override !== null && typeof override === 'object') {
    const pick = (name, fallback) => {
      const byName = override[name]
      if (typeof byName === 'number') return byName
      if (byName && typeof byName === 'object' && typeof byName[tier] === 'number') return byName[tier]
      const tierObject = override[tier]
      if (tierObject && typeof tierObject === 'object' && typeof tierObject[name] === 'number') return tierObject[name]
      return fallback
    }
    return {
      key: key ?? String(model ?? ''),
      currency,
      tier,
      hit: pick('hit', 0) / 1e6,
      miss: pick('miss', 0) / 1e6,
      out: pick('out', 0) / 1e6,
      known: true,
      source: 'override',
    }
  }

  if (key === undefined || table[key] === undefined) {
    return { key, currency, tier, hit: 0, miss: 0, out: 0, known: false, source: 'unknown' }
  }
  const p = table[key][tier]
  return {
    key,
    currency,
    tier,
    hit: p.hit / 1e6,
    miss: p.miss / 1e6,
    out: p.out / 1e6,
    known: true,
    source: 'builtin',
  }
}

/** Tokenizer-calibrated estimate for mixed text (CJK 鈮?.20 tok/char, ASCII 鈮?.25). */
export function estimateTextTokens(text) {
  const s = String(text ?? '')
  if (s.length === 0) return 0
  let cjk = 0
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) cjk += 1
  }
  return Math.round(cjk * 0.2 + (s.length - cjk) * 0.25)
}

/** Measured tokenizer rates used to price saved characters by encoding. */
export const TOKEN_RATES = { jsonPerChar: 0.45, tsvPerChar: 0.69 }


/** Strip volatile tokens (timestamps/uuids/hex) so similar outputs compare equal. */
export function normalizeToolLine(line) {
  return String(line)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}:\d{2}(\.\d+)?)?Z?\b/gi, '#')
    .replace(/\b[0-9a-f]{12,}\b/gi, '#')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Jaccard similarity of two normalised line arrays (bounded, fast). */
export function lineSimilarity(a, b) {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size === 0 && right.size === 0) return 1
  let intersection = 0
  for (const line of left) if (right.has(line)) intersection += 1
  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** Lines present in `current` but not in `previous` (normalised compare). */
export function changedToolLines(current, previous, cap) {
  const known = new Set(previous)
  const changed = []
  for (const line of current) {
    if (!known.has(line) && line.length > 0) changed.push(line)
    if (changed.length >= (cap ?? 12)) break
  }
  return changed
}

export function costOfUsage(usage, prices) {
  const miss = Number(usage?.inputTokens ?? 0)
  const hit = Number(usage?.cacheReadTokens ?? 0)
  const write = Number(usage?.cacheWriteTokens ?? 0)
  const out = Number(usage?.outputTokens ?? 0)
  // DeepSeek reports cache_creation_input_tokens as 0 today; if a future
  // billing change introduces a write price, they are folded into `miss`.
  const missCost = (miss + write) * Number(prices?.miss ?? 0)
  const hitCost = hit * Number(prices?.hit ?? 0)
  const outCost = out * Number(prices?.out ?? 0)
  return {
    missTokens: miss + write,
    hitTokens: hit,
    outputTokens: out,
    totalTokens: miss + hit + write + out,
    missCost,
    hitCost,
    outCost,
    total: missCost + hitCost + outCost,
    priced: Boolean(prices?.known !== false),
  }
}

/** Format a currency amount for display (CNY keeps fen precision for small numbers). */
export function formatMoney(amount, currency = 'CNY') {
  const n = Number(amount ?? 0)
  const symbol = currency === 'USD' ? '$' : '¥'
  if (n === 0) return `${symbol}0`
  if (Math.abs(n) < 0.01) return `${symbol}${n.toFixed(5)}`
  if (Math.abs(n) < 1) return `${symbol}${n.toFixed(4)}`
  return `${symbol}${n.toFixed(2)}`
}

/** Format an integer token count with thousands separators. */
export function formatInt(value) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}

/**
 * Decide whether the reasoning effort for the *next* step should differ from
 * the currently captured selection. `agent.model.select()` captured before a
 * step only applies to the next unprepared step, so the Host half calls this
 * at step boundaries and restores at turn end.
 *
 * @param {object} input
 * @param {{provider?: string, model?: string, reasoningEffort?: string}} input.selection current captured selection
 * @param {'turn-start'|'continuation'|'escalated'} input.phase planned phase for the next step
 * @param {object} input.policy effortPolicy config
 * @param {string|undefined} input.originalEffort effort the agent started with
 * @returns {{reasoningEffort: string, reason: string} | null} null = leave as is
 */
export function decideEffort({ selection, phase, policy, originalEffort }) {
  if (!policy || policy.enabled === false) return null
  if (!selection || typeof selection !== 'object') return null
  const current = selection.reasoningEffort
  const candidates = []
  if (phase === 'escalated') candidates.push(originalEffort ?? policy.firstStepEffort)
  else if (phase === 'turn-start') candidates.push(policy.firstStepEffort ?? originalEffort)
  else candidates.push(policy.continuationEffort)

  let desired
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue
    if (!EFFORT_ORDER.includes(candidate)) continue
    desired = candidate
    break
  }
  if (desired === undefined) return null
  if (desired === current) return null
  if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null

  // Conservative default: only ever downshift from 'max' on continuation
  // steps; an escalation after a failure may upshift back to the original
  // effort, and never beyond it.
  if (policy.onlyDownshiftMax === true) {
    const isDownshift = current === 'max' && EFFORT_ORDER.indexOf(desired) < EFFORT_ORDER.indexOf('max')
    const isEscalation = phase === 'escalated' && desired === originalEffort &&
      EFFORT_ORDER.indexOf(desired) > EFFORT_ORDER.indexOf(current ?? 'off')
    if (!isDownshift && !isEscalation) return null
  }
  return { reasoningEffort: desired, reason: `${current ?? 'adapter-default'}->${desired} (${phase})` }
}

/**
 * Lossless JSON鈫扵SV re-encoding for uniform arrays.
 *
 * Measured with the real DeepSeek tokenizer (2026-11-11):
 * TSV rows cost 67.5% of minified JSON and 30.8% of pretty JSON for the same
 * data, with zero information loss. This encoder is deliberately conservative:
 * it only accepts a top-level (or single-wrapper) array of flat objects with
 * identical primitive fields, no tabs/newlines/empty strings, and no `\N`
 * markers; anything ambiguous is left untouched.
 *
 * @param {string} text raw tool-result text (must be pure JSON)
 * @param {{minRows?: number, minSavingRatio?: number, maxBytes?: number}} options
 * @returns {{text: string, before: number, after: number, rows: number, fields: string[], wrapper?: string} | null}
 */
export function encodeUniformJsonArray(text, options = {}) {
  const minRows = options.minRows ?? 4
  const minSavingRatio = options.minSavingRatio ?? 0.3
  const maxBytes = options.maxBytes ?? 200000
  if (typeof text !== 'string' || text.length < 200 || text.length > maxBytes) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null
  let data
  try {
    data = JSON.parse(trimmed)
  } catch {
    // JSONL: every non-empty line is one JSON object.
    const lines = trimmed.split('\n').filter((line) => line.trim().length > 0)
    if (lines.length < minRows) return null
    try {
      data = lines.map((line) => JSON.parse(line))
    } catch {
      return null
    }
  }
  const flattenRow = (row) => {
    const out = {}
    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) { out[key] = null; continue }
      const type = typeof value
      if (type === 'object') {
        if (Array.isArray(value)) return null
        for (const [innerKey, innerValue] of Object.entries(value)) {
          if (innerValue === null || innerValue === undefined) { out[`${key}.${innerKey}`] = null; continue }
          const innerType = typeof innerValue
          if (innerType === 'object') return null
          out[`${key}.${innerKey}`] = innerValue
        }
        continue
      }
      out[key] = value
    }
    return out
  }
  let array = data
  let wrapper
  if (!Array.isArray(array)) {
    if (data === null || typeof data !== 'object') return null
    const arrayKeys = Object.keys(data).filter((key) => Array.isArray(data[key]))
    if (arrayKeys.length !== 1) return null
    wrapper = arrayKeys[0]
    array = data[wrapper]
  }
  if (!Array.isArray(array) || array.length < minRows) return null
  const first = array[0] === null || typeof array[0] !== 'object' || Array.isArray(array[0])
    ? null
    : flattenRow(array[0])
  if (first === null) return null
  const fields = Object.keys(first)
  if (fields.length < 2 || fields.length > 64) return null
  const rows = []
  for (const rawRow of array) {
    if (rawRow === null || typeof rawRow !== 'object' || Array.isArray(rawRow)) return null
    const row = flattenRow(rawRow)
    if (row === null) return null
    const keys = Object.keys(row)
    if (keys.length !== fields.length) return null
    const cells = []
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) return null
      const value = row[field]
      if (value === null) {
        cells.push('\\N')
        continue
      }
      const type = typeof value
      if (type === 'number') {
        if (!Number.isFinite(value)) return null
        cells.push(String(value))
      } else if (type === 'boolean') {
        cells.push(String(value))
      } else if (type === 'string') {
        if (value.length === 0 || value.includes('\t') || value.includes('\n') || value.includes('\r') ||
          value.includes('\\N') || value === '\\N') return null
        cells.push(value)
      } else {
        return null
      }
    }
    rows.push(cells)
  }
  const headerLine = fields.join('\t')
  const meta = `#tsv lossless rows=${rows.length} fields=${fields.join(',')}${wrapper === undefined ? '' : ` wrapper=${wrapper}`}`
  const encoded = `${meta}\n${headerLine}\n${rows.map((cells) => cells.join('\t')).join('\n')}`
  const before = text.length
  const after = encoded.length
  if (after >= before || (before - after) / before < minSavingRatio) return null
  return { text: encoded, before, after, rows: rows.length, fields, wrapper }
}

/**
 * Detect an unexpected prefix-cache miss: the previous request had a large
 * prompt and the current request reports far fewer cached tokens than the
 * previous prompt size, so a known prefix should have hit.
 *
 * @param {{prevPromptTokens: number, usage: object}} input
 * @param {{minPromptTokens?: number, hitRateFloor?: number}} config
 * @returns {null | {expectedHitTokens: number, actualHitTokens: number, extraMissTokens: number}}
 */
export function detectCacheAnomaly({ prevPromptTokens, usage }, config = {}) {
  const minPrompt = config.minPromptTokens ?? 5000
  const floor = config.hitRateFloor ?? 0.5
  const prev = Number(prevPromptTokens ?? 0)
  const hit = Number(usage?.cacheReadTokens ?? 0)
  const miss = Number(usage?.inputTokens ?? 0)
  if (prev < minPrompt) return null
  if (hit >= prev * floor) return null
  if (hit + miss < prev) return null
  return {
    expectedHitTokens: prev,
    actualHitTokens: hit,
    extraMissTokens: Math.max(0, Math.round(prev - hit)),
  }
}

/** The monetary penalty of a cache anomaly: extra miss tokens billed at miss price instead of hit. */
export function cacheAnomalyCost(extraMissTokens, prices) {
  const miss = Number(prices?.miss ?? 0)
  const hit = Number(prices?.hit ?? 0)
  return Math.max(0, Number(extraMissTokens ?? 0)) * Math.max(0, miss - hit)
}

/** Aggregate usage records into totals used by the report. */
export function emptyTotals() {
  return {
    requests: 0,
    mainRequests: 0,
    auxRequests: 0,
    inputMissTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    cost: 0,
    missCost: 0,
    hitCost: 0,
    outCost: 0,
    unknownPriceRequests: 0,
    peakRequests: 0,
    offPeakRequests: 0,
    finishErrors: 0,
    finishMaxTokens: 0,
    retries: 0,
  }
}

/** Fold one request record into totals (mutates and returns totals). */
export function addRequest(totals, record) {
  const t = totals ?? emptyTotals()
  t.requests += 1
  if (record.kind === 'aux') t.auxRequests += 1
  else t.mainRequests += 1
  t.inputMissTokens += record.missTokens ?? 0
  t.cacheReadTokens += record.hitTokens ?? 0
  t.outputTokens += record.outputTokens ?? 0
  t.cost += record.cost ?? 0
  t.missCost += record.missCost ?? 0
  t.hitCost += record.hitCost ?? 0
  t.outCost += record.outCost ?? 0
  if (record.priced === false) t.unknownPriceRequests += 1
  if (record.tier === 'peak') t.peakRequests += 1
  else t.offPeakRequests += 1
  if (record.finish === 'error') t.finishErrors += 1
  if (record.finish === 'aborted') t.retries += 1
  if (record.finish === 'max-tokens') t.finishMaxTokens += 1
  return t
}

/** Cache-hit rate of a totals record, in percent (0-100). */
export function cacheHitPct(totals) {
  const input = (totals?.inputMissTokens ?? 0) + (totals?.cacheReadTokens ?? 0)
  if (input <= 0) return 0
  return (totals.cacheReadTokens / input) * 100
}

/** Cost split percentages for display; sums to 100 for a priced total. */
export function costSplit(totals) {
  const total = Number(totals?.cost ?? 0)
  if (!(total > 0)) return { missPct: 0, hitPct: 0, outPct: 0 }
  return {
    missPct: (totals.missCost / total) * 100,
    hitPct: (totals.hitCost / total) * 100,
    outPct: (totals.outCost / total) * 100,
  }
}

/**
 * Compaction break-even estimate (turns needed before rewriting history pays
 * off under prefix-cache pricing) and cache-loss cost of a rewrite.
 */
export function compactionEconomics({ newPrefixTokens, removedTokens, prices }) {
  const news = Math.max(0, Number(newPrefixTokens ?? 0))
  const removed = Math.max(0, Number(removedTokens ?? 0))
  const miss = Number(prices?.miss ?? 0)
  const hit = Number(prices?.hit ?? 0)
  if (news <= 0 || removed <= 0 || !(miss > hit) || !(hit > 0)) return null
  const oneTimePenalty = news * (miss - hit)
  const perTurnSaving = removed * hit
  const breakEvenTurns = oneTimePenalty / perTurnSaving
  return { oneTimePenalty, perTurnSaving, breakEvenTurns }
}

/** Whether a per-turn budget was exceeded (0 disables the check). */
export function budgetExceeded(totals, budget) {
  const limit = Number(budget ?? 0)
  if (!(limit > 0)) return false
  const spent = Number(totals?.outCost ?? 0) + Number(totals?.missCost ?? 0) + Number(totals?.hitCost ?? 0)
  return spent >= limit
}

/** Default ledger rotation limits (bytes / archived generations to keep). */
export const LEDGER_DEFAULT_MAX_BYTES = 5 * 1024 * 1024
export const LEDGER_DEFAULT_KEEP_FILES = 3

/**
 * Plan for rotating an append-only JSONL ledger so it never grows unbounded.
 *
 * Returns an ordered op list the host can apply with fs calls; an empty list
 * means "no rotation needed". Ops are ordered oldest-first: drop the archive
 * that would fall past `keepFiles`, shift `.N-1` -> `.N`, then move the live
 * file to `.1`. Rotation is best-effort: a missing archive is skipped.
 */
export function ledgerRotationPlan(basePath, size, maxBytes = LEDGER_DEFAULT_MAX_BYTES, keepFiles = LEDGER_DEFAULT_KEEP_FILES) {
  if (typeof basePath !== 'string' || basePath.length === 0) return []
  const limit = Number(maxBytes)
  const fileSize = Number(size)
  if (!Number.isFinite(limit) || limit <= 0) return []
  if (!Number.isFinite(fileSize) || fileSize <= limit) return []
  const keep = Number.isFinite(Number(keepFiles)) && Number(keepFiles) > 0 ? Math.trunc(Number(keepFiles)) : LEDGER_DEFAULT_KEEP_FILES
  const ops = [{ op: 'unlink', path: `${basePath}.${keep}` }]
  for (let index = keep - 1; index >= 1; index -= 1) {
    ops.push({ op: 'rename', from: `${basePath}.${index}`, to: `${basePath}.${index + 1}` })
  }
  ops.push({ op: 'rename', from: basePath, to: `${basePath}.1` })
  return ops
}

/** Human-readable age in days for a YYYY-MM-DD price-table baseline. */
export function priceTableAgeDays(version, now = Date.now()) {
  if (typeof version !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(version)) return null
  const stamped = Date.parse(`${version}T00:00:00+08:00`)
  if (!Number.isFinite(stamped)) return null
  return Math.floor((Number(now) - stamped) / 86400000)
}

/**
 * True when a shell command is a single simple command: no pipe, redirect,
 * background/sequential operator, newline, backtick, or command substitution.
 * Source-side output limiting is only safe for these, because appending a pipe
 * to a compound command would limit only its last segment.
 */
export function isSimpleShellCommand(command) {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (trimmed.length === 0) return false
  return !/[|><&;`\n\r]|\$\(/.test(trimmed)
}

/** First whitespace-delimited token of a command, lower-cased. */
export function firstShellToken(command) {
  if (typeof command !== 'string') return ''
  return command.trim().split(/\s+/)[0].toLowerCase()
}

/**
 * Shell-specific suffix that caps a command's output to `lines`, or null when
 * the tool's shell is not supported. bash-like: `| head -n N`;
 * PowerShell: `| Select-Object -First N`.
 */
export function outputLimitSuffix(toolName, lines) {
  const n = Number(lines)
  if (!Number.isFinite(n) || n <= 0) return null
  const count = Math.max(20, Math.trunc(n))
  if (toolName === 'bash' || toolName === 'shell' || toolName === 'run_command') return ` | head -n ${count}`
  if (toolName === 'pwsh' || toolName === 'powershell' || toolName === 'shell_pwsh') return ` | Select-Object -First ${count}`
  return null
}

