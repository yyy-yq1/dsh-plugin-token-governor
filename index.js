/**
 * dsh-plugin-token-governor — Host half.
 *
 * What it does (all cache-safe: nothing here rewrites prompt history, tool
 * schemas, or any request input):
 *   1. Meter: every `llm/stream` call's provider usage is folded into real
 *      DeepSeek billing (cache hit / cache miss / output, peak vs off-peak,
 *      official 2026-11-11 price table, CNY or USD).
 *   2. Think-budget: at step boundaries, `agent.model.select()` is used to
 *      lower `reasoningEffort` on tool-continuation steps (default: max->high)
 *      and to escalate back to the original effort after a request/tool error.
 *      Effort changes preserve the token prefix, so the provider prompt cache
 *      keeps hitting.
 *   3. Cache sentinel: detects unexpected prefix-cache misses, attributes them
 *      to nearby session events, and prices the loss.
 *   4. Reports: `/token` command, `token_report` tool, optional JSON HTTP API
 *      and optional JSON snapshot file.
 *
 * The plugin adds one small tool schema and one command descriptor; it never
 * adds model-visible prompt text of its own.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PRICE_VERSION, SEARCH_CALL_PRICE,
  addRequest, budgetExceeded, cacheAnomalyCost, cacheHitPct, beijingClock,
  compactionEconomics, costOfUsage, costSplit, decideEffort, detectCacheAnomaly, emptyTotals,
  encodeUniformJsonArray, estimateTextTokens, formatInt, formatMoney, isPeak, resolvePrices, TOKEN_RATES,
  changedToolLines, lineSimilarity, normalizeToolLine,
  LEDGER_DEFAULT_KEEP_FILES, LEDGER_DEFAULT_MAX_BYTES, ledgerRotationPlan, priceTableAgeDays,
  firstShellToken, isSimpleShellCommand, outputLimitSuffix,
} from './governance.js'

export const name = 'token-governor'

export const inject = ['tools', 'commands']

/** Defaults; every key is overridable from the bundle row's `config:`. */
const DEFAULTS = {
  enabled: true,
  currency: 'CNY',
  modelPrices: {},
  holidayDates: [],
  effortPolicy: {
    enabled: false,
    continuationEffort: 'high',
    onlyDownshiftMax: true,
    escalateOnError: true,
    escalateOnToolError: true,
    restoreAtTurnEnd: true,
    firstStepEffort: null,
    switchGuard: {
      // Prevent an effort switch from risking a huge prefix-cache loss:
      // skip downshifts whose context is above this size (0 = no limit),
      // detect invalidation after a switch and roll back automatically.
      enabled: true,
      // Cache-loss downside scales with context size (one invalidation at
      // 600k tokens ≈ ¥0.6), so above this size the governor refuses to switch
      // effort automatically. 0 disables the prevention threshold.
      maxContextTokens: 250000,
      minContextTokens: 5000,
      invalidationRatio: 0.5,
      autoRollback: true,
    },
  },
  contextAdvice: {
    // Context volume is paid on every request: above this context size, a new
    // task usually belongs in a new session (cold-start cost is one-off).
    enabled: true,
    minContextTokens: 150000,
    newSessionExpectedTokens: 25000,
  },
  terseStyle: {
    // Opt-in: makes NEW sessions write internal reasoning / step narration in
    // ultra-compressed classical Chinese (or telegraph style). Same facts,
    // fewer tokens; user-facing answers stay normal Chinese. Applied per agent
    // at creation, so it never changes a running session's cached prefix.
    enabled: false,
    mode: 'classical', // 'classical' | 'telegraph' | 'concise'
    systemPromptText: null,
  },
  tsvCodec: {
    // Lossless JSON->TSV re-encoding for uniform arrays (measured: 67.5% of
    // minified JSON, 30.8% of pretty JSON, zero information loss). Applied at
    // tool-result write time, so the cached prefix is never rewritten.
    enabled: true,
    minRows: 4,
    minSavingRatio: 0.3,
    maxBytes: 200000,
    skipTools: ['read', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'present', 'save_token_expand'],
  },
  toolOutput: {
    // Reversible, structure-aware compression of oversized tool results,
    // merged from dsh-plugin-save-token: full text is written to a spill file
    // and the model receives a head/tail window plus that file path. Applies at
    // generation time only (append-only, cache-safe).
    compressEnabled: true,
    minBytes: 1400,
    errorMinBytes: 6000,
    minSavingBytes: 500,
    keepRatioMax: 0.7,
    headLines: 120,
    tailLines: 60,
    minLines: 60,
    longLineChars: 400,
    errorLineCap: 25,
    tabularEnabled: true,
    tabularHeadRows: 40,
    tabularTailRows: 20,
    tabularTargetRatio: 0.5,
    tabularMaxStride: 256,
    // Official @deepseek-ai/dsh-spill-policy budget (estimated tokens). Results
    // at or above it are left to that policy so the two mechanisms never both
    // rewrite the same result; ours only handles the below-budget band.
    spillPolicyMaxInlineTokens: 12500,
    dedupeEnabled: true,
    dedupeTtlMs: 600000,
    nearDedupeEnabled: true,
    nearDedupeMinSimilarity: 0.9,
    nearDedupeMaxDiffLines: 12,
    nearDedupeTtlMs: 900000,
    readTargetRatio: 0.4,
    spillRetentionHours: 72,
    maxSpillFilesPerSession: 40,
    spillDir: '',
    exemptTools: ['read', 'write', 'edit', 'apply_patch', 'str_replace_editor', 'present', 'token_report', 'save_token_expand'],
  },
  cacheGovernor: {
    // A gap at least this long makes the provider prefix cache likely cold, so
    // the next request pays a full-prompt miss.
    idleColdMinutes: 30,
    // Only warn about cold-resume cost when the prompt is worth warning about.
    warnPromptTokens: 20000,
    // Prompt size below which a miss is too cheap to attribute/warn.
    minPromptTokens: 5000,
  },
  toolPolicy: {
    enabled: true,
    // A tool registered while a session is live changes that session's tool
    // declarations, which invalidates the provider prefix cache (one full
    // prompt miss). Deferring keeps plugin installs/upgrades cache-safe; the
    // `/token` command (command plane, zero prompt tokens) stays available.
    deferWhenSessionsActive: true,
  },
  toolBudget: {
    // Static schema trim for NEW agents only (applied at agent creation, so
    // it never changes a running session's cached prefix). Empty by default:
    // the report recommends candidates from real call counts.
    enabled: false,
    deny: [],
    minToolCalls: 20,
    minRequests: 15,
  },
  guard: {
    softTurnCost: 0,
  },
  apiToken: '',
  ledger: {
    // Persistent cross-session, cross-restart usage ledger (official-billing
    // style totals). Append-only JSONL; empty path = ~/.dsh/token-governor.
    enabled: true,
    path: '',
    // Bounded growth: rotate the live file to .1, .2, ... once it exceeds
    // maxBytes; older generations beyond keepFiles are dropped.
    maxBytes: LEDGER_DEFAULT_MAX_BYTES,
    keepFiles: LEDGER_DEFAULT_KEEP_FILES,
  },
  terseVerify: {
    enabled: true,
    cooldownMs: 60000,
  },
  priceStaleDays: 90,
  decisionRetainRatio: 0.16,
  styleExperiments: {
    // Prompt-style A/B: each new agent gets a variant; output tokens and
    // failures are compared per variant. Off by default (behaviour change).
    enabled: false,
    assign: 'alternate', // 'alternate' | 'random'
    variants: ['concise', 'telegraph', 'dense'],
  },
  subagentRoute: {
    // Opt-in: downgrade freshly created child agents to a cheaper model.
    enabled: false,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    effort: null,
  },
  compactionDigest: {
    // Pre-compaction handoff alternative: at large context, the handoff note is
    // the recommended replacement for an expensive post-compaction checkpoint.
    enabled: true,
    minContextTokens: 150000,
  },
  readReuse: {
    // Byte-identical `read` of an unchanged file within a session: return a
    // reference instead of the content already in context.
    enabled: true,
  },
  compressionBudget: {
    // Above this estimated-token size, compress harder than the normal target.
    // Lowered from 4000 to 2500 in v0.19: mid-size results are the bulk of
    // context growth, and the extra compression is still reversible (locator).
    aggressiveAboveTokens: 2500,
    aggressiveTargetRatio: 0.3,
  },
  outputGuard: {
    // Short-output continuation downshift: when the previous main step produced
    // fewer than `lowOutputBelowTokens` output tokens (typical "just call the
    // next tool" steps), schedule the following steps at `downshiftEffort`.
    // Restored at turn end / after an error, and measured against unguarded
    // steps so the evidence stays visible in /token.
    enabled: true,
    lowOutputBelowTokens: 250,
    downshiftEffort: 'low',
  },
  sourceLimits: {
    // EXPERIMENTAL, opt-in: append `| head -n N` to allow-listed read-only
    // shell commands that would otherwise dump thousands of lines. Only
    // applies to a command with no existing pipe/redirect. Default off: it
    // changes command semantics (exit code becomes head's).
    enabled: false,
    bashHeadLines: 400,
    allowlist: ['cat', 'ls', 'dir', 'find', 'tree', 'git', 'grep', 'rg', 'npm', 'pnpm', 'pip', 'docker', 'kubectl', 'journalctl', 'wc'],
  },
  growth: {
    enabled: true,
    maxEntries: 80,
  },
  newSession: {
    // Handoff-driven new session: explicit /token new or API with confirm.
    enabled: true,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    promptPrefix: '继续以下交接任务（前一会话的交接单）：\n\n',
  },
  budget: {
    // Cost-aware effort protection: once a turn/session reaches softRatio of
    // its cost cap, downshift reasoning effort for the following steps so the
    // SAME task finishes for less money. Off by default: only the user knows
    // what quality/cost trade-off is acceptable.
    mode: 'off', // 'off' | 'turn' | 'session'
    maxTurnCost: 0, // currency units per turn (0 = no cap)
    maxSessionCost: 0, // currency units per session
    softRatio: 0.8,
    downshiftEffort: 'low', // 'off' | 'low' | 'high'
  },
  cacheAnomaly: {
    enabled: true,
    minPromptTokens: 5000,
    hitRateFloor: 0.5,
    causeWindowMs: 120000,
  },
  snapshotPath: '',
  snapshotIntervalMs: 1500,
  apiEnabled: true,
  apiPath: '/token-governor',
}

const CMD_DESCRIPTION = '查看/控制 token 成本核算与思考强度调度（不产生模型 token）'

/** Token ids that are billed per successful call by the DeepSeek web API. */
const SEARCH_TOOLS = new Set(['web_search', 'web_fetch', 'web-search', 'web-fetch'])

/** Tool names whose output is typically a long one-item-per-line path listing. */
const LIST_TOOL_RE = /^(glob|ls|list|tree|dir|find|fd|paths|list_dir)$/i

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeConfig(base, patch) {
  if (!isObject(patch)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isObject(value) && isObject(out[key])) out[key] = mergeConfig(out[key], value)
    else if (value !== undefined) out[key] = value
  }
  return out
}

function sessionIdOf(subject) {
  try {
    const id = subject?.session?.header?.id
    if (typeof id === 'string' && id.length > 0) return id
  } catch {}
  try {
    if (typeof subject?.id === 'string' && subject.id.length > 0) return String(subject.id)
  } catch {}
  return undefined
}

function modelOf(subject) {
  try {
    const model = subject?.options?.model ?? subject?.model?.current?.()?.model
    if (typeof model === 'string' && model.length > 0) return model
  } catch {}
  return undefined
}

function selectionOf(subject) {
  try {
    const current = subject?.model?.current?.()
    if (isObject(current)) return current
  } catch {}
  try {
    if (isObject(subject?.modelSelection)) return subject.modelSelection
  } catch {}
  return undefined
}

/**
 * Live agents for the current process, read through the optional-service
 * accessor: `ctx.agents` is not injectable here, while `ctx.get('agents')`
 * degrades to undefined when the service is absent.
 */
function liveAgentsOf(ctx) {
  try {
    const agents = ctx.get('agents')
    const list = agents?.list?.()
    return list === undefined ? [] : [...list]
  } catch {
    return []
  }
}

function shortId(id) {
  return typeof id === 'string' && id.length > 8 ? id.slice(-8) : String(id ?? '?')
}

/** FNV-1a hash for change detection only; not security-sensitive. */
function hashString(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/** Rough token estimate for composition only (4 chars/token; CJK underprices). */
function estimateTokens(chars) {
  return Math.round(Number(chars ?? 0) / 4)
}

/** Structure signature: ordered separator characters of one line. */
function lineSignature(line) {
  let signature = ''
  for (let i = 0; i < line.length && signature.length < 64; i += 1) {
    const ch = line[i]
    if ('|,\t;:=[](){}/'.includes(ch)) signature += ch
  }
  return signature
}

/** True when >=70% of non-empty lines share one structure signature (table/log). */
function looksStructured(lines) {
  if (lines.length < 40) return false
  const counts = new Map()
  let nonEmpty = 0
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const signature = lineSignature(line)
    if (signature.length < 2) continue
    nonEmpty += 1
    counts.set(signature, (counts.get(signature) ?? 0) + 1)
  }
  if (nonEmpty < 30) return false
  let top = 0
  for (const count of counts.values()) if (count > top) top = count
  return top / nonEmpty >= 0.7
}

export function apply(ctx, config) {
  const cfg = mergeConfig(DEFAULTS, config)

  // ---------- process-wide state ----------
  const globalTotals = emptyTotals()
  const globalToolCalls = { total: 0, byName: {}, searchCalls: 0, fetchCalls: 0 }
  let globalPeakCost = 0
  let globalOffPeakCost = 0
  const sessions = new Map() // sessionId -> session state
  const agents = new Map() // sessionId -> per-agent policy state
  const startedAt = Date.now()
  const recent = [] // last requests across sessions
  // ---------- persistent usage ledger (survives restarts) ----------
  const ledger = { totals: emptyTotals(), records: 0, since: undefined, file: '', sessions: new Map() }

  // ---------- self-check diagnostics (surfaced by /token doctor) ----------
  // Cheap counters that answer "is the meter actually wired to the host right
  // now?" — a silently broken hook would otherwise look like a cheap session.
  const diagnostics = {
    loadedAt: Date.now(),
    llmStreams: 0,
    preExecute: 0,
    postExecute: 0,
    lastLlmAt: undefined,
    lastPostExecuteAt: undefined,
    ledgerWrites: 0,
    ledgerRotations: 0,
    sourceRewrites: 0,
    lastSourceRewriteAt: undefined,
  }

  function mergeTotalsInto(target, source) {
    for (const key of Object.keys(target)) {
      if (typeof target[key] === 'number' && typeof source?.[key] === 'number') target[key] += source[key]
    }
  }

  function touchLedgerSession(record) {
    const key = typeof record.sessionId === 'string' && record.sessionId.length > 0
      ? shortId(record.sessionId)
      : 'unknown'
    let entry = ledger.sessions.get(key)
    if (entry === undefined) {
      entry = { id: key, totals: emptyTotals(), firstTs: record.ts, lastTs: record.ts, model: record.model }
      ledger.sessions.set(key, entry)
    }
    entry.firstTs = Math.min(entry.firstTs ?? record.ts ?? 0, record.ts ?? entry.firstTs ?? 0)
    entry.lastTs = Math.max(entry.lastTs ?? 0, record.ts ?? 0)
    if (typeof record.model === 'string') entry.model = record.model
    addRequest(entry.totals, record)
  }

  function ledgerPath() {
    const configured = cfg.ledger?.path
    if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
    return path.join(os.homedir(), '.dsh', 'token-governor', 'ledger.jsonl')
  }

  function ledgerSize() {
    try { return fs.statSync(ledger.file).size } catch { return 0 }
  }

  /**
   * Keep the append-only ledger bounded (rotate at maxBytes, keep N archives).
   * Best-effort: a failed rotation must never lose the record being appended.
   */
  function rotateLedgerIfNeeded() {
    try {
      const size = ledgerSize()
      const maxBytes = Number(cfg.ledger?.maxBytes ?? LEDGER_DEFAULT_MAX_BYTES)
      const keepFiles = cfg.ledger?.keepFiles ?? LEDGER_DEFAULT_KEEP_FILES
      const plan = ledgerRotationPlan(ledger.file, size, maxBytes, keepFiles)
      if (plan.length === 0) return false
      for (const op of plan) {
        try {
          if (op.op === 'unlink') {
            if (fs.existsSync(op.path)) fs.unlinkSync(op.path)
          } else if (fs.existsSync(op.from)) {
            fs.renameSync(op.from, op.to)
          }
        } catch {}
      }
      diagnostics.ledgerRotations += 1
      return true
    } catch {
      return false
    }
  }

  function loadLedger() {
    ledger.file = ledgerPath()
    try {
      if (!fs.existsSync(ledger.file)) return
      const lines = fs.readFileSync(ledger.file, 'utf8').split('\n')
      for (const line of lines) {
        if (line.trim().length === 0) continue
        let entry
        try { entry = JSON.parse(line) } catch { continue }
        const record = {
          kind: entry.kind === 'aux' ? 'aux' : 'main',
          missTokens: Number(entry.miss ?? 0),
          hitTokens: Number(entry.hit ?? 0),
          writeTokens: Number(entry.write ?? 0),
          outputTokens: Number(entry.out ?? 0),
          cost: Number(entry.cost ?? 0),
          missCost: Number(entry.missCost ?? 0),
          hitCost: Number(entry.hitCost ?? 0),
          outCost: Number(entry.outCost ?? 0),
          tier: entry.tier === 'peak' ? 'peak' : 'off',
          priced: entry.priced !== false,
          finish: entry.finish,
          ts: typeof entry.ts === 'number' ? entry.ts : undefined,
          model: entry.model,
          sessionId: typeof entry.sid === 'string' ? entry.sid : entry.session,
        }
        addRequest(ledger.totals, record)
        touchLedgerSession(record)
        ledger.records += 1
        if (ledger.since === undefined && typeof entry.ts === 'number') ledger.since = entry.ts
      }
      // Merge legacy short-id rows into their full-id session once both exist.
      for (const shortKey of [...ledger.sessions.keys()]) {
        if (typeof shortKey !== 'string' || shortKey.length > 12 || shortKey.startsWith('session-')) continue
        const targetKey = [...ledger.sessions.keys()].find((key) => key !== shortKey && key.includes(shortKey))
        if (targetKey === undefined) continue
        const source = ledger.sessions.get(shortKey)
        const target = ledger.sessions.get(targetKey)
        if (source === undefined || target === undefined) continue
        mergeTotalsInto(target.totals, source.totals)
        target.firstTs = Math.min(target.firstTs ?? source.firstTs ?? 0, source.firstTs ?? target.firstTs ?? 0)
        target.lastTs = Math.max(target.lastTs ?? 0, source.lastTs ?? 0)
        ledger.sessions.delete(shortKey)
      }
    } catch (error) {
      console.error('token-governor: ledger load failed', error)
    }
  }

  function appendLedger(rec) {
    if (cfg.ledger?.enabled === false) return
    addRequest(ledger.totals, rec)
    touchLedgerSession(rec)
    ledger.records += 1
    if (ledger.since === undefined) ledger.since = rec.ts
    try {
      fs.mkdirSync(path.dirname(ledger.file), { recursive: true })
      rotateLedgerIfNeeded()
      const entry = JSON.stringify({
        ts: rec.ts,
        sid: rec.sessionId,
        session: rec.sessionId === undefined ? undefined : shortId(rec.sessionId),
        provider: rec.provider,
        model: rec.model,
        kind: rec.kind,
        miss: rec.missTokens,
        hit: rec.hitTokens,
        write: rec.writeTokens,
        out: rec.outputTokens,
        cost: rec.cost,
        missCost: rec.missCost,
        hitCost: rec.hitCost,
        outCost: rec.outCost,
        tier: rec.tier,
        priced: rec.priced,
        finish: rec.finish,
      })
      fs.appendFileSync(ledger.file, entry + '\n', 'utf8')
      diagnostics.ledgerWrites += 1
    } catch (error) {
      console.error('token-governor: ledger append failed', error)
    }
  }

  loadLedger()
  // Startup rotation: a long-running install may already exceed maxBytes.
  if (cfg.ledger?.enabled !== false) rotateLedgerIfNeeded()
  const abSegments = [{ startedAt: startedAt, compress: false, requests: 0, cost: 0, errors: 0, maxTokens: 0, toolErrors: 0 }]
  abSegments[0].compress = cfg?.toolOutput?.compressEnabled !== false
  const terseVerifications = []
  const terseAgents = new Map()
  let lastTerseVerifyAt = 0
  let styleAssignCounter = 0
  let snapshotAt = 0
  let lastSnapshotError = ''
  let apiRoute = null

  /** Parent session id for subagent cost attribution (sessions service). */
  function parentSessionOf(sessionId) {
    try {
      const sessionsSvc = ctx.get('sessions')
      const session = sessionsSvc?.get?.(sessionId)
      const parent = session?.header?.parentSession
      return typeof parent === 'string' ? parent : undefined
    } catch {
      return undefined
    }
  }

  function ensureSession(sessionId, model) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        id: sessionId,
        model: model ?? modelOf(undefined),
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        totals: emptyTotals(),
        turns: [], // closed turn summaries (bounded)
        turn: { number: 0, totals: emptyTotals() },
        tools: { total: 0, byName: {}, searchCalls: 0, fetchCalls: 0, fp: new Set() },
        surface: {
          toolsSignature: undefined,
          toolCount: 0,
          toolsTokensEst: 0,
          promptTokensEst: 0,
          toolSizes: [], // [{name, chars}] captured from the first main request
        },
        schemaChanges: 0,
        aux: emptyTotals(),
        compactionEvents: 0,
        codec: { applied: 0, deferred: 0, before: 0, after: 0, tokensBefore: 0, tokensAfter: 0, valueSkipped: 0, shapeSkipped: 0, toolSkipped: 0, noJson: 0 },
        toolOut: { compressed: 0, structured: 0, deduped: 0, nearDeduped: 0, bytesBefore: 0, bytesAfter: 0, tokensBefore: 0, tokensAfter: 0, skipped: 0, officialDeferred: 0, markerDeferred: 0, lastError: '', dedupe: new Map(), near: new Map(), spills: [] },
        styleStats: {
          terse: { requests: 0, outputTokens: 0, errors: 0 },
          normal: { requests: 0, outputTokens: 0, errors: 0 },
        },
        parentSession: undefined,
        readCache: new Map(),
        readReused: 0,
        growth: [],
        lastGrowthToolTotal: 0,
        aggressiveCompressed: 0,
        peakCost: 0,
        offPeakCost: 0,
        // Output governance evidence: was the previous main step cheap, and how
        // big are guarded vs unguarded outputs (rough A/B, same session).
        lastMainOutputTokens: undefined,
        outputGuard: { downshifts: 0, guardedRequests: 0, guardedOutput: 0, otherRequests: 0, otherOutput: 0 },
        cache: {
          prevPromptTokens: 0,
          promptSumTokens: 0,
          promptCount: 0,
          anomalies: [],
          causes: [],
          // cause -> {requests, missTokens, lossTokens, cost}
          byCause: {},
          // append-only ideal: sum of previous prompts that should have hit
          expectedHitTokens: 0,
          mainHitTokens: 0,
          firstRequest: undefined,
          advisories: [],     // pre-flight cache-risk warnings
          pendingModelSwitch: false,
          pendingSystemRewrite: false,
          pendingCompaction: false,
          lastRoute: undefined,
        },
        effort: {
          originalEffort: undefined,
          currentEffort: undefined,
          applications: 0,
          downshifts: 0,
          escalations: 0,
          switchSafe: 0,
          rollbacks: 0,
          skipped: 0,
          watch: undefined,
          lastDecision: '',
          byTier: {},
        },
        requests: [],
        retries: 0,
        lastRequestAt: 0,
      }
      sessions.set(sessionId, state)
    }
    if (typeof model === 'string' && model.length > 0) state.model = model
    if (state.parentSession === undefined) state.parentSession = parentSessionOf(sessionId)
    state.lastSeenAt = Date.now()
    return state
  }

  function ensureAgent(sessionId, subject) {
    let state = agents.get(sessionId)
    if (state === undefined) {
      const selection = selectionOf(subject)
      // Prefer the AgentOptions effort (the user's configured default): a
      // mid-session plugin reload must still restore the real original tier,
      // not the previous instance's transient downshift.
      state = {
        sessionId,
        originalEffort: subject?.options?.reasoningEffort ?? selection?.reasoningEffort,
        lastTurn: 0,
        escalatedTurn: undefined,
        appliedEffort: undefined,
        budgetDownshifted: false,
        budgetWarnedTurn: undefined,
        effortRiskSuspended: false,
        ourSelects: [], // {effort, ts} to distinguish our own model/selection events
        // Short-output continuation downshift state (outputGuard).
        outputDownshifted: false,
        outputGuardedStep: false,
        outputDownshiftCount: 0,
        outputRestoredAt: undefined,
      }
      agents.set(sessionId, state)
    }
    return state
  }

  function currentPrices(model, ts) {
    return resolvePrices(model, ts, {
      currency: cfg.currency,
      modelPrices: cfg.modelPrices,
      holidayDates: cfg.holidayDates,
    })
  }

  function searchCallCost() {
    return cfg.currency === 'USD' ? SEARCH_CALL_PRICE.USD : SEARCH_CALL_PRICE.CNY
  }

  function noteCause(sessionId, type, detail) {
    const state = ensureSession(sessionId)
    state.cache.causes.push({ ts: Date.now(), type, detail: detail ?? '' })
    if (state.cache.causes.length > 12) state.cache.causes.shift()
  }

  function addCauseMiss(state, cause, entry) {
    const bucket = state.cache.byCause[cause] ?? { requests: 0, missTokens: 0, lossTokens: 0, cost: 0 }
    bucket.requests += 1
    bucket.missTokens += entry.missTokens
    bucket.lossTokens += entry.lossTokens
    bucket.cost += entry.cost
    state.cache.byCause[cause] = bucket
  }

  function pushAdvisory(state, kind, text, cost) {
    state.cache.advisories.push({ ts: Date.now(), kind, text, cost })
    if (state.cache.advisories.length > 12) state.cache.advisories.shift()
  }

  function causeText(cause, rec, state, prices) {
    const context = `${formatInt(state.cache.prevPromptTokens)} tokens 上下文`
    const delta = `¥${(((prices.miss - prices.hit) * rec.missTokens)).toFixed(4)}`
    switch (cause) {
      case 'post-compaction': return `压缩重写历史后首次请求：整段新前缀按未命中计，本次多付约 ${delta}（${context}）`
      case 'model-switch': return `中途切换模型/提供方：缓存域重置，本次多付约 ${delta}（${context}）`
      case 'tool-change': return `工具集变更（插件安装/升级/启用工具）：前缀从第一个变化的声明 token 起失效，本次多付约 ${delta}`
      case 'system-rewrite': return `系统提示词改写：前缀失效，本次多付约 ${delta}（${context}）`
      case 'idle-cold': return `空闲后恢复：前缀缓存大概率已过期，本次整段未命中，多付约 ${delta}`
      case 'unexplained-miss': return `疑似前缀缓存被服务端驱逐（best-effort）：本次未命中 ${formatInt(rec.missTokens)} tokens，多付约 ${delta}`
      default: return `未命中 ${formatInt(rec.missTokens)} tokens（${delta}）`
    }
  }

  // ---------- accounting: every streaming model call ----------
  ctx.on('llm/stream', function (options, next) {
    const ts = Date.now()
    diagnostics.llmStreams += 1
    diagnostics.lastLlmAt = ts
    const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : undefined
    const model = typeof options?.model === 'string' ? options.model : undefined
    const provider = typeof options?.provider === 'string' ? options.provider : undefined
    const purpose = typeof options?.purpose === 'string' ? options.purpose : undefined
    const effort = typeof options?.reasoningEffort === 'string' ? options.reasoningEffort : 'adapter-default'
    const rec = {
      ts,
      sessionId,
      provider,
      model,
      purpose,
      kind: purpose === undefined ? 'main' : 'aux',
      effort,
      missTokens: 0,
      hitTokens: 0,
      writeTokens: 0,
      outputTokens: 0,
      finish: '',
      cost: 0,
      missCost: 0,
      hitCost: 0,
      outCost: 0,
      priced: true,
      tier: 'off',
      modelKey: undefined,
      toolCount: 0,
      toolsSignature: undefined,
      toolsTokensEst: 0,
      promptTokensEst: 0,
      closed: false,
    }
    // Resolve the real model window once per session (decision planner).
    if (sessionId !== undefined) {
      const sessionState = ensureSession(sessionId)
      if (sessionState.surface.modelInfo === undefined) {
        sessionState.surface.modelInfo = {}
        try {
          const llm = ctx.get('llm')
          Promise.resolve(llm?.resolveModelInfo?.(provider, model)).then((info) => {
            if (info !== null && typeof info === 'object') {
              sessionState.surface.modelInfo = {
                contextWindow: info.context === undefined ? undefined : info.context.contextWindow,
                maxTokens: info.maxTokens,
              }
            }
          }).catch(() => {})
        } catch {}
      }
    }
    // Composition snapshot (estimate only; billing always uses provider usage).
    try {
      if (Array.isArray(options?.tools)) {
        rec.toolCount = options.tools.length
        const json = JSON.stringify(options.tools)
        rec.toolsSignature = hashString(json)
        rec.toolsTokensEst = estimateTokens(json.length)
        // Fixed-prefix composition: per-tool schema cost, captured once per
        // session so the report can price the tools nobody calls.
        if (sessionId !== undefined) {
          const sessionState = ensureSession(sessionId)
          if (sessionState.surface.toolSizes.length === 0) {
            const sizes = []
            for (const tool of options.tools) {
              try {
                sizes.push({ name: String(tool?.name ?? '?'), chars: JSON.stringify(tool).length })
              } catch {}
            }
            sessionState.surface.toolSizes = sizes
          }
        }
      }
      let chars = typeof options?.system === 'string' ? options.system.length : 0
      if (Array.isArray(options?.messages)) {
        try {
          chars += JSON.stringify(options.messages).length
        } catch {
          chars += Number(options.messages.length) * 200
        }
      }
      rec.promptTokensEst = estimateTokens(chars)
    } catch (error) {
      // measurement must never break a model call
    }

    const inner = next()
    async function* tracked() {
      try {
        for await (const chunk of inner) {
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && isObject(chunk.usage)) {
            rec.missTokens += Number(chunk.usage.inputTokens ?? 0)
            rec.hitTokens += Number(chunk.usage.cacheReadTokens ?? 0)
            rec.writeTokens += Number(chunk.usage.cacheWriteTokens ?? 0)
            rec.outputTokens += Number(chunk.usage.outputTokens ?? 0)
          } else if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
            const kind = chunk?.reason?.kind
            if (typeof kind === 'string') rec.finish = kind
          }
          yield chunk
        }
      } finally {
        if (!rec.closed) {
          rec.closed = true
          closeRequest(rec)
        }
      }
    }
    return tracked()
  })

  function closeRequest(rec) {
    const prices = currentPrices(rec.model, rec.ts)
    const usageCost = costOfUsage(
      { inputTokens: rec.missTokens, cacheReadTokens: rec.hitTokens, cacheWriteTokens: rec.writeTokens, outputTokens: rec.outputTokens },
      prices,
    )
    rec.cost = usageCost.total
    rec.missCost = usageCost.missCost
    rec.hitCost = usageCost.hitCost
    rec.outCost = usageCost.outCost
    rec.priced = prices.known
    rec.tier = prices.tier
    rec.modelKey = prices.key
    rec.durationMs = Date.now() - rec.ts
    // Persistent cumulative ledger (official-billing style, survives restarts).
    appendLedger(rec)

    addRequest(globalTotals, rec)
    if (rec.kind === 'main') {
      if (rec.tier === 'peak') globalPeakCost += rec.cost
      else globalOffPeakCost += rec.cost
    }
    const sessionId = rec.sessionId
    if (sessionId === undefined) {
      pushRecent(rec, undefined)
      maybeSnapshot()
      return
    }
    const state = ensureSession(sessionId, rec.model)
    const priorMainRequests = state.totals.mainRequests
    const previousRequestAt = state.lastRequestAt
    addRequest(state.totals, rec)
    addRequest(state.turn.totals, rec)
    if (rec.kind === 'aux') addRequest(state.aux, rec)
    if (rec.kind === 'main') {
      const segment = abSegments[abSegments.length - 1]
      if (segment !== undefined) {
        segment.requests += 1
        segment.cost += rec.cost
        if (rec.finish === 'error' || rec.finish === 'aborted') segment.errors += 1
        if (rec.finish === 'max-tokens') segment.maxTokens += 1
      }
      const styleName = terseAgents.get(sessionId) ?? 'normal'
      const styleEntry = state.styleStats[styleName] ?? { requests: 0, outputTokens: 0, errors: 0 }
      state.styleStats[styleName] = styleEntry
      styleEntry.requests += 1
      styleEntry.outputTokens += rec.outputTokens
      if (rec.finish === 'error' || rec.finish === 'aborted') styleEntry.errors += 1
      // Output governance: remember the size of the last main output (the next
      // step's downshift decision) and keep a rough guarded/unguarded A/B.
      state.lastMainOutputTokens = rec.outputTokens
      const policyState = agents.get(sessionId)
      if (policyState?.outputGuardedStep === true) {
        state.outputGuard.guardedRequests += 1
        state.outputGuard.guardedOutput += rec.outputTokens
        policyState.outputGuardedStep = false
      } else {
        state.outputGuard.otherRequests += 1
        state.outputGuard.otherOutput += rec.outputTokens
      }
      // Context-growth attribution: prompt delta since the previous request,
      // attributed to tool results when the tool count grew.
      if (cfg.growth?.enabled !== false) {
        const promptTokens = rec.hitTokens + rec.missTokens
        const previousPrompt = state.cache.prevPromptTokens
        if (previousPrompt > 0 && promptTokens > previousPrompt) {
          const toolsNow = state.tools.total
          const toolsSince = toolsNow - state.lastGrowthToolTotal
          state.lastGrowthToolTotal = toolsNow
          state.growth.push({ ts: rec.ts, delta: promptTokens - previousPrompt, kind: toolsSince > 0 ? 'tool' : 'other' })
          if (state.growth.length > (cfg.growth?.maxEntries ?? 80)) state.growth.shift()
        } else {
          state.lastGrowthToolTotal = state.tools.total
        }
      }
    }
    if (rec.tier === 'peak') state.peakCost += rec.cost
    else state.offPeakCost += rec.cost
    state.lastRequestAt = Date.now()

    // per-effort observed output (evidence that a downshift changes output size)
    const tierKey = `${rec.model ?? '?'}|${rec.effort}`
    const tier = state.effort.byTier[tierKey] ?? { requests: 0, outputTokens: 0 }
    tier.requests += 1
    tier.outputTokens += rec.outputTokens
    state.effort.byTier[tierKey] = tier

    if ((rec.finish === 'error' || rec.finish === 'aborted') && rec.kind === 'main') {
      state.retries += 1
    }

    // ---------- cache governor: attribute every main-request miss ----------
    if (rec.kind === 'main') {
      const governor = cfg.cacheGovernor ?? {}
      const minPrompt = governor.minPromptTokens ?? cfg.cacheAnomaly?.minPromptTokens ?? 5000
      const prevPrompt = state.cache.prevPromptTokens
      const idleMs = previousRequestAt > 0 ? rec.ts - previousRequestAt : 0
      const idleColdMs = (governor.idleColdMinutes ?? 30) * 60000
      const toolsChanged = rec.toolsSignature !== undefined && state.surface.toolsSignature !== undefined &&
        rec.toolsSignature !== state.surface.toolsSignature
      const hitRatio = prevPrompt > 0 ? rec.hitTokens / prevPrompt : 1
      // Effort-switch cache verification: did the prefix collapse right after
      // our own downshift? If so, classify it and roll the switch back.
      let switchRisk = null
      if (state.effort.watch !== undefined && priorMainRequests > 0) {
        const guard = cfg.effortPolicy?.switchGuard ?? {}
        const watch = state.effort.watch
        state.effort.watch = undefined
        const switchLoss = Math.max(0, prevPrompt - rec.hitTokens)
        const otherKnownCause = state.cache.pendingCompaction || state.cache.pendingModelSwitch ||
          state.cache.pendingSystemRewrite || toolsChanged
        if (guard.enabled !== false && otherKnownCause !== true && prevPrompt > (guard.minContextTokens ?? 5000) &&
          switchLoss > prevPrompt * (guard.invalidationRatio ?? 0.5)) {
          switchRisk = { loss: switchLoss, from: watch.from, to: watch.to, provider: watch.provider, model: watch.model }
        } else {
          state.effort.switchSafe += 1
        }
      }
      let cause = 'incremental'
      if (priorMainRequests === 0) cause = 'first'
      else if (switchRisk !== null) cause = 'effort-change'
      else if (state.cache.pendingCompaction) cause = 'post-compaction'
      else if (state.cache.pendingModelSwitch) cause = 'model-switch'
      else if (state.cache.pendingSystemRewrite) cause = 'system-rewrite'
      else if (toolsChanged) cause = 'tool-change'
      else if (idleMs >= idleColdMs && rec.missTokens >= minPrompt && hitRatio < 0.5) cause = 'idle-cold'
      else if (prevPrompt >= minPrompt && rec.missTokens >= minPrompt && hitRatio < 0.4) cause = 'unexplained-miss'
      // Principle: an append-only request should hit the ENTIRE previous
      // prompt. Everything below that is invalidation loss (the avoidable
      // part); the miss tokens above the previous prompt are new content.
      const invalidationCause = cause !== 'incremental' && cause !== 'first'
      const lossTokens = switchRisk !== null
        ? switchRisk.loss
        : (invalidationCause ? Math.max(0, Math.round(prevPrompt - rec.hitTokens)) : 0)
      const deltaPrice = prices.miss - prices.hit
      const cost = invalidationCause
        ? deltaPrice * lossTokens
        : deltaPrice * rec.missTokens
      addCauseMiss(state, cause, { missTokens: rec.missTokens, lossTokens, cost })
      if (switchRisk !== null) {
        rollbackEffortSwitch(state, agents.get(sessionId), sessionId, switchRisk, prices)
      }
      if (priorMainRequests === 0) {
        state.cache.firstRequest = { miss: rec.missTokens, hit: rec.hitTokens, at: rec.ts }
      } else if (prevPrompt > 0) {
        state.cache.expectedHitTokens += prevPrompt
        state.cache.mainHitTokens += rec.hitTokens
      }
      state.cache.promptSumTokens += rec.missTokens + rec.hitTokens
      state.cache.promptCount += 1
      if (invalidationCause && cost >= 0.001) {
        pushAdvisory(state, cause, causeText(cause, { ...rec, missTokens: lossTokens || rec.missTokens }, state, prices), cost)
      }
      state.cache.pendingCompaction = false
      state.cache.pendingModelSwitch = false
      state.cache.pendingSystemRewrite = false
      if (typeof rec.provider === 'string' && typeof rec.model === 'string') {
        state.cache.lastRoute = `${rec.provider}/${rec.model}`
      }
    }

    // cache sentinel: only for main requests (aux calls have their own prompt)
    if (rec.kind === 'main' && cfg.cacheAnomaly?.enabled !== false) {
      const anomaly = detectCacheAnomaly(
        { prevPromptTokens: state.cache.prevPromptTokens, usage: { cacheReadTokens: rec.hitTokens, inputTokens: rec.missTokens } },
        cfg.cacheAnomaly,
      )
      if (anomaly !== null) {
        const lost = cacheAnomalyCost(anomaly.extraMissTokens, prices)
        const cause = nearestCause(state)
        state.cache.anomalies.push({
          ts: rec.ts,
          extraMissTokens: anomaly.extraMissTokens,
          expectedHitTokens: anomaly.expectedHitTokens,
          actualHitTokens: anomaly.actualHitTokens,
          lostCost: lost,
          causeType: cause?.type ?? '',
          causeAgeMs: cause === undefined ? -1 : Date.now() - cause.ts,
        })
        if (state.cache.anomalies.length > 10) state.cache.anomalies.shift()
      }
      state.cache.prevPromptTokens = rec.missTokens + rec.hitTokens
    }

    // tool-schema composition: a changed tool set invalidates the provider
    // prefix cache from the first changed declaration token.
    if (rec.kind === 'main') {
      if (rec.toolsSignature !== undefined && state.surface.toolsSignature !== undefined &&
        rec.toolsSignature !== state.surface.toolsSignature) {
        state.schemaChanges += 1
        noteCause(sessionId, 'tool-schema-change',
          `tools changed: ${state.surface.toolCount} -> ${rec.toolCount} definitions`)
      }
      state.surface = {
        toolsSignature: rec.toolsSignature ?? state.surface.toolsSignature,
        toolCount: rec.toolCount || state.surface.toolCount,
        toolsTokensEst: rec.toolsTokensEst || state.surface.toolsTokensEst,
        promptTokensEst: rec.promptTokensEst || state.surface.promptTokensEst,
      }
    }

    // turn budget observation + one soft warning per turn
    if (budgetExceeded(state.turn.totals, cfg.guard?.softTurnCost ?? 0)) {
      state.turn.softExceeded = true
      if (state.turn.warned !== true) {
        state.turn.warned = true
        pushAdvisory(state, 'turn-budget',
          `本轮已花 ${formatMoney(state.turn.totals.cost, cfg.currency)}，超过软阈值 ` +
          `${formatMoney(cfg.guard.softTurnCost, cfg.currency)}：注意长循环/失控，可随时中断或让它先收尾。`,
          state.turn.totals.cost)
      }
    }

    state.requests.push({
      ts: rec.ts,
      model: rec.model,
      effort: rec.effort,
      kind: rec.kind,
      miss: rec.missTokens,
      hit: rec.hitTokens,
      out: rec.outputTokens,
      cost: rec.cost,
      tier: rec.tier,
      finish: rec.finish,
    })
    if (state.requests.length > 80) state.requests.shift()
    pushRecent(rec, sessionId)
    maybeSnapshot()
  }

  function nearestCause(state) {
    if (state.cache.causes.length === 0) return undefined
    const windowMs = cfg.cacheAnomaly?.causeWindowMs ?? 120000
    const now = Date.now()
    for (let i = state.cache.causes.length - 1; i >= 0; i -= 1) {
      const cause = state.cache.causes[i]
      if (now - cause.ts <= windowMs) return cause
    }
    return undefined
  }

  function pushRecent(rec, sessionId) {
    recent.push({ ...rec, session: sessionId === undefined ? '' : shortId(sessionId) })
    if (recent.length > 40) recent.shift()
  }

  // ---------- event trace for cache-loss attribution ----------
  ctx.on('session/event', function (session, event) {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) return
      const type = String(event?.type ?? '')
      if (type === 'model/selection') {
        // Distinguish our own policy selections from user/other-plugin
        // selections: a manual choice becomes the new "original" effort so the
        // turn-end restore never overrides the user.
        const id = sessionIdOf(session)
        if (id !== undefined) {
          const data = event?.data ?? {}
          const effort = typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined
          const state = ensureSession(id)
          if (typeof data.provider === 'string' && typeof data.model === 'string') {
            const route = `${data.provider}/${data.model}`
            if (state.cache.lastRoute !== undefined && route !== state.cache.lastRoute) {
              const prices = currentPrices(data.model, Date.now())
              const estimated = (prices.miss - prices.hit) * state.cache.prevPromptTokens
              state.cache.pendingModelSwitch = true
              pushAdvisory(state, 'model-switch',
                `模型/提供方切换（${state.cache.lastRoute} -> ${route}）：缓存域重置，下一次请求预计多付 ¥${estimated.toFixed(4)}。` +
                '除任务确实需要外，建议不要在同一会话中途切换模型。', estimated)
            }
            state.cache.lastRoute = route
          }
          if (effort !== undefined) {
            state.effort.currentEffort = effort
            const policyState = agents.get(id)
            if (policyState !== undefined) {
              const now = Date.now()
              const index = policyState.ourSelects.findIndex((item) => item.effort === effort && now - item.ts < 5000)
              if (index >= 0) policyState.ourSelects.splice(index, 1)
              else {
                // A manual choice is the new truth: adopt it as the original
                // effort and lift any automatic effort protection.
                policyState.originalEffort = effort
                policyState.effortRiskSuspended = false
                state.effort.watch = undefined
              }
            }
          }
        }
        return
      }
      if (type === 'request/header') {
        noteCause(sessionId, 'request-header', 'tools/config envelope changed')
        return
      }
      if (type === 'system/message') {
        const state = ensureSession(sessionId)
        noteCause(sessionId, 'system-prompt', 'system prompt rewritten or appended')
        // Only direct prompt REWRITES invalidate the cached head; this event
        // also covers benign appends, so never warn on the first prompt.
        if (state.cache.prevPromptTokens > 0) {
          state.cache.pendingSystemRewrite = true
          const prices = currentPrices(state.model, Date.now())
          const estimated = (prices.miss - prices.hit) * state.cache.prevPromptTokens
          if (estimated >= 0.001) {
            pushAdvisory(state, 'system-rewrite',
              `系统提示词发生改写：前缀可能失效，下一次请求预计多付 ¥${estimated.toFixed(4)}。` +
              '若提示词变化来自插件/动态内容，考虑改为追加到历史而不是改写 system。', estimated)
          }
        }
        return
      }
      if (type.startsWith('compaction/') || type === 'compact/checkpoint' || type === 'context/compacted') {
        const state = ensureSession(sessionId)
        state.compactionEvents += 1
        noteCause(sessionId, 'compaction', type)
        if (state.cache.prevPromptTokens > 0) {
          state.cache.pendingCompaction = true
          const prices = currentPrices(state.model, Date.now())
          const estimated = (prices.miss - prices.hit) * state.cache.prevPromptTokens
          if (estimated >= 0.001) {
            pushAdvisory(state, 'post-compaction',
              `压缩重写历史：下一次请求的新前缀预计整段未命中，约多付 ¥${estimated.toFixed(4)}。` +
              '压缩是防溢出手段；会话还会继续很多轮时才划算。', estimated)
          }
        }
        return
      }
      if (type.includes('image') && type.includes('offload')) {
        noteCause(sessionId, 'image-offload', type)
        return
      }
      if (type === 'turn/end') {
        finalizeTurn(sessionId)
      }
    } catch (error) {
      console.error('token-governor: session/event trace failed', error)
    }
  })

  function finalizeTurn(sessionId) {
    const state = sessions.get(sessionId)
    if (state === undefined) return
    if (state.turn.totals.requests === 0) return
    if (state.lastFinalizedTurn === state.turn.number) return
    state.lastFinalizedTurn = state.turn.number
    state.turns.push({
      turn: state.turn.number,
      requests: state.turn.totals.requests,
      outputTokens: state.turn.totals.outputTokens,
      cost: state.turn.totals.cost,
      at: Date.now(),
    })
    if (state.turns.length > 20) state.turns.shift()
  }

  // ---------- think-budget: effort scheduling at step boundaries ----------
  ctx.on('agent/created', async function (payload) {
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return
      const state = ensureAgent(sessionId, agent)
      const selection = selectionOf(agent)
      if (state.originalEffort === undefined) {
        const configured = agent?.options?.reasoningEffort
        if (configured !== undefined) state.originalEffort = configured
        else if (selection?.reasoningEffort !== undefined) state.originalEffort = selection.reasoningEffort
      }
      ensureSession(sessionId, modelOf(agent))
      // Static tool-schema budget: restricting tools at creation keeps the
      // first request's declarations stable for that session (no cache break),
      // unlike changing them mid-session.
      const budget = cfg.toolBudget
      if (budget?.enabled === true && Array.isArray(budget.deny) && budget.deny.length > 0) {
        try {
          agent.ctx.tools.restrict({ deny: budget.deny })
        } catch (error) {
          console.error('token-governor: toolBudget restrict failed', error)
        }
      }
      // Prompt style: fixed experiment variant or the configured terse style.
      // Scoped to this agent at creation, so the cached prefix stays stable.
      const style = pickStyleVariant()
      if (style !== null && style.text.length > 0) {
        try {
          agent.ctx.systemPrompt.section({ name: 'token-governor:style', order: 9500, text: style.text })
          terseVerifications.push({ sessionId, at: Date.now(), mode: style.name })
          terseAgents.set(sessionId, style.name)
          if (terseVerifications.length > 10) terseVerifications.shift()
        } catch (error) {
          console.error('token-governor: style section failed', error)
        }
      }
      // Opt-in subagent model routing: fresh child agents have no cached prefix,
      // so a cheaper model is cache-safe for them.
      if (cfg.subagentRoute?.enabled === true && agent?.session?.header?.parentSession !== undefined) {
        try {
          const route = cfg.subagentRoute
          await agent.model.select({
            provider: route.provider,
            model: route.model,
            ...(route.effort === null || route.effort === undefined ? {} : { effort: route.effort }),
          })
        } catch (error) {
          console.error('token-governor: subagent route failed', error)
        }
      }
    } catch (error) {
      console.error('token-governor: agent/created failed', error)
    }
    return undefined
  })

  ctx.on('agent/pre-step', async function (payload, next) {
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId !== undefined) {
        const state = ensureSession(sessionId, modelOf(agent))
        const policyState = ensureAgent(sessionId, agent)
        if (state.turn.number !== payload.turn) {
          // New turn: the closed turn was already summarized at `turn/end`.
          state.turn = { number: payload.turn, totals: emptyTotals(), softExceeded: false, warned: false }
          policyState.lastTurn = payload.turn
        }
        const selection = payload?.modelSelection ?? selectionOf(agent)
        if (selection !== undefined && selection.reasoningEffort !== undefined) {
          state.effort.currentEffort = selection.reasoningEffort
          if (policyState.originalEffort === undefined) policyState.originalEffort = selection.reasoningEffort
        }
        // Cache governor: warn BEFORE a resumed session pays for a cold prefix.
        if (state.lastRequestAt > 0 && state.cache.prevPromptTokens > 0) {
          const governor = cfg.cacheGovernor ?? {}
          const idleMs = Date.now() - state.lastRequestAt
          const idleColdMs = (governor.idleColdMinutes ?? 30) * 60000
          const warnGap = 10 * 60000
          if (idleMs >= idleColdMs && state.cache.prevPromptTokens >= (governor.warnPromptTokens ?? 20000) &&
            Date.now() - (state.cache.lastIdleWarnAt ?? 0) > warnGap) {
            const prices = currentPrices(modelOf(agent) ?? state.model, Date.now())
            const estimated = (prices.miss - prices.hit) * state.cache.prevPromptTokens
            state.cache.lastIdleWarnAt = Date.now()
            pushAdvisory(state, 'idle-risk',
              `距上次请求 ${Math.round(idleMs / 60000)} 分钟：前缀缓存可能已过期，下一次请求预计整段未命中，` +
              `约多付 ¥${estimated.toFixed(4)}（${formatInt(state.cache.prevPromptTokens)} tokens 上下文）。` +
              '如果只是简单问题，新开会话更省。', estimated)
          }
        }
        if (cfg.effortPolicy?.enabled !== false && policyState.effortRiskSuspended !== true) {
          const escalated = policyState.escalatedTurn === payload.turn
          // The selection for THIS step is already captured; a select() here
          // targets the next unprepared step, so step 1 schedules step 2+.
          const phase = escalated ? 'escalated' : 'continuation'
          const decision = decideEffort({
            selection,
            phase,
            policy: cfg.effortPolicy,
            originalEffort: policyState.originalEffort,
          })
          if (decision !== null) {
            applyEffort(agent, sessionId, decision.reasoningEffort, decision.reason)
          }
        }
        // ---------- output governance: cheap steps get a cheaper effort ----------
        // Only continuation steps (payload.step > 1) whose PREVIOUS main output was
        // very short ("just call the next tool" steps) are downshifted; errors
        // escalate, and turn end restores. Guarded vs unguarded output is tracked
        // so /token can show whether it actually saved tokens.
        const outGuard = cfg.outputGuard
        if (outGuard?.enabled !== false && policyState.effortRiskSuspended !== true &&
          payload.step > 1 && policyState.escalatedTurn !== payload.turn &&
          state.lastMainOutputTokens !== undefined &&
          state.lastMainOutputTokens < (outGuard.lowOutputBelowTokens ?? 250)) {
          const target = ['off', 'low', 'high'].includes(outGuard.downshiftEffort) ? outGuard.downshiftEffort : 'low'
          const before = selection?.reasoningEffort ?? state.effort.currentEffort
          if (before !== target) {
            applyEffort(agent, sessionId, target, `short-step downshift (prev output ${state.lastMainOutputTokens} tokens)`)
            policyState.outputDownshifted = true
            policyState.outputGuardedStep = true
            policyState.outputDownshiftCount += 1
            state.outputGuard.downshifts += 1
          }
        }
        // ---------- budget protection: same task, less money ----------
        const budget = cfg.budget
        if (budget !== undefined && budget.mode !== 'off' && budget.mode !== undefined && policyState.effortRiskSuspended !== true) {
          const limit = budget.mode === 'turn' ? (budget.maxTurnCost ?? 0) : (budget.maxSessionCost ?? 0)
          const spent = budget.mode === 'turn' ? state.turn.totals.cost : state.totals.cost
          if (limit > 0) {
            if (budget.mode === 'turn' && payload.turn !== policyState.budgetWarnedTurn) {
              policyState.budgetWarnedTurn = payload.turn
              policyState.budgetDownshifted = false
            }
            const ratio = spent / limit
            if (ratio >= (budget.softRatio ?? 0.8) && policyState.budgetDownshifted !== true) {
              policyState.budgetDownshifted = true
              const effort = ['off', 'low', 'high'].includes(budget.downshiftEffort) ? budget.downshiftEffort : 'low'
              applyEffort(agent, sessionId, effort, `budget protect (${budget.mode} ${Math.round(ratio * 100)}%)`)
              pushAdvisory(state, 'budget-protect',
                `预算保护：${budget.mode === 'turn' ? '本轮' : '本会话'}已花 ${formatMoney(spent, cfg.currency)} / 上限 ` +
                `${formatMoney(limit, cfg.currency)}（${Math.round(ratio * 100)}%），后续续步降为 ${effort}。` +
                '任务继续，但思考更省。', spent)
            }
          }
        }
        // ---------- context-volume advisor (new task -> new session) ----------
        const contextAdvice = cfg.contextAdvice
        if (contextAdvice?.enabled !== false && payload.step === 1 &&
          state.cache.prevPromptTokens >= (contextAdvice.minContextTokens ?? 150000) &&
          state.lastContextAdviceTurn !== payload.turn) {
          state.lastContextAdviceTurn = payload.turn
          const px = currentPrices(modelOf(agent) ?? state.model, Date.now())
          const contextCost = state.cache.prevPromptTokens * px.hit
          const expectedNew = contextAdvice.newSessionExpectedTokens ?? 25000
          const savingPerRequest = Math.max(0, state.cache.prevPromptTokens - expectedNew) * px.hit
          pushAdvisory(state, 'context-volume',
            `上下文体积 ${formatInt(state.cache.prevPromptTokens)} tokens：每请求仅上下文成本约 ` +
            `${formatMoney(contextCost, cfg.currency)}；**若是新任务，新开会话**每请求预计省 ` +
            `${formatMoney(savingPerRequest, cfg.currency)}（冷启动一次性成本另计）。`, savingPerRequest)
        }
        // ---------- compaction alternative: dense handoff digest ----------
        const digest = cfg.compactionDigest
        if (digest?.enabled !== false && payload.step === 1 &&
          state.cache.prevPromptTokens >= (digest.minContextTokens ?? 150000) &&
          state.lastDigestAdviceTurn !== payload.turn) {
          state.lastDigestAdviceTurn = payload.turn
          pushAdvisory(state, 'compaction-digest',
            `上下文 ${formatInt(state.cache.prevPromptTokens)} tokens：可用 **/token handoff** 生成交接单（约 30 行）后开新会话，` +
            '通常比 /compact 之后仍常驻 ~130k 检查点更省；交接单含成本、工具与落盘原文路径。', 0)
        }
      }
    } catch (error) {
      console.error('token-governor: pre-step policy failed', error)
    }
    return next()
  })

  function applyEffort(agent, sessionId, effort, reason) {
    try {
      const selection = selectionOf(agent)
      if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return false
      if (selection.reasoningEffort === effort) return false
      const policyState = ensureAgent(sessionId, agent)
      const state = ensureSession(sessionId, selection.model)
      const order = ['off', 'low', 'high', 'max']
      const downshift = order.indexOf(effort) < order.indexOf(selection.reasoningEffort ?? 'high')
      // Prevention: never take the cache risk above a configured context size.
      const guard = cfg.effortPolicy?.switchGuard ?? {}
      if (downshift && guard.enabled !== false && (guard.maxContextTokens ?? 0) > 0 &&
        state.cache.prevPromptTokens > guard.maxContextTokens) {
        state.effort.skipped += 1
        pushAdvisory(state, 'effort-switch-skipped',
          `跳过强度降档：当前上下文 ${formatInt(state.cache.prevPromptTokens)} tokens 超过切换保护阈值 ` +
          `${formatInt(guard.maxContextTokens)}，避免切换引发整段缓存 miss。`, 0)
        return false
      }
      // Record before dispatching: session/event fires synchronously from
      // select(), and the handler must recognize this as our own choice.
      policyState.ourSelects.push({ effort, ts: Date.now() })
      if (policyState.ourSelects.length > 12) policyState.ourSelects.shift()
      try {
        agent.model.select({
          provider: selection.provider,
          model: selection.model,
          ...effort === undefined ? {} : { reasoningEffort: effort },
        })
      } catch (error) {
        policyState.ourSelects.pop()
        throw error
      }
      policyState.appliedEffort = effort
      if (downshift) {
        // Watch the next main request: if the prefix cache collapses right
        // after this switch, classify it as effort-change and roll back.
        state.effort.watch = {
          from: selection.reasoningEffort,
          to: effort,
          provider: selection.provider,
          model: selection.model,
          prevPrompt: state.cache.prevPromptTokens,
          at: Date.now(),
        }
      }
      state.effort.currentEffort = effort
      state.effort.applications += 1
      state.effort.lastDecision = reason
      if (effort === 'off' || effort === 'low') state.effort.downshifts += 1
      else if (reason.startsWith('escalat') || reason.includes('escalated')) state.effort.escalations += 1
      return true
    } catch (error) {
      console.error('token-governor: model.select failed', error)
      return false
    }
  }

  /** Roll back one risky effort switch and suspend further automatic downshifts. */
  function rollbackEffortSwitch(state, policyState, sessionId, risk, prices) {
    state.effort.rollbacks += 1
    if (policyState !== undefined) policyState.effortRiskSuspended = true
    const live = liveAgentsOf(ctx).find((agent) => sessionIdOf(agent) === sessionId)
    if (live !== undefined) {
      try {
        live.model.select({ provider: risk.provider, model: risk.model, reasoningEffort: risk.from })
      } catch (error) {
        console.error('token-governor: rollback select failed', error)
      }
    }
    const lost = (prices.miss - prices.hit) * risk.loss
    pushAdvisory(state, 'effort-rollback',
      `强度切换（${risk.from ?? 'default'}→${risk.to}）后出现整段缓存失效：损失约 ` +
      `${formatMoney(lost, cfg.currency)}。已自动回滚到 ${risk.from ?? '原强度'}，并暂停本会话的自动降档。`,
      lost)
  }

  ctx.on('agent/turn-stopping', async function (payload) {
    try {
      const agent = payload?.agent
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined) return undefined
      const policyState = ensureAgent(sessionId, agent)
      const effortRestore = cfg.effortPolicy?.enabled !== false && cfg.effortPolicy?.restoreAtTurnEnd !== false
      const budgetRestore = cfg.budget?.mode === 'turn' && policyState.budgetDownshifted === true
      const outputRestore = cfg.outputGuard?.enabled !== false && policyState.outputDownshifted === true
      if (effortRestore || budgetRestore || outputRestore) {
        if (policyState.originalEffort !== undefined) {
          applyEffort(agent, sessionId, policyState.originalEffort, 'restore at turn end')
        }
        if (budgetRestore) policyState.budgetDownshifted = false
        if (outputRestore) {
          policyState.outputDownshifted = false
          policyState.outputRestoredAt = Date.now()
        }
      }
    } catch (error) {
      console.error('token-governor: turn-stopping restore failed', error)
    }
    return undefined
  })

  ctx.on('agent/request-error', async function (payload, next) {
    try {
      const sessionId = sessionIdOf(payload?.agent)
      if (sessionId !== undefined) {
        const state = ensureSession(sessionId)
        state.retries += 1
        if (cfg.effortPolicy?.enabled !== false && cfg.effortPolicy?.escalateOnError !== false) {
          const policyState = ensureAgent(sessionId, payload.agent)
          policyState.escalatedTurn = payload.turn
          noteCause(sessionId, 'request-error', 'model request failed; effort escalated')
        }
      }
    } catch (error) {
      console.error('token-governor: request-error hook failed', error)
    }
    return next()
  })

  // ---------- tool call accounting ----------
  ctx.on('tools/pre-execute', async function (exec, next) {
    diagnostics.preExecute += 1
    // Source-side limiting (opt-in, default off): stop an allow-listed read-only
    // command from dumping thousands of lines that we would only compress after
    // the fact. Only a single simple command (no pipes/redirects/operators) is
    // patched, so no compound-command segment escapes the cap.
    try {
      const limits = cfg.sourceLimits
      const name = String(exec?.name ?? '')
      if (limits?.enabled === true) {
        const suffix = outputLimitSuffix(name, limits.bashHeadLines ?? 400)
        const holder = exec?.input ?? exec?.args ?? exec?.arguments
        if (suffix !== null && holder !== null && typeof holder === 'object') {
          const key = typeof holder.command === 'string' ? 'command'
            : typeof holder.cmd === 'string' ? 'cmd' : undefined
          if (key !== undefined && isSimpleShellCommand(holder[key])) {
            const first = firstShellToken(holder[key])
            const allow = Array.isArray(limits.allowlist)
              ? limits.allowlist.map((entry) => String(entry).toLowerCase())
              : []
            if (allow.includes(first)) {
              holder[key] = holder[key] + suffix
              diagnostics.sourceRewrites += 1
              diagnostics.lastSourceRewriteAt = Date.now()
            }
          }
        }
      }
    } catch (error) {
      console.error('token-governor: source limit rewrite failed', error)
    }
    try {
      const name = String(exec?.name ?? '?')
      const sessionId = sessionIdOf(exec?.agent)
      globalToolCalls.total += 1
      globalToolCalls.byName[name] = (globalToolCalls.byName[name] ?? 0) + 1
      if (SEARCH_TOOLS.has(name)) {
        if (name.includes('fetch')) globalToolCalls.fetchCalls += 1
        else globalToolCalls.searchCalls += 1
      }
      if (sessionId !== undefined) {
        const state = ensureSession(sessionId)
        state.tools.total += 1
        state.tools.byName[name] = (state.tools.byName[name] ?? 0) + 1
        try {
          const fingerprint = `${name}|${JSON.stringify(exec?.arguments ?? null).slice(0, 300)}`
          if (state.tools.fp !== undefined) {
            state.tools.fp.add(fingerprint)
            if (state.tools.fp.size > 400) state.tools.fp.delete(state.tools.fp.values().next().value)
          }
        } catch {}
        if (SEARCH_TOOLS.has(name)) {
          if (name.includes('fetch')) state.tools.fetchCalls += 1
          else state.tools.searchCalls += 1
        }
      }
    } catch (error) {
      console.error('token-governor: tool accounting failed', error)
    }
    return next()
  })

  ctx.on('tools/post-execute', async function (exec, result, next) {
    diagnostics.postExecute += 1
    diagnostics.lastPostExecuteAt = Date.now()
    const decision = await next()
    if (result?.isError === true) {
      const segment = abSegments[abSegments.length - 1]
      if (segment !== undefined) segment.toolErrors = (segment.toolErrors ?? 0) + 1
    }
    try {
      if (result?.isError === true && cfg.effortPolicy?.escalateOnToolError !== false) {
        const sessionId = sessionIdOf(exec?.agent)
        if (sessionId !== undefined) {
          const policyState = ensureAgent(sessionId, exec?.agent)
          const state = sessions.get(sessionId)
          const turn = state?.turn?.number
          if (policyState.escalatedTurn === undefined) {
            policyState.escalatedTurn = turn
            noteCause(sessionId, 'tool-error', `tool "${String(exec?.name ?? '?')}" failed; effort escalated`)
          }
        }
      }
    } catch (error) {
      console.error('token-governor: tool error escalation failed', error)
    }
    return decision
  })

  /** Write the full text to a bounded spill file; returns its path or null. */
  function spillFullText(state, text, toolName) {
    try {
      const out = cfg.toolOutput
      const dir = out.spillDir || path.join(os.tmpdir(), 'dsh-token-governor-spill', shortId(state.id))
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${toolName.replace(/[^\w.-]/g, '_')}-${hashString(text.slice(0, 64) + text.length)}.txt`)
      if (!fs.existsSync(file)) fs.writeFileSync(file, text, 'utf8')
      cleanupSpillDir(dir)
      return file
    } catch {
      return null
    }
  }

  /** Near-duplicate detection: same output shape, a few changed lines. */
  function nearToolDuplicate(state, text, toolName, out) {
    if (out?.nearDedupeEnabled === false) return null
    const lines = text.split('\n')
    if (lines.length < 20) return null
    const normalized = []
    for (const line of lines) {
      const item = normalizeToolLine(line)
      if (item.length > 0) normalized.push(item)
    }
    if (normalized.length < 10) return null
    const now = Date.now()
    const remember = () => {
      state.toolOut.near.set(`n${now}-${normalized.length}`, { ts: now, lines: normalized.slice(0, 400) })
      while (state.toolOut.near.size > 60) state.toolOut.near.delete(state.toolOut.near.keys().next().value)
    }
    let best = null
    for (const [, entry] of state.toolOut.near) {
      if (now - entry.ts > (out.nearDedupeTtlMs ?? 900000)) continue
      const similarity = lineSimilarity(normalized.slice(0, 400), entry.lines)
      if (best === null || similarity > best.similarity) best = { entry, similarity }
    }
    if (best === null || best.similarity < (out.nearDedupeMinSimilarity ?? 0.9)) {
      remember()
      return null
    }
    const changed = changedToolLines(
      normalized.slice(0, 400), best.entry.lines, (out.nearDedupeMaxDiffLines ?? 12) + 1)
    if (changed.length > (out.nearDedupeMaxDiffLines ?? 12)) {
      remember()
      return null
    }
    best.entry.ts = now
    return { similarity: best.similarity, changed }
  }

  // ---------- reversible tool-output compression (merged from save-token) ----
  let lastSpillCleanup = 0
  /** Bounded spill storage: prune expired/overflow files (best effort). */
  function cleanupSpillDir(dir) {    const now = Date.now()
    if (now - lastSpillCleanup < 10 * 60000) return
    lastSpillCleanup = now
    try {
      const retentionMs = (cfg.toolOutput?.spillRetentionHours ?? 72) * 3600000
      const maxFiles = cfg.toolOutput?.maxSpillFilesPerSession ?? 40
      const entries = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const full = path.join(dir, entry.name)
        try {
          const stat = fs.statSync(full)
          entries.push({ full, mtimeMs: stat.mtimeMs })
        } catch {}
      }
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (let i = 0; i < entries.length; i += 1) {
        if (now - entries[i].mtimeMs > retentionMs || i >= maxFiles) {
          try { fs.unlinkSync(entries[i].full) } catch {}
        }
      }
    } catch {}
  }
  let officialSpillCache
  let officialSpillBudget
  /** Whether the official spill-policy row is live (checked once, lazily). */
  function officialSpillActive() {
    if (officialSpillCache !== undefined) return officialSpillCache
    const rows = loaderRows()
    const row = rows === null ? undefined : rows.find((entry) => entry.id === 'spill-policy' && entry.active === true)
    officialSpillCache = row !== undefined
    const configured = Number(row?.config?.maxInlineTokens)
    if (Number.isFinite(configured) && configured > 0) officialSpillBudget = configured
    return officialSpillCache
  }
  /** Head/tail window + error lines, full original spilled to a file. */
  function compressToolOutput(state, text, toolName, isError, extraContent) {
    const out = cfg.toolOutput
    if (out?.compressEnabled === false || typeof text !== 'string') return null
    if ((out.exemptTools ?? []).includes(toolName)) return null
    const bytes = Buffer.byteLength(text, 'utf8')
    const threshold = isError ? (out.errorMinBytes ?? 6000) : (out.minBytes ?? 1400)
    if (bytes < threshold) return null
    const now = Date.now()
    if (out.dedupeEnabled !== false) {
      const fp = `${toolName}:${hashString(text)}:${bytes}`
      const prev = state.toolOut.dedupe.get(fp)
      if (prev !== undefined && now - prev.ts <= (out.dedupeTtlMs ?? 600000)) {
        const ago = Math.round((now - prev.ts) / 1000)
        const stub = `[token-governor dedupe: this ${toolName} output is BYTE-IDENTICAL to one from ${ago}s ago and is already in context above. Full copy: ${prev.locator}]`
        state.toolOut.deduped += 1
        state.toolOut.bytesBefore += bytes
        state.toolOut.bytesAfter += Buffer.byteLength(stub, 'utf8')
        state.toolOut.tokensBefore += estimateTextTokens(text)
        state.toolOut.tokensAfter += estimateTextTokens(stub)
        return stub
      }
    }
    if (out.nearDedupeEnabled !== false) {
      const near = nearToolDuplicate(state, text, toolName, out)
      if (near !== null) {
        const locator = spillFullText(state, text, toolName)
        if (locator !== null) {
          const diffText = near.changed.length === 0
            ? 'no content lines changed'
            : `changed/added lines:\n${near.changed.slice(0, out.nearDedupeMaxDiffLines ?? 12).join('\n')}`
          const stub = `[token-governor near-dupe ${toolName}: ~${Math.round(near.similarity * 100)}% identical to an earlier output; ${diffText}\nfull original: ${locator}]`
          state.toolOut.nearDeduped += 1
          state.toolOut.bytesBefore += bytes
          state.toolOut.bytesAfter += Buffer.byteLength(stub, 'utf8')
          state.toolOut.tokensBefore += estimateTextTokens(text)
          state.toolOut.tokensAfter += estimateTextTokens(stub)
          return stub
        }
      }
    }
    const lines = text.split('\n')
    const errorRe = /error|fatal|failed|exception|traceback|timeout|denied|refused/i
    const errorLines = []
    /** Keep matched lines plus one neighbour on each side for context. */
    const keepErrorNeighbours = (source, offset) => {
      const kept = new Set()
      for (let i = 0; i < source.length && kept.size < (out.errorLineCap ?? 25) * 3; i += 1) {
        if (!errorRe.test(source[i])) continue
        for (let delta = -1; delta <= 1; delta += 1) {
          const j = i + delta
          if (j >= 0 && j < source.length) kept.add(j)
        }
      }
      for (const j of [...kept].sort((a, b) => a - b)) errorLines.push(`${offset + j + 1}: ${source[j]}`)
    }
    // Compress harder for very large results so one output cannot raise the
    // whole session's context watermark.
    const approxTextTokens = estimateTextTokens(text)
    const aggressiveBudget = approxTextTokens >= (cfg.compressionBudget?.aggressiveAboveTokens ?? 2500)
    const aggressiveTarget = aggressiveBudget
      ? (cfg.compressionBudget?.aggressiveTargetRatio ?? 0.3)
      : 1
    let body
    let structured = false
    if (lines.length >= (out.minLines ?? 60)) {
      const headLines = Math.min(out.headLines ?? 120, Math.max(2, Math.floor(lines.length * 0.55)))
      const tailLines = Math.min(out.tailLines ?? 60, Math.max(1, Math.floor(lines.length * 0.25)))
      const head = lines.slice(0, headLines)
      const tail = lines.slice(-tailLines)
      const middle = lines.slice(headLines, lines.length - tailLines)
      // Per-tool retention profile: AGORA-style keep floors + landmark lines.
      const profile = (() => {
        if (toolName === 'read') {
          return {
            targetRatio: out.readTargetRatio ?? 0.4,
            landmarks: /^\s*(?:import |from |export |class |def |function |interface |type |enum |const |let |var |async |public |private |protected |#include|\/\/|#\s|TODO|FIXME|describe\(|it\(|test\()/,
          }
        }
        if (toolName === 'grep' || toolName === 'grep_search' || toolName === 'search') {
          return { targetRatio: 0.5, diverse: true }
        }
        // Path listings (glob/ls/find/tree) are one-item-per-line: uniform
        // stride sampling is safe and keeps head+tail for orientation.
        if (LIST_TOOL_RE.test(toolName)) {
          return { targetRatio: out.listTargetRatio ?? 0.45 }
        }
        return { targetRatio: out.tabularTargetRatio ?? 0.5, landmarks: errorRe }
      })()
      const tabHeadRows = Math.min(out.tabularHeadRows ?? 40, Math.max(2, Math.floor(lines.length * 0.3)))
      const tabTailRows = Math.min(out.tabularTailRows ?? 20, Math.max(1, Math.floor(lines.length * 0.15)))
      const tabHead = lines.slice(0, tabHeadRows)
      const tabTail = lines.slice(-tabTailRows)
      const tabMiddle = lines.slice(tabHeadRows, lines.length - tabTailRows)
      if (tabMiddle.length > 0 && out.tabularEnabled !== false &&
        (looksStructured(lines) || LIST_TOOL_RE.test(toolName) || (profile.landmarks !== undefined && lines.length >= 60))) {
        keepErrorNeighbours(tabMiddle, tabHead.length)
        const landmarkLines = []
        if (toolName === 'read' && profile.landmarks !== undefined) {
          for (let i = 0; i < tabMiddle.length && landmarkLines.length < 40; i += 1) {
            if (profile.landmarks.test(tabMiddle[i])) landmarkLines.push(`${tabHead.length + i + 1}: ${tabMiddle[i]}`)
          }
        }
        const targetRatio = Math.min(profile.targetRatio, aggressiveTarget)
        let stride = 2
        while (stride <= (out.tabularMaxStride ?? 256)) {
          let sampled = []
          if (profile.diverse === true) {
            const prefixes = new Map()
            for (let i = 0; i < tabMiddle.length; i += 1) {
              const key = tabMiddle[i].split(':')[0].slice(0, 80)
              if (!prefixes.has(key)) prefixes.set(key, i)
              if (prefixes.size >= 60) break
            }
            sampled = [...prefixes.values()].map((index) => `${tabHead.length + index + 1}: ${tabMiddle[index]}`)
          } else {
            for (let i = 0; i < tabMiddle.length; i += stride) {
              sampled.push(`${tabHead.length + i + 1}: ${tabMiddle[i]}`)
            }
          }
          const candidate = [...tabHead,
            `… [kept ${sampled.length} of ${tabMiddle.length} middle lines` +
            `${profile.diverse === true ? ' (one per result prefix)' : ` (1 in ${stride})`}; full text at the locator below]`,
            ...landmarkLines,
            ...errorLines,
            ...sampled,
            ...tabTail].join('\n')
          if (Buffer.byteLength(candidate, 'utf8') / bytes <= targetRatio) { body = candidate; structured = true; break }
          if (profile.diverse === true) break
          stride *= 2
        }
      }
      if (body === undefined) {
        keepErrorNeighbours(middle, head.length)
        body = [...head,
          `… [elided ${Math.max(0, middle.length - errorLines.length)} lines${errorLines.length > 0 ? '; error lines kept below' : ''}; full text at the locator below]`,
          ...errorLines,
          ...tail].join('\n')
      }
    } else if (lines.length > 1) {
      return null
    } else {
      const cap = out.longLineChars ?? 400
      if (text.length <= cap * 2) return null
      body = text.slice(0, cap) + `\n… [${text.length - cap * 2} chars elided; full text at the locator below] …\n` + text.slice(-cap)
    }
    const afterBytes = Buffer.byteLength(body, 'utf8')
    if (afterBytes >= bytes || afterBytes / bytes > (out.keepRatioMax ?? 0.7) || bytes - afterBytes < (out.minSavingBytes ?? 500)) return null
    const locator = spillFullText(state, text, toolName)
    if (locator === null) {
      state.toolOut.skipped += 1
      return null
    }
    state.toolOut.compressed += 1
    if (structured) state.toolOut.structured += 1
    if (aggressiveBudget) state.toolOut.aggressiveCompressed = (state.toolOut.aggressiveCompressed ?? 0) + 1
    state.toolOut.spills.push(locator)
    if (state.toolOut.spills.length > 30) state.toolOut.spills.shift()
    state.toolOut.bytesBefore += bytes
    state.toolOut.tokensBefore += estimateTextTokens(text)
    state.toolOut.tokensAfter += estimateTextTokens(`[token-governor compress ${toolName}: ${bytes}B→${afterBytes}B; full original: ${locator}]\n${body}`)
    state.toolOut.bytesAfter += afterBytes
    if (out.dedupeEnabled !== false) {
      state.toolOut.dedupe.set(`${toolName}:${hashString(text)}:${bytes}`, { ts: now, locator })
      if (state.toolOut.dedupe.size > 200) state.toolOut.dedupe.delete(state.toolOut.dedupe.keys().next().value)
    }
    return `[token-governor compress ${toolName}: ${bytes}B→${afterBytes}B; full original: ${locator}]\n${body}`
  }

  /** Startup sweep across all session spill dirs (bounded retention). */
  function cleanupAllSpills() {
    try {
      const root = path.join(os.tmpdir(), 'dsh-token-governor-spill')
      if (!fs.existsSync(root)) return
      const retentionMs = (cfg.toolOutput?.spillRetentionHours ?? 72) * 3600000
      const maxFiles = cfg.toolOutput?.maxSpillFilesPerSession ?? 40
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root, entry.name)
        try {
          const files = []
          for (const fileEntry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!fileEntry.isFile()) continue
            const full = path.join(dir, fileEntry.name)
            try { files.push({ full, mtimeMs: fs.statSync(full).mtimeMs }) } catch {}
          }
          files.sort((a, b) => b.mtimeMs - a.mtimeMs)
          for (let i = 0; i < files.length; i += 1) {
            if (Date.now() - files[i].mtimeMs > retentionMs || i >= maxFiles) {
              try { fs.unlinkSync(files[i].full) } catch {}
            }
          }
        } catch {}
      }
    } catch {}
  }

  // ---------- lossless JSON -> TSV re-encoding at tool-result write time ----
  // Registered with prepend so it is the outermost tools/post-execute wrapper:
  // it sees what deeper listeners (e.g. save-token) decided and steps aside
  // when they already transformed the text. Applies at generation time, so the
  // result enters history already compact and the cached prefix is untouched.
  ctx.on('tools/post-execute', async function (exec, result, next) {
    const decision = await next()
    try {
      const sessionId = sessionIdOf(exec?.agent)
      const state = sessionId === undefined ? undefined : ensureSession(sessionId)
      if (state !== undefined) {
        state.toolOut.lastKind = String(decision?.kind ?? 'none')
        state.toolOut.lastToolAny = String(exec?.name ?? 'tool')
        const anyContent = decision?.content !== undefined ? decision.content : result?.content
        state.toolOut.lastAnyContentLen = Array.isArray(anyContent) && anyContent[0]?.text !== undefined
          ? String(anyContent[0].text).length
          : -1
        state.toolOut.lastBlockCount = Array.isArray(anyContent) ? anyContent.length : -1
        state.toolOut.lastTotalChars = Array.isArray(anyContent)
          ? anyContent.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0)
          : -1
        state.toolOut.lastResultChars = Array.isArray(result?.content)
          ? result.content.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0), 0)
          : -1
      }
      if (cfg.tsvCodec?.enabled === false || decision?.kind !== 'accept') return decision
      if (state !== undefined) {
        const debugContent = decision.content !== undefined ? decision.content : result?.content
        state.toolOut.lastDecision = Object.keys(decision ?? {}).join('|')
        state.toolOut.lastHasValue = Object.prototype.hasOwnProperty.call(decision ?? {}, 'value')
        state.toolOut.lastContentLen = Array.isArray(debugContent)
          ? (debugContent[0]?.text !== undefined ? String(debugContent[0].text).length : -1)
          : -2
      }
      if (Object.prototype.hasOwnProperty.call(decision, 'value')) {
        if (state !== undefined) state.codec.valueSkipped += 1
        return decision
      }
      const content = decision.content !== undefined ? decision.content : result?.content
      if (!Array.isArray(content) || content.length !== 1) {
        if (state !== undefined) state.codec.shapeSkipped += 1
        return decision
      }
      const block = content[0]
      if (block?.type !== 'text' || typeof block.text !== 'string') {
        if (state !== undefined) state.codec.shapeSkipped += 1
        return decision
      }
      // Repeated unchanged `read`: the content is already above in the session.
      if (state !== undefined && cfg.readReuse?.enabled !== false &&
        String(exec?.name ?? '') === 'read' && result?.isError !== true) {
        const args = exec?.arguments ?? {}
        const filePath = typeof args.file_path === 'string' ? args.file_path
          : (typeof args.path === 'string' ? args.path : undefined)
        if (filePath !== undefined) {
          try {
            const stat = fs.statSync(filePath)
            const offset = Number(args.offset ?? 0)
            const limit = Number(args.limit ?? 0)
            const key = `${filePath}|${offset}|${limit}`
            const previous = state.readCache.get(key)
            if (previous !== undefined && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
              state.readReused += 1
              const stub = `[token-governor read-reuse: ${filePath} is unchanged since the earlier read in this session ` +
                `(${Math.round((Date.now() - previous.ts) / 1000)}s ago); the same content is already above — ` +
                'do not re-read unless you need exact lines again.]'
              return {
                kind: 'accept',
                content: [{ type: 'text', text: stub }],
                ...(Array.isArray(decision.additionalContexts) && decision.additionalContexts.length > 0
                  ? { additionalContexts: decision.additionalContexts }
                  : {}),
              }
            }
            state.readCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, ts: Date.now() })
            if (state.readCache.size > 100) state.readCache.delete(state.readCache.keys().next().value)
          } catch {}
        }
      }
      if (state !== undefined) {
        state.toolOut.lastLen = block.text.length
        state.toolOut.lastLines = block.text.split('\n').length
        state.toolOut.lastTool = String(exec?.name ?? 'tool')
      }
      if (block.text.includes('[save-token') || block.text.includes('#tsv lossless') || block.text.includes('[token-governor')) {
        if (state !== undefined) state.codec.deferred += 1
        return decision
      }
      // Coordination with the official spill policy: it owns results at or
      // above its own token budget, and its notice format means it already
      // replaced this one. Never rewrite the same result twice.
      if (/Omitted \d+ bytes\. Full formatted result stored at:/.test(block.text)) {
        if (state !== undefined) state.toolOut.markerDeferred += 1
        return decision
      }
      const approxTokens = Math.ceil(block.text.length / 4)
      if (officialSpillActive() && approxTokens >= (officialSpillBudget ?? cfg.toolOutput?.spillPolicyMaxInlineTokens ?? 12500)) {
        if (state !== undefined) state.toolOut.officialDeferred += 1
        return decision
      }
      const skip = cfg.tsvCodec?.skipTools ?? []
      if (skip.includes(String(exec?.name ?? ''))) {
        if (state !== undefined) state.codec.toolSkipped += 1
        return decision
      }
      const encoded = encodeUniformJsonArray(block.text, cfg.tsvCodec)
      if (encoded !== null) {
        if (state !== undefined) {
          state.codec.applied += 1
          state.codec.before += encoded.before
          state.codec.after += encoded.after
          state.codec.tokensBefore += estimateTextTokens(block.text)
          state.codec.tokensAfter += estimateTextTokens(encoded.text)
        }
        return {
          kind: 'accept',
          content: [{ type: 'text', text: encoded.text }],
          ...(Array.isArray(decision.additionalContexts) && decision.additionalContexts.length > 0
            ? { additionalContexts: decision.additionalContexts }
            : {}),
        }
      }
      if (state !== undefined) state.codec.noJson += 1
      // Reversible text compression + cross-turn dedupe (merged from save-token).
      if (state !== undefined) {
        try {
          const replacement = compressToolOutput(state, block.text, String(exec?.name ?? 'tool'), result?.isError === true)
          if (replacement !== null) {
            return {
              kind: 'accept',
              content: [{ type: 'text', text: replacement }],
              ...(Array.isArray(decision.additionalContexts) && decision.additionalContexts.length > 0
                ? { additionalContexts: decision.additionalContexts }
                : {}),
            }
          }
        } catch (error) {
          state.toolOut.lastError = String(error?.stack ?? error?.message ?? error).slice(0, 600)
          console.error('token-governor: tool output compression failed', error)
        }
      }
      return decision
    } catch (error) {
      console.error('token-governor: tsv codec failed', error)
    }
    return decision
  }, { prepend: true })

  // ---------- reporting ----------
  /** Tools the global history never called, sized for schema tax (new sessions). */
  function globalTrimCandidates() {
    const unique = new Map()
    for (const state of sessions.values()) {
      for (const tool of state.surface?.toolSizes ?? []) if (!unique.has(tool.name)) unique.set(tool.name, tool)
    }
    return [...unique.values()]
      .filter((tool) => (globalToolCalls.byName[tool.name] ?? 0) === 0 && tool.chars >= 300)
      .map((tool) => ({ name: tool.name, tokens: Math.round(tool.chars / 4) }))
      .sort((a, b) => b.tokens - a.tokens)
  }

  function reportTrim() {
    const minRequests = cfg.toolBudget?.minRequests ?? 15
    if (globalTotals.requests < minRequests) {
      return `样本不足：需要 ≥${minRequests} 个主请求才能判断“从未调用”，否则会误删有用的工具。`
    }
    const list = globalTrimCandidates()
    if (list.length === 0) return '当前没有“声明了但从不调用”的工具，无需裁剪。'
    const total = list.reduce((sum, tool) => sum + tool.tokens, 0)
    cfg.toolBudget.enabled = true
    cfg.toolBudget.deny = [...new Set([...(cfg.toolBudget.deny ?? []), ...list.map((tool) => tool.name)])]
    return [
      `工具固定税裁剪：已对**之后创建的新会话**禁用 ${list.length} 个从未调用的工具（≈${formatInt(total)} tokens/请求）。`,
      '运行中会话不改工具声明（改了会让前缀缓存整段失效），所以当前会话数字不变。',
      '持久化：把下面这段写进 bundle 行 config 后重启——',
      'toolBudget:',
      '  enabled: true',
      '  deny: [' + list.map((tool) => `'${tool.name}'`).join(', ') + ']',
      '撤销：/token trim off',
    ].join('\n')
  }

  /** Tools the session never called, sized for schema tax (cache-principle). */
  function unusedToolCandidates(state) {
    const minCalls = cfg.toolBudget?.minToolCalls ?? 20
    const minRequests = cfg.toolBudget?.minRequests ?? 15
    if (state.tools.total < minCalls || state.totals.mainRequests < minRequests) return null
    const sizes = state.surface.toolSizes ?? []
    if (sizes.length === 0) return null
    const unused = sizes
      .filter((tool) => (state.tools.byName[tool.name] ?? 0) === 0 && tool.chars >= 300)
      .map((tool) => ({ name: tool.name, tokens: Math.round(tool.chars / 4) }))
      .sort((a, b) => b.tokens - a.tokens)
    if (unused.length === 0) return null
    return {
      count: unused.length,
      tokens: unused.reduce((sum, tool) => sum + tool.tokens, 0),
      all: unused,
      top: unused.slice(0, 3),
    }
  }

  /** Fixed schema tax of tools this session never called, priced. */
  function computeToolTax(state, prices) {
    const candidates = unusedToolCandidates(state)
    if (candidates === null) return null
    return {
      ...candidates,
      perRequestCost: candidates.tokens * prices.hit,
      firstRequestCost: candidates.tokens * (prices.miss - prices.hit),
    }
  }

  function priceStalenessDays() {
    try {
      const [year, month, day] = String(PRICE_VERSION).split('-').map((part) => Number(part))
      const issued = Date.UTC(year, month - 1, day)
      return Math.max(0, Math.floor((Date.now() - issued) / 86400000))
    } catch {
      return 0
    }
  }

  /** Decision planner numbers, using the real model window when known. */
  function decisionNumbers(state, prices) {
    const info = state.surface.modelInfo ?? {}
    const windowSize = Number(info.contextWindow) > 0 ? Number(info.contextWindow) : 1048576
    const outputCap = Number(info.maxTokens) > 0 ? Number(info.maxTokens) : 256000
    const retention = Number(cfg.decisionRetainRatio ?? 0.16)
    const contextTokens = state.cache.prevPromptTokens
    const retained = Math.round(Math.max(0, windowSize - outputCap) * retention)
    const compactedContext = retained + 18000
    const compactPenalty = compactedContext * (prices.miss - prices.hit) + 5000 * prices.out
    const savingPerTurn = Math.max(0, contextTokens - compactedContext) * prices.hit
    return {
      contextTokens,
      windowSize,
      continuePerRequest: contextTokens * prices.hit,
      compactPerRequest: compactedContext * prices.hit,
      compactPenalty,
      breakEvenTurns: savingPerTurn > 0 ? compactPenalty / savingPerTurn : 0,
      newSessionPerRequest: 25000 * prices.hit,
      priced: prices.known !== false,
    }
  }

  /** System-prompt text for a prompt-style variant name. */
  function styleText(name) {
    if (name === 'telegraph') {
      return '为了节省 token：你的内部推理与工具调用前后的说明请用极简电报体书写，保留全部关键事实、数字、路径、结论，删去客套、重复与解释性铺陈；给用户的最终回复要简洁：直接给结论与结果，不复述、不反复解释，除非用户要求解释。代码、命令、文件内容、引用一律保持原样。'
    }
    if (name === 'dense') {
      return '为了节省 token：内部推理可用最密记号（缩写、符号、省略虚词、无语法碎片），但必须保留全部事实、数字、路径、结论与待验证项；工具调用说明用短语；给用户的最终回复用正常中文，直接给结论、不复述、不重复解释。代码、命令、文件内容、引用保持原样。'
    }
    if (name === 'classical') {
      return '为了节省 token：你的内部推理（thinking）请用极简文言文书写，文约而事备——保留全部关键事实、数字、路径、结论，不省略信息；工具调用前后的说明用极简短语；给用户的最终回复仍用正常中文清晰作答。代码、命令、文件内容、引用一律保持原样。'
    }
    if (name === 'concise') {
      return '回复要简洁：直接给结论、结果和必要细节，不复述已说内容、不重复解释；用户未要求解释时不展开原理、背景与过程。保留必要的事实、数字、路径、命令与验证结果，不要省略正确性所需的信息。'
    }
    return typeof name === 'string' && name.length > 0 ? name : ''
  }

  /** Resolve which style variant this new agent gets (experiment or fixed). */
  function pickStyleVariant() {
    const experiment = cfg.styleExperiments
    if (experiment?.enabled === true && Array.isArray(experiment.variants) && experiment.variants.length > 0) {
      const variants = experiment.variants
      const index = experiment.assign === 'random'
        ? Math.floor(Math.random() * variants.length)
        : styleAssignCounter % variants.length
      styleAssignCounter += 1
      const variant = variants[index]
      return { name: String(variant), text: styleText(variant) }
    }
    if (cfg.terseStyle?.enabled === true) {
      if (cfg.tsvCodec === undefined) { /* never */ }
      const custom = cfg.terseStyle.systemPromptText
      const name = cfg.terseStyle.mode === 'telegraph' ? 'telegraph' : cfg.terseStyle.mode === 'concise' ? 'concise' : cfg.terseStyle.mode
      return { name, text: typeof custom === 'string' && custom.length > 0 ? custom : styleText(name) }
    }
    return null
  }

  function reportHandoff(sessionId) {
    const state = sessions.get(sessionId)
    if (state === undefined) return '暂无会话数据。'
    const t = state.totals
    const prices = currentPrices(state.model, Date.now())
    const toolsTop = Object.entries(state.tools.byName).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([name, count]) => `${name}×${count}`).join(', ')
    const lines = [
      '# 交接单（新会话首条消息可直接粘贴）',
      '- 任务目标：<补充当前目标>',
      `- 旧会话：${shortId(state.id)} · 请求 ${t.requests} · 轮次 ${state.turn.number} · 估算成本 ${formatMoney(t.cost, cfg.currency)}`,
      `- 上下文：${formatInt(state.cache.prevPromptTokens)} tokens（继续约 ${formatMoney(state.cache.prevPromptTokens * prices.hit, cfg.currency)}/请求；新会话约 ${formatMoney(25000 * prices.hit, cfg.currency)}/请求）`,
      `- 常用工具：${toolsTop || '—'}`,
      '- 关键落盘原文（用 read 取回）：',
      ...(state.toolOut.spills.slice(-6).map((locator) => `  - ${locator}`).concat(state.toolOut.spills.length === 0 ? ['  - 无'] : [])),
      '- 最近动作：',
      ...state.requests.slice(-5).map((request) => `  - ${request.effort} · out ${formatInt(request.out)} · ${formatMoney(request.cost, cfg.currency)}`),
    ]
    return lines.join('\n')
  }

  function reportForSession(sessionId) {
    const state = sessions.get(sessionId)
    const model = state?.model ?? 'deepseek-flash'
    const now = Date.now()
    const prices = currentPrices(model, now)
    const clock = beijingClock(now)
    const peak = isPeak(now, cfg.holidayDates)
    const lines = []
    const label = `Token 管家 · 会话 ${shortId(sessionId)}`
    lines.push(label)
    lines.push(`模型 ${model} · 现在北京时间 ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')} ` +
      `${peak ? '高峰价' : '空闲价（5折）'} · 价格版本 ${PRICE_VERSION} · 统计自插件加载`)
    if (state === undefined) {
      lines.push('本会话尚无请求记录。')
      return lines.join('\n')
    }
    const t = state.totals
    const hitPct = cacheHitPct(t)
    const split = costSplit(t)
    lines.push(`请求 ${t.requests}（主 ${t.mainRequests} / 辅助 ${t.auxRequests}）· 轮次 ${state.turn.number} · 工具调用 ${state.tools.total}`)
    const surface = state.surface
    if (surface.toolsTokensEst > 0) {
      const hitPrice = currentPrices(model, now).hit
      lines.push(`工具 schema ≈ ${formatInt(surface.toolsTokensEst)} tokens（${surface.toolCount} 个，每请求固定出现；缓存命中时约 ${formatMoney(surface.toolsTokensEst * hitPrice, cfg.currency)}/请求）`)
      if (surface.toolsTokensEst > 8000) {
        lines.push('  提示：schema 固定税偏重。静态裁剪低频工具可降本，但不要在会话中途改工具集（会使旧前缀缓存失效）。')
      }
      if (state.schemaChanges > 0) lines.push(`工具集变更 ${state.schemaChanges} 次：每次变更都会让旧前缀缓存失效。`)
    }
    lines.push(`输入：缓存未命中 ${formatInt(t.inputMissTokens)} · 缓存命中 ${formatInt(t.cacheReadTokens)}（命中率 ${hitPct.toFixed(1)}%）`)
    // cache governor: cache-unit utilization, invalidation loss, fixed prefix
    {
      const byCause = state.cache.byCause
      const causeNames = {
        first: '首次请求', 'post-compaction': '压缩后', 'model-switch': '模型切换',
        'tool-change': '工具集变更', 'system-rewrite': '系统提示改写', 'idle-cold': '空闲冷缓存',
        'unexplained-miss': '疑似服务端驱逐', incremental: '正常新增',
        'effort-change': '强度切换（已回滚）',
      }
      const preventive = new Set(['model-switch', 'tool-change', 'system-rewrite', 'unexplained-miss', 'effort-change'])
      const inherent = new Set(['post-compaction', 'idle-cold'])
      let avoidable = 0
      let inherentCost = 0
      let unavoidable = 0
      let invalidationLoss = 0
      for (const [cause, bucket] of Object.entries(byCause)) {
        if (cause === 'incremental' || cause === 'first') {
          unavoidable += bucket.cost
          continue
        }
        invalidationLoss += bucket.lossTokens
        if (preventive.has(cause)) avoidable += bucket.cost
        else if (inherent.has(cause)) inherentCost += bucket.cost
      }
      if (t.inputMissTokens > 0) {
        const expected = state.cache.expectedHitTokens
        const actual = state.cache.mainHitTokens
        if (expected > 0) {
          lines.push(`缓存单元利用率 ${(actual / expected * 100).toFixed(2)}%（实际命中 ${formatInt(actual)} / 追加式理想 ${formatInt(expected)}）；` +
            `失效损失 ${formatInt(invalidationLoss)} tokens ≈ ${formatMoney(invalidationLoss * (prices.miss - prices.hit), cfg.currency)}`)
        }
        lines.push(`未命中额外成本 ${formatMoney(avoidable + inherentCost + unavoidable, cfg.currency)}` +
          `（可预防 ${formatMoney(avoidable, cfg.currency)} / 固有 ${formatMoney(inherentCost, cfg.currency)} / 不可避免新增 ${formatMoney(unavoidable, cfg.currency)}）`)
        const parts = Object.entries(byCause)
          .filter(([, bucket]) => bucket.lossTokens > 0 || bucket.missTokens > 0)
          .sort((a, b) => b[1].cost - a[1].cost)
          .slice(0, 5)
          .map(([cause, bucket]) => `${causeNames[cause] ?? cause} ${formatInt(bucket.lossTokens || bucket.missTokens)}tok/${formatMoney(bucket.cost, cfg.currency)}`)
        if (parts.length > 0) lines.push(`  来源：${parts.join(' · ')}`)
      }
      const first = state.cache.firstRequest
      if (first !== undefined) {
        lines.push(`固定前缀：首个观测请求命中 ${formatInt(first.hit)} tokens / 新增 ${formatInt(first.miss)} tokens` +
          '（插件加载后才开始观测；会话首请求的跨会话复用见快照 metrics）')
      }
      const codec = state.codec
      if (codec !== undefined && (codec.applied > 0 || codec.deferred > 0 || codec.valueSkipped > 0 || codec.shapeSkipped > 0 || codec.noJson > 0 || codec.toolSkipped > 0)) {
        const saved = codec.before - codec.after
        const savedTokens = Math.max(0, codec.tokensBefore - codec.tokensAfter)
        lines.push(`无损表格编码：${codec.applied} 次 JSON→TSV` +
          (codec.applied > 0
            ? `（字符 ${formatInt(codec.before)}→${formatInt(codec.after)}，-${Math.round((saved / Math.max(codec.before, 1)) * 100)}%；` +
              `token 约 ${formatInt(codec.tokensBefore)}→${formatInt(codec.tokensAfter)}，省 ≈${formatInt(savedTokens)}）`
            : '') +
          (codec.deferred > 0 ? ` · ${codec.deferred} 次让路` : '') +
          (codec.valueSkipped > 0 ? ` · ${codec.valueSkipped} 次结构化值（不可改）` : '') +
          (codec.shapeSkipped > 0 ? ` · ${codec.shapeSkipped} 次非纯文本` : '') +
          (codec.toolSkipped > 0 ? ` · ${codec.toolSkipped} 次豁免工具` : '') +
          (codec.noJson > 0 ? ` · ${codec.noJson} 次非均匀数组` : ''))
      }
      const toolOut = state.toolOut
      if (toolOut !== undefined && (toolOut.compressed > 0 || toolOut.deduped > 0 ||
        toolOut.nearDeduped > 0 || toolOut.officialDeferred > 0 || toolOut.markerDeferred > 0 ||
        (typeof toolOut.lastError === 'string' && toolOut.lastError.length > 0))) {
        const savedTokens = Math.max(0, toolOut.tokensBefore - toolOut.tokensAfter)
        const parts = []
        if (toolOut.compressed > 0) parts.push(`压缩 ${toolOut.compressed} 次（结构感知 ${toolOut.structured}）`)
        if (toolOut.deduped > 0) parts.push(`去重 ${toolOut.deduped} 次`)
        if (toolOut.nearDeduped > 0) parts.push(`近重复 ${toolOut.nearDeduped} 次`)
        if (savedTokens > 0) parts.push(`token 约 ${formatInt(toolOut.tokensBefore)}→${formatInt(toolOut.tokensAfter)}（省 ≈${formatInt(savedTokens)}）`)
        if (toolOut.officialDeferred > 0) parts.push(`${toolOut.officialDeferred} 次让路官方 spill（超预算）`)
        if (toolOut.markerDeferred > 0) parts.push(`${toolOut.markerDeferred} 次已被官方 spill 处理`)
        if (toolOut.lastError) parts.push(`上次压缩错误: ${toolOut.lastError}`)
        parts.push('全文可 read 取回')
        lines.push(`工具输出：${parts.join(' · ')}`)
      }
      const styleStats = state.styleStats
      const styleEntries = Object.entries(styleStats ?? {})
        .filter(([, entry]) => entry.requests >= 3)
      if (styleEntries.length >= 2) {
        const parts = styleEntries.slice(0, 3).map(([name, entry]) =>
          `${name} ${(entry.outputTokens / entry.requests).toFixed(0)} tok/请求（n=${entry.requests}，失败 ${entry.errors}）`)
        lines.push(`风格对比（参考，可能受任务差异影响）：${parts.join(' · ')}`)
      }
      if (state.readReused > 0) {
        lines.push(`重复读取复用：${state.readReused} 次（未变更文件直接引用上文，不重复占上下文）`)
      }
      if ((state.toolOut.aggressiveCompressed ?? 0) > 0) {
        lines.push(`压缩预算：${state.toolOut.aggressiveCompressed} 次大结果按 ≤` +
          `${Math.round((cfg.compressionBudget?.aggressiveTargetRatio ?? 0.3) * 100)}% 目标压缩`)
      }
      if ((state.outputGuard?.downshifts ?? 0) > 0) {
        const guard = state.outputGuard
        const guardedAvg = guard.guardedRequests > 0 ? Math.round(guard.guardedOutput / guard.guardedRequests) : 0
        const otherAvg = guard.otherRequests > 0 ? Math.round(guard.otherOutput / guard.otherRequests) : 0
        lines.push(`输出治理：短步骤降 effort ${guard.downshifts} 次；降档后平均输出 ${guardedAvg} tok/请求` +
          `（n=${guard.guardedRequests}） vs 其他 ${otherAvg}（n=${guard.otherRequests}）`)
      }
      if (Array.isArray(state.growth) && state.growth.length > 0) {
        const total = state.growth.reduce((sum, entry) => sum + entry.delta, 0)
        const toolTotal = state.growth.filter((entry) => entry.kind === 'tool').reduce((sum, entry) => sum + entry.delta, 0)
        const last5 = state.growth.slice(-5).reduce((sum, entry) => sum + entry.delta, 0)
        lines.push(`上下文增长：本会话 +${formatInt(total)} tokens（工具结果 ≈${formatInt(toolTotal)}，` +
          `${total > 0 ? Math.round((toolTotal / total) * 100) : 0}%）；最近 5 步 +${formatInt(last5)}`)
      }
      const tax = computeToolTax(state, prices)
      if (tax !== null) {
        lines.push(`工具税：未使用工具 ${tax.count} 个 ≈ ${formatInt(tax.tokens)} tokens/请求` +
          `（命中价 ${formatMoney(tax.perRequestCost, cfg.currency)}/请求 · 每会话首请求另省 ${formatMoney(tax.firstRequestCost, cfg.currency)}）；` +
          `静态裁剪候选：${tax.top.map((tool) => tool.name).join(', ')}`)
        if (cfg.toolBudget?.enabled !== true) {
          lines.push('  提示：把候选名填进 config.toolBudget.deny（仅对新 agent 生效）；不要在会话中途改工具集。')
        }
      }
      for (const advisory of state.cache.advisories.slice(-3)) {
        lines.push(`  ⚠ ${advisory.text}`)
      }
    }
    lines.push(`输出：${formatInt(t.outputTokens)}（含思考，接口不单列）`)
    lines.push(`估算费用：${formatMoney(t.cost, cfg.currency)}` +
      `（未命中输入 ${split.missPct.toFixed(0)}% / 缓存命中输入 ${split.hitPct.toFixed(0)}% / 输出 ${split.outPct.toFixed(0)}%）`)
    if (t.requests > 0) {
      const perRequest = t.cost / t.requests
      const inputCost = t.hitCost + t.missCost
      const hitShare = t.cost > 0 ? (t.hitCost / t.cost) * 100 : 0
      const hitShareOfInput = inputCost > 0 ? (t.hitCost / inputCost) * 100 : 0
      lines.push(`成本口径：每请求 ${formatMoney(perRequest, cfg.currency)}` +
        `（每千请求 ${formatMoney(perRequest * 1000, cfg.currency)}）` +
        ` · 命中输入成本占比 ${hitShare.toFixed(0)}%（占输入成本 ${hitShareOfInput.toFixed(0)}%）`)
    }
    if ((state.peakCost ?? 0) > 0) {
      lines.push(`时段：高峰时段已花 ${formatMoney(state.peakCost, cfg.currency)}；` +
        `若排到空闲时段可省 ${formatMoney(state.peakCost / 2, cfg.currency)}（空闲价为高峰 5 折）`)
    }
    if (state.cache.promptCount > 0) {
      const avgPrompt = state.cache.promptSumTokens / state.cache.promptCount
      lines.push(`上下文体积：当前 ${formatInt(state.cache.prevPromptTokens)} tokens · 主请求平均 ${formatInt(avgPrompt)} tokens` +
        ` · 仅上下文成本约 ${formatMoney(avgPrompt * prices.hit, cfg.currency)}/请求`)
    }
    {
      const finished = state.turns
      const avgTurn = finished.length > 0 ? finished.reduce((sum, item) => sum + item.cost, 0) / finished.length : 0
      lines.push(`轮次成本：本轮 ${formatMoney(state.turn.totals.cost, cfg.currency)}` +
        (avgTurn > 0 ? ` · 已结束轮次平均 ${formatMoney(avgTurn, cfg.currency)}` : ''))
    }
    if (cfg.budget?.mode !== undefined && cfg.budget.mode !== 'off') {
      const budgetMode = cfg.budget.mode
      const limit = budgetMode === 'turn' ? (cfg.budget.maxTurnCost ?? 0) : (cfg.budget.maxSessionCost ?? 0)
      const spent = budgetMode === 'turn' ? state.turn.totals.cost : state.totals.cost
      const protectedNow = agents.get(sessionId)?.budgetDownshifted === true
      lines.push(`预算保护：${budgetMode === 'turn' ? '本轮' : '本会话'}已花 ${formatMoney(spent, cfg.currency)}` +
        (limit > 0 ? ` / 上限 ${formatMoney(limit, cfg.currency)}（${Math.round(spent / limit * 100)}%）` : '') +
        ` · ${protectedNow ? '已触发降档（续步 ' + (cfg.budget.downshiftEffort || 'low') + '）' : '未触发'}`)
    }
    // ContextPipe-style decision planner (real model window when resolvable)
    const decision = decisionNumbers(state, prices)
    if (decision.contextTokens > 0) {
      if (decision.priced) {
        lines.push(`决策（估算）：继续本会合约 ${formatMoney(decision.continuePerRequest, cfg.currency)}/请求；/compact 后约 ` +
          `${formatMoney(decision.compactPerRequest, cfg.currency)}/请求（一次性约 ${formatMoney(decision.compactPenalty, cfg.currency)}，` +
          `回本 ${decision.breakEvenTurns.toFixed(1)} 轮）；新任务新会话约 ${formatMoney(decision.newSessionPerRequest, cfg.currency)}/请求` +
          ` · 窗口 ${formatInt(decision.windowSize)}`)
      } else {
        lines.push('决策：当前模型价格未知（可在 modelPrices 覆盖），暂不估算。')
      }
    }
    const staleness = priceStalenessDays()
    if (staleness > (cfg.priceStaleDays ?? 90)) {
      lines.push(`⚠ 价格表版本 ${PRICE_VERSION} 已 ${staleness} 天未更新，请核对官方价格后用 modelPrices 覆盖。`)
    }
    // Compaction alternative: dense handoff digest
    if (cfg.compactionDigest?.enabled !== false &&
      state.cache.prevPromptTokens >= (cfg.compactionDigest.minContextTokens ?? 150000)) {
      lines.push('压缩替代：`/token handoff` 生成交接单后开新会话，通常比 /compact 后仍常驻 ~130k 检查点更省。')
    }
    // Subagent cost attribution + fork/fresh advice
    {
      const children = [...sessions.values()].filter((child) => child.parentSession === sessionId)
      if (children.length > 0) {
        const childTotal = children.reduce((sum, child) => sum + child.totals.cost, 0)
        lines.push(`子会话：${children.length} 个，合计 ${formatMoney(childTotal, cfg.currency)}（本会话 ${formatMoney(t.cost, cfg.currency)}）`)
        for (const child of children.slice(0, 5)) {
          let duplicates = 0
          for (const fingerprint of child.tools.fp) if (state.tools.fp.has(fingerprint)) duplicates += 1
          const dupPct = child.tools.fp.size > 0 ? (duplicates / child.tools.fp.size) * 100 : 0
          lines.push(`  · ${shortId(child.id)}: ${child.totals.requests}请求/${formatMoney(child.totals.cost, cfg.currency)}` +
            `/上下文${formatInt(child.cache.prevPromptTokens)} · 与父会话重复工具调用 ${duplicates} 次（${dupPct.toFixed(0)}%）` +
            ` → ${dupPct >= 40 ? '建议 fork（继承上下文省重复读取）' : '建议 fresh（隔离更省）'}` +
            (() => {
              const flash = currentPrices('deepseek-flash', child.lastRequestAt ?? Date.now())
              if (flash.known !== true || child.totals.cost <= 0) return ''
              const estimated = child.totals.inputMissTokens * flash.miss +
                child.totals.cacheReadTokens * flash.hit + child.totals.outputTokens * flash.out
              const saving = child.totals.cost - estimated
              return saving > 0.0001 ? ` · 若改用 flash 约省 ${formatMoney(saving, cfg.currency)}` : ''
            })())
        }
      }
    }
    // Compression A/B (end-to-end cost, not compression rate)
    if (abSegments.length > 1) {
      const parts = abSegments.filter((segment) => segment.requests > 0).map((segment) =>
        `${segment.compress ? '压缩开' : '压缩关'} ${segment.requests}请求/` +
        `${formatMoney(segment.cost / segment.requests, cfg.currency)}每请求` +
        `（失败 ${segment.errors ?? 0} · 触顶 ${segment.maxTokens ?? 0} · 工具错 ${segment.toolErrors ?? 0}）`)
      if (parts.length > 0) lines.push(`压缩 A/B：${parts.join(' · ')}`)
    }
    if (t.unknownPriceRequests > 0) {
      lines.push(`⚠ ${t.unknownPriceRequests} 次请求的模型不在价格表内，费用未计入；可在 config.modelPrices 中补充。`)
    }
    if (t.peakRequests > 0 && t.offPeakRequests > 0) {
      lines.push(`其中高峰请求 ${t.peakRequests} 次、空闲请求 ${t.offPeakRequests} 次（按各自时段单价计）。`)
    }
    if (t.finishErrors > 0 || t.finishMaxTokens > 0 || t.retries > 0) {
      lines.push(`异常：失败 ${t.finishErrors} · 触顶(max-tokens) ${t.finishMaxTokens} · 重试/中断 ${t.retries}`)
    }
    if (state.aux.requests > 0) {
      const auxSplit = costSplit(state.aux)
      lines.push(`辅助调用（标题/摘要/评审等）：${state.aux.requests} 次，未命中输入 ${formatInt(state.aux.inputMissTokens)} / 输出 ${formatInt(state.aux.outputTokens)}，估算 ${formatMoney(state.aux.cost, cfg.currency)}` +
        (state.aux.cost > 0 ? `（占本会话 ${(state.aux.cost / Math.max(t.cost, 1e-9) * 100).toFixed(0)}%，其中未命中 ${auxSplit.missPct.toFixed(0)}%）` : ''))
    }
    if (state.compactionEvents > 0) {
      lines.push(`压缩事件 ${state.compactionEvents} 次：压缩摘要通常以高比例未命中缓存重算整段上下文，是"省 token 不省钱"的典型来源；本插件只做提示，不主动触发压缩。`)
    }
    // policy state
    const policyState = agents.get(sessionId)
    const eff = state.effort
    const currentEffort = eff.currentEffort ?? policyState?.originalEffort ?? 'adapter-default'
    lines.push(`思考强度：当前 ${currentEffort} · 调度 ${eff.applications} 次 · 切换安全 ${eff.switchSafe} · 回滚 ${eff.rollbacks}` +
      (agents.get(sessionId)?.effortRiskSuspended === true ? ' · ⚠ 已暂停自动降档（上次切换触发缓存失效）' : ''))
    if (cfg.terseStyle?.enabled === true) {
      lines.push(`风格：${cfg.terseStyle.mode === 'telegraph' ? '极简电报体' : cfg.terseStyle.mode === 'concise' ? '简洁输出（不反复解释）' : '极简文言文'}（仅对之后创建的会话生效；用户可见回复仍为正常中文）`)
    }
    const tierKeys = Object.keys(eff.byTier).filter((key) => eff.byTier[key].requests >= 2).slice(-4)
    for (const key of tierKeys) {
      const item = eff.byTier[key]
      const avg = item.outputTokens / item.requests
      lines.push(`  · ${key}: ${item.requests} 请求，平均输出 ${formatInt(avg)} tokens`)
    }
    // cache anomalies (kept for the snapshot; the report shows their causes
    // through the by-cause table above)
    const anomalies = state.cache.anomalies
    if (anomalies.length > 0) {
      const lost = anomalies.reduce((sum, item) => sum + item.lostCost, 0)
      lines.push(`缓存哨兵记录 ${anomalies.length} 次异常，合计 ${formatMoney(lost, cfg.currency)}（明细见快照）`)
    }
    // web search cost
    const searchCost = (state.tools.searchCalls + state.tools.fetchCalls) * searchCallCost()
    if (state.tools.searchCalls + state.tools.fetchCalls > 0) {
      lines.push(`Web 搜索/抓取 ${state.tools.searchCalls + state.tools.fetchCalls} 次 ≈ ${formatMoney(searchCost, cfg.currency)}（按次计费，非 token）`)
    }
    // compaction advice
    const advice = compactionAdvice(state, model, now)
    if (advice !== null) lines.push(advice)
    // recent turns
    const lastTurns = state.turns.slice(-3)
    if (lastTurns.length > 0) {
      const summary = lastTurns.map((turn) => `轮${turn.turn}: ${turn.requests}请求/${formatInt(turn.outputTokens)}出/${formatMoney(turn.cost, cfg.currency)}`)
      lines.push(`最近轮次：${summary.join(' · ')}`)
    }
    return lines.join('\n')
  }

  function compactionAdvice(state, model, now) {
    const prices = currentPrices(model, now)
    if (!prices.known) return null
    const pressure = (() => {
      try {
        const meter = ctx.get('tokenMeter')
        const agent = liveAgentsOf(ctx).find((item) => sessionIdOf(item) === state.id)
        if (meter === undefined || agent === undefined) return undefined
        return meter.contextPressure?.(agent.session)
      } catch {
        return undefined
      }
    })()
    const promptTokens = pressure?.pressureTokens ?? state.cache.prevPromptTokens
    if (!(promptTokens > 100000)) return null
    const markerThreshold = 700000
    if (promptTokens < markerThreshold * 0.6) return null
    const economics = compactionEconomics({ newPrefixTokens: Math.round(promptTokens * 0.25), removedTokens: promptTokens, prices })
    if (economics === null) return null
    return `上下文约 ${formatInt(promptTokens)} tokens：若现在压缩（重写约 ${formatInt(promptTokens * 0.25)}，缓存失效一次性约 ` +
      `${formatMoney(economics.oneTimePenalty, cfg.currency)}），需再跑约 ${economics.breakEvenTurns.toFixed(1)} 轮才回本。` +
      '压缩是防溢出手段，不是省钱手段。'
  }

  function reportGlobal() {
    const t = globalTotals
    const now = Date.now()
    const peak = isPeak(now, cfg.holidayDates)
    const lines = []
    lines.push('Token 管家 · 全局（进程启动以来）')
    lines.push(`价格版本 ${PRICE_VERSION} · 币种 ${cfg.currency} · 现在北京时间 ${String(beijingClock(now).hour).padStart(2, '0')}:${String(beijingClock(now).minute).padStart(2, '0')} ${peak ? '高峰' : '空闲'}`)
    lines.push(`请求 ${t.requests}（主 ${t.mainRequests} / 辅助 ${t.auxRequests}）· 会话 ${sessions.size} 个 · 工具调用 ${globalToolCalls.total}`)
    lines.push(`输入：未命中 ${formatInt(t.inputMissTokens)} · 命中 ${formatInt(t.cacheReadTokens)}（${cacheHitPct(t).toFixed(1)}%）· 输出 ${formatInt(t.outputTokens)}`)
    lines.push(`估算费用：${formatMoney(t.cost, cfg.currency)}`)
    if (t.requests > 0) {
      const perRequest = t.cost / t.requests
      const inputCost = t.hitCost + t.missCost
      lines.push(`成本口径：每请求 ${formatMoney(perRequest, cfg.currency)}（每千请求 ${formatMoney(perRequest * 1000, cfg.currency)}）` +
        ` · 命中输入成本占比 ${(t.cost > 0 ? (t.hitCost / t.cost) * 100 : 0).toFixed(0)}%` +
        `（占输入成本 ${(inputCost > 0 ? (t.hitCost / inputCost) * 100 : 0).toFixed(0)}%）`)
    }
    if (globalPeakCost > 0) {
      lines.push(`时段：高峰已花 ${formatMoney(globalPeakCost, cfg.currency)}；` +
        `若排到空闲时段可省 ${formatMoney(globalPeakCost / 2, cfg.currency)}`)
    }
    const searchCalls = globalToolCalls.searchCalls + globalToolCalls.fetchCalls
    if (searchCalls > 0) lines.push(`Web 搜索/抓取 ${searchCalls} 次 ≈ ${formatMoney(searchCalls * searchCallCost(), cfg.currency)}`)
    lines.push('按会话：')
    const rows = [...sessions.values()].sort((a, b) => b.totals.cost - a.totals.cost).slice(0, 8)
    for (const state of rows) {
      lines.push(`  · ${shortId(state.id)}: ${state.totals.requests}请求 / 命中率 ${cacheHitPct(state.totals).toFixed(0)}% / ${formatMoney(state.totals.cost, cfg.currency)}`)
    }
    return lines.join('\n')
  }

  function reportPrices() {
    const now = Date.now()
    const peak = isPeak(now, cfg.holidayDates)
    const lines = []
    lines.push(`DeepSeek 价格表（${PRICE_VERSION}，${cfg.currency} / 百万 tokens）— 来源 api-docs.deepseek.com`)
    const models = cfg.currency === 'USD'
      ? { 'deepseek-flash': [0.006, 0.3, 1.2, 0.003, 0.15, 0.6], 'deepseek-v4-pro': [0.044, 1.32, 3.96, 0.022, 0.66, 1.98] }
      : { 'deepseek-flash': [0.04, 2, 8, 0.02, 1, 4], 'deepseek-v4-pro': [0.3, 9, 27, 0.15, 4.5, 13.5] }
    for (const [model, numbers] of Object.entries(models)) {
      lines.push(`${model}: 高峰 命中${numbers[0]} / 未命中${numbers[1]} / 输出${numbers[2]}；空闲 命中${numbers[3]} / 未命中${numbers[4]} / 输出${numbers[5]}`)
    }
    lines.push(`现在北京时间 ${String(beijingClock(now).hour).padStart(2, '0')}:${String(beijingClock(now).minute).padStart(2, '0')} → ${peak ? '高峰价' : '空闲价（5折）'}`)
    lines.push('高峰 = 周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00；其余时段（含周末/节假日）为 5 折空闲价。')
    lines.push('缓存命中价约为未命中价的 1/50（flash）/ 1/30（pro）；缓存写入不额外收费；思考 token 计入输出价。')
    return lines.join('\n')
  }

  // ---------- self-check: is the meter actually wired to the host? ----------
  // A silently broken hook (DSH upgrade, renamed event, missing service) looks
  // exactly like "a cheap session", so expose explicit evidence instead.
  function servicePresence(name) {
    try { return ctx.get(name) !== undefined } catch { return false }
  }

  function fmtAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '从未'
    const minutes = Math.floor(ms / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    return `${hours} 小时前`
  }

  function doctorChecks() {
    const checks = []
    const add = (id, level, detail) => checks.push({ id, level, detail })
    const now = Date.now()
    const loadedMinutes = Math.max(0, Math.round((now - diagnostics.loadedAt) / 60000))
    add('plugin', 'ok', `已加载 ${loadedMinutes} 分钟 · enabled=${cfg.enabled !== false} · currency=${cfg.currency}`)

    for (const name of ['llm', 'tools', 'commands', 'agents', 'webServer']) {
      const present = servicePresence(name)
      let level = 'ok'
      let detail = '可用'
      if (!present) {
        level = name === 'tools' || name === 'commands' ? 'fail' : 'warn'
        detail = name === 'llm' ? '不可用：无法读取 provider usage，本会话账单不可信'
          : name === 'webServer' ? '不可用：HTTP API/面板无数据（/token 命令仍可用）'
            : '未就绪'
      }
      add(`service:${name}`, level, detail)
    }

    if (diagnostics.llmStreams > 0) {
      add('metering:llm', 'ok', `已捕获 ${diagnostics.llmStreams} 次模型流（最近 ${fmtAge(now - (diagnostics.lastLlmAt ?? now))}）`)
    } else if (loadedMinutes >= 5) {
      add('metering:llm', 'fail', `加载 ${loadedMinutes} 分钟仍未捕获任何模型流；若刚跑过请求，说明 llm/stream 钩子已失效，账单数字不可信`)
    } else {
      add('metering:llm', 'warn', '尚未捕获模型流（刚加载，属正常）')
    }

    const hookCount = diagnostics.preExecute + diagnostics.postExecute
    add('hooks:tools', hookCount > 0 ? 'ok' : 'warn',
      `工具钩子 前 ${diagnostics.preExecute} / 后 ${diagnostics.postExecute}（最近后置 ${fmtAge(now - (diagnostics.lastPostExecuteAt ?? now))}）` +
      (hookCount === 0 ? '；若已跑过工具，说明压缩/去重链路未挂上' : ''))

    const size = ledgerSize()
    let writable = true
    try {
      fs.mkdirSync(path.dirname(ledger.file), { recursive: true })
      fs.accessSync(path.dirname(ledger.file), fs.constants.W_OK)
    } catch { writable = false }
    add('ledger', writable ? 'ok' : 'fail',
      `${ledger.file} · ${(size / 1024).toFixed(1)} KB · 历史 ${ledger.records} 条 · 本次运行写 ${diagnostics.ledgerWrites} 条 / 轮转 ${diagnostics.ledgerRotations} 次` +
      (writable ? '' : '（目录不可写，账本不会持久化）'))
    const maxBytes = Number(cfg.ledger?.maxBytes ?? LEDGER_DEFAULT_MAX_BYTES)
    const keepFiles = cfg.ledger?.keepFiles ?? LEDGER_DEFAULT_KEEP_FILES
    add('ledger:rotation', maxBytes > 0 ? 'ok' : 'warn',
      maxBytes > 0 ? `超过 ${(maxBytes / 1024 / 1024).toFixed(1)} MB 轮转，保留 ${keepFiles} 份归档` : 'maxBytes<=0：账本不会轮转，会无限增长')

    const age = priceTableAgeDays(PRICE_VERSION, now)
    const staleDays = Number(cfg.priceStaleDays ?? 90)
    if (age === null) add('prices', 'warn', `价格版本 ${PRICE_VERSION} 无法解析，请检查 PRICE_VERSION`)
    else if (staleDays > 0 && age > staleDays) add('prices', 'warn', `价格表 ${age} 天未更新（阈值 ${staleDays} 天），请核对官方价格页`)
    else add('prices', 'ok', `价格版本 ${PRICE_VERSION}（${age} 天前）`)

    add('compress', 'ok',
      `结构压缩=${cfg.toolOutput?.compressEnabled !== false} · 近重复=${cfg.toolOutput?.nearDedupeEnabled !== false} · ` +
      `TSV=${cfg.tsvCodec?.enabled !== false} · 读取复用=${cfg.readReuse?.enabled !== false}`)

    const limits = cfg.sourceLimits
    if (limits?.enabled === true) {
      add('sourceLimits', 'ok',
        `源头限流已开启：本次改写 ${diagnostics.sourceRewrites} 条命令` +
        `（bash→head -n / pwsh→Select-Object -First ${limits.bashHeadLines ?? 400}）` +
        `；被截断的原文不会落盘`)
    } else {
      add('sourceLimits', 'warn', '源头限流关闭（实验功能；开启后会改变命令语义，且截断内容不可回取）')
    }

    let spill = false
    try { spill = officialSpillActive() } catch {}
    add('spill:official', spill ? 'ok' : 'warn',
      spill ? `已检测到官方 spill-policy（预算 ${officialSpillBudget ?? '默认'} tokens），超大结果让路`
        : '未检测到官方 spill-policy，超大结果由本插件兜底')

    if (cfg.apiEnabled === false) {
      add('api', 'warn', 'HTTP API 已关闭（面板与 /token 命令不受影响）')
    } else {
      const hasToken = typeof cfg.apiToken === 'string' && cfg.apiToken.length > 0
      add('api', hasToken ? 'ok' : 'warn', `${cfg.apiPath} 可访问${hasToken ? '（已启用 apiToken 鉴权）' : '（未设置 apiToken；仅本机自用可接受）'}`)
    }

    return checks
  }

  function reportDoctor() {
    const checks = doctorChecks()
    const lines = ['Token 管家 · 自检（/token doctor）']
    const symbol = { ok: '✅', warn: '⚠️', fail: '❌' }
    for (const check of checks) lines.push(`${symbol[check.level] ?? '•'} ${check.id}：${check.detail}`)
    const fails = checks.filter((check) => check.level === 'fail').length
    const warns = checks.filter((check) => check.level === 'warn').length
    lines.push(fails > 0
      ? `结论：${fails} 项失败 —— 先修失败项，否则账单/缓存数字可能不可信（另 ${warns} 项提醒）。`
      : warns > 0
        ? `结论：可用，${warns} 项提醒（多为配置建议，不影响数字正确性）。`
        : '结论：全部正常。')
    return lines.join('\n')
  }

  function setAutoPolicy(enabled) {
    cfg.effortPolicy.enabled = enabled
    if (enabled === true) {
      for (const policyState of agents.values()) policyState.effortRiskSuspended = false
    }
    if (enabled === false) {
      // Bring every live agent back to its original effort right away.
      for (const state of agents.values()) {
        if (state.originalEffort === undefined) continue
        try {
          const agent = liveAgentsOf(ctx).find((item) => sessionIdOf(item) === state.sessionId)
          if (agent !== undefined) applyEffort(agent, state.sessionId, state.originalEffort, 'auto disabled')
        } catch {}
      }
    }
    return enabled
  }

  // ---------- snapshot + HTTP API ----------
  function serializeSession(state) {
    const prices = currentPrices(state.model, Date.now())
    const byCause = state.cache.byCause
    const preventive = new Set(['model-switch', 'tool-change', 'system-rewrite', 'unexplained-miss', 'effort-change'])
    const inherent = new Set(['post-compaction', 'idle-cold'])
    let avoidableCost = 0
    let inherentCost = 0
    let unavoidableCost = 0
    let invalidationLossTokens = 0
    for (const [cause, bucket] of Object.entries(byCause)) {
      if (cause === 'incremental' || cause === 'first') unavoidableCost += bucket.cost
      else {
        invalidationLossTokens += bucket.lossTokens
        if (preventive.has(cause)) avoidableCost += bucket.cost
        else if (inherent.has(cause)) inherentCost += bucket.cost
      }
    }
    const expected = state.cache.expectedHitTokens
    const actual = state.cache.mainHitTokens
    return {
      session: shortId(state.id),
      parentSession: state.parentSession === undefined ? undefined : shortId(state.parentSession),
      model: state.model,
      totals: state.totals,
      cacheHitPct: cacheHitPct(state.totals),
      turn: state.turn.number,
      surface: state.surface,
      schemaChanges: state.schemaChanges,
      aux: state.aux,
      compactionEvents: state.compactionEvents,
      cache: {
        hitRatePct: cacheHitPct(state.totals),
        byCause,
        advisories: state.cache.advisories,
        anomalies: state.cache.anomalies,
        metrics: {
          prefixUtilizationPct: expected > 0 ? (actual / expected) * 100 : null,
          expectedHitTokens: expected,
          mainHitTokens: actual,
          invalidationLossTokens,
          invalidationLossCost: invalidationLossTokens * (prices.miss - prices.hit),
          avoidableCost,
          inherentCost,
          unavoidableCost,
          firstRequest: state.cache.firstRequest,
          toolTax: computeToolTax(state, prices),
          perRequestCost: state.totals.requests > 0 ? state.totals.cost / state.totals.requests : 0,
          perThousandRequests: state.totals.requests > 0 ? (state.totals.cost / state.totals.requests) * 1000 : 0,
          hitCostSharePct: state.totals.cost > 0 ? (state.totals.hitCost / state.totals.cost) * 100 : 0,
          hitShareOfInputPct: state.totals.hitCost + state.totals.missCost > 0
            ? (state.totals.hitCost / (state.totals.hitCost + state.totals.missCost)) * 100
            : 0,
          peakCost: state.peakCost,
          offPeakCost: state.offPeakCost,
          peakSavingPotential: state.peakCost / 2,
          turnCost: state.turn.totals.cost,
          codec: state.codec,
          toolOut: {
            compressed: state.toolOut.compressed,
            structured: state.toolOut.structured,
            deduped: state.toolOut.deduped,
            nearDeduped: state.toolOut.nearDeduped,
            lastLen: state.toolOut.lastLen,
            lastLines: state.toolOut.lastLines,
            lastTool: state.toolOut.lastTool,
            lastDecision: state.toolOut.lastDecision,
            lastHasValue: state.toolOut.lastHasValue,
            lastContentLen: state.toolOut.lastContentLen,
            lastKind: state.toolOut.lastKind,
            lastToolAny: state.toolOut.lastToolAny,
            lastAnyContentLen: state.toolOut.lastAnyContentLen,
            lastBlockCount: state.toolOut.lastBlockCount,
            lastTotalChars: state.toolOut.lastTotalChars,
            lastResultChars: state.toolOut.lastResultChars,
            readReused: state.readReused,
            aggressiveCompressed: state.toolOut.aggressiveCompressed ?? 0,
            growth: Array.isArray(state.growth) ? state.growth.slice(-10) : [],
            lastError: state.toolOut.lastError,
            bytesBefore: state.toolOut.bytesBefore,
            bytesAfter: state.toolOut.bytesAfter,
            skipped: state.toolOut.skipped,
            officialDeferred: state.toolOut.officialDeferred,
            markerDeferred: state.toolOut.markerDeferred,
          },
          averageTurnCost: state.turns.length > 0
            ? state.turns.reduce((sum, item) => sum + item.cost, 0) / state.turns.length
            : 0,
          contextTokens: state.cache.prevPromptTokens,
          avgContextTokens: state.cache.promptCount > 0 ? state.cache.promptSumTokens / state.cache.promptCount : 0,
          contextCostPerRequest: (state.cache.promptCount > 0 ? state.cache.promptSumTokens / state.cache.promptCount : 0) * prices.hit,
          decision: (() => {
            const decision = decisionNumbers(state, prices)
            return {
              continuePerRequest: decision.continuePerRequest,
              compactPerRequest: decision.compactPerRequest,
              compactPenalty: decision.compactPenalty,
              breakEvenTurns: decision.breakEvenTurns,
              newSessionPerRequest: decision.newSessionPerRequest,
              windowSize: decision.windowSize,
              priced: decision.priced,
            }
          })(),
          budget: (() => {
            const mode = cfg.budget?.mode ?? 'off'
            if (mode === 'off') return { mode, active: false }
            const limit = mode === 'turn' ? (cfg.budget.maxTurnCost ?? 0) : (cfg.budget.maxSessionCost ?? 0)
            const spent = mode === 'turn' ? state.turn.totals.cost : state.totals.cost
            return {
              mode,
              active: true,
              limit,
              spent,
              ratioPct: limit > 0 ? (spent / limit) * 100 : null,
              downshiftEffort: cfg.budget.downshiftEffort ?? 'low',
              protectedNow: agents.get(state.id)?.budgetDownshifted === true,
            }
          })(),
        },
      },
      effort: {
        original: agents.get(state.id)?.originalEffort,
        current: state.effort.currentEffort,
        applications: state.effort.applications,
        switchSafe: state.effort.switchSafe,
        rollbacks: state.effort.rollbacks,
        skipped: state.effort.skipped,
        suspended: agents.get(state.id)?.effortRiskSuspended === true,
        watchPending: state.effort.watch !== undefined,
        byTier: state.effort.byTier,
      },
      cacheAnomalies: state.cache.anomalies,
      tools: state.tools,
      turns: state.turns.slice(-5),
      recent: state.requests.slice(-20),
    }
  }

  function snapshotPayload() {
    return {
      plugin: 'dsh-plugin-token-governor',
      priceVersion: PRICE_VERSION,
      currency: cfg.currency,
      generatedAt: new Date().toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      config: {
        effortPolicy: cfg.effortPolicy,
        guard: cfg.guard,
        cacheGovernor: cfg.cacheGovernor,
        toolPolicy: cfg.toolPolicy,
        toolBudget: cfg.toolBudget,
        budget: cfg.budget,
        contextAdvice: cfg.contextAdvice,
        terseStyle: cfg.terseStyle,
        tsvCodec: cfg.tsvCodec,
        toolOutput: cfg.toolOutput,
        cacheAnomaly: cfg.cacheAnomaly,
        apiPath: cfg.apiPath,
        apiEnabled: cfg.apiEnabled,
      },
      tool: { registered: toolRegistered, deferred: toolDeferred },
      global: {
        totals: globalTotals,
        tools: globalToolCalls,
        cacheHitPct: cacheHitPct(globalTotals),
        peakCost: globalPeakCost,
        offPeakCost: globalOffPeakCost,
        peakSavingPotential: globalPeakCost / 2,
        perRequestCost: globalTotals.requests > 0 ? globalTotals.cost / globalTotals.requests : 0,
      },
      sessions: [...sessions.values()].map(serializeSession),
      recent: recent.slice(-30),
      ab: abSegments,
      terseVerifications,
      ledger: {
        totals: ledger.totals,
        records: ledger.records,
        since: ledger.since,
        file: ledger.file,
        sessions: [...ledger.sessions.values()]
          .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
          .slice(0, 50)
          .map((entry) => ({
            id: entry.id,
            short: shortId(entry.id),
            model: entry.model,
            firstTs: entry.firstTs,
            lastTs: entry.lastTs,
            totals: entry.totals,
          })),
      },
    }
  }

  /** Live loader rows (id/name/active) for the plugin inventory endpoint. */
  function loaderRows() {
    try {
      const loader = ctx.get('loader')
      const entries = loader?.entries?.()
      if (entries === undefined || entries === null) return null
      const rows = []
      for (const entry of entries) {
        try {
          const options = entry?.options ?? {}
          rows.push({
            id: options.id ?? null,
            name: options.name ?? null,
            active: entry?.fiber !== undefined && entry?.fiber !== null,
            config: options.config === undefined ? undefined : { maxInlineTokens: options.config.maxInlineTokens },
          })
        } catch {}
      }
      return rows
    } catch {
      return null
    }
  }

  function snapshotTarget() {
    const configured = typeof cfg.snapshotPath === 'string' ? cfg.snapshotPath.trim() : ''
    if (configured !== '') return configured
    return path.join(os.tmpdir(), 'dsh-token-governor.snapshot.json')
  }

  function maybeSnapshot(force) {
    const now = Date.now()
    if (!force && now - snapshotAt < (cfg.snapshotIntervalMs ?? 1500)) return
    snapshotAt = now
    try {
      const target = snapshotTarget()
      const temporary = `${target}.${process.pid}.tmp`
      fs.writeFileSync(temporary, JSON.stringify(snapshotPayload(), null, 1), 'utf8')
      fs.renameSync(temporary, target)
      lastSnapshotError = ''
    } catch (error) {
      lastSnapshotError = String(error?.message ?? error)
      console.error('token-governor: snapshot write failed', error)
    }
  }

  try {
    // The web server service may not exist yet while this plugin applies (for
    // example right after a desktop restart). Prefer a deferred injection so the
    // route still registers when the service becomes available.
    const registerApi = function (webCtx) {
      if (cfg.apiEnabled === false) return
      const webServer = webCtx.get('webServer')
      if (webServer === undefined) return
      webCtx.effect(() => {
        const path = String(cfg.apiPath ?? '/token-governor')
        const handler = async (req, res) => {
          try {
            const url = String(req.url ?? '')
            const clean = url.split('?')[0].replace(/\/+$/, '')
            const requiredToken = typeof cfg.apiToken === 'string' ? cfg.apiToken : ''
            if (requiredToken.length > 0) {
              const headerToken = req.headers?.['x-token']
              const queryToken = new URL(url, 'http://localhost').searchParams.get('token')
              if (headerToken !== requiredToken && queryToken !== requiredToken) {
                sendJson(res, 401, { ok: false, error: 'unauthorized' })
                return
              }
            }
            if (req.method === 'GET' && clean.endsWith('/api/text')) {
              const parsed = new URL(url, 'http://localhost')
              const wanted = parsed.searchParams.get('session')
              let sessionId
              if (wanted !== null && wanted !== '') {
                for (const id of sessions.keys()) {
                  if (id === wanted || shortId(id) === wanted) { sessionId = id; break }
                }
              }
              if (sessionId === undefined) {
                // Prefer the most recently active tracked session; falling back
                // to an arbitrary live agent reports an empty session instead.
                let bestTs = -1
                for (const state of sessions.values()) {
                  const ts = state.lastRequestAt ?? 0
                  if (ts > bestTs) { bestTs = ts; sessionId = state.id }
                }
                if (sessionId === undefined) {
                  sessionId = liveAgentsOf(ctx).map((agent) => sessionIdOf(agent)).find(Boolean)
                }
              }
              sendJson(res, 200, { ok: true, text: sessionId === undefined ? reportGlobal() : reportForSession(sessionId) })
              return
            }
            if (req.method === 'GET' && clean.endsWith('/api/doctor')) {
              const checks = doctorChecks()
              sendJson(res, 200, { ok: checks.every((check) => check.level !== 'fail'), checks })
              return
            }
            if (req.method === 'GET' && (clean.endsWith('/api/report') || clean === path)) {
              const payload = snapshotPayload()
              const sessionId = payload.sessions
              sendJson(res, 200, { ok: true, ...payload, sessions: sessionId })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/auto')) {
              let body = ''
              for await (const chunk of req) body += chunk
              let enabled = true
              try { enabled = JSON.parse(body).enabled !== false } catch {}
              const applied = setAutoPolicy(enabled !== false)
              sendJson(res, 200, { ok: true, auto: applied, snapshot: snapshotPayload() })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/policy')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              if (typeof patch.enabled === 'boolean') cfg.effortPolicy.enabled = patch.enabled
              if (typeof patch.continuationEffort === 'string' && ['off', 'low', 'high', 'max'].includes(patch.continuationEffort)) {
                cfg.effortPolicy.continuationEffort = patch.continuationEffort
              }
              if (typeof patch.onlyDownshiftMax === 'boolean') cfg.effortPolicy.onlyDownshiftMax = patch.onlyDownshiftMax
              if (patch.resume === true) {
                for (const policyState of agents.values()) policyState.effortRiskSuspended = false
              }
              if (cfg.effortPolicy.enabled === false) setAutoPolicy(false)
              sendJson(res, 200, { ok: true, effortPolicy: cfg.effortPolicy, snapshot: snapshotPayload() })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/tool-budget')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              let applied = false
              if (patch.apply === true) {
                // Collect unused-but-large tool names from every sampled
                // session and restrict only NEW agents (cache-safe static trim).
                const denySet = new Set()
                for (const state of sessions.values()) {
                  const candidates = unusedToolCandidates(state)
                  if (candidates !== null) for (const tool of candidates.all) denySet.add(tool.name)
                }
                const deny = [...denySet].slice(0, 16)
                if (deny.length > 0) {
                  cfg.toolBudget.enabled = true
                  cfg.toolBudget.deny = deny
                  applied = true
                }
              } else {
                if (typeof patch.enabled === 'boolean') cfg.toolBudget.enabled = patch.enabled
                if (Array.isArray(patch.deny) && patch.deny.every((name) => typeof name === 'string')) {
                  cfg.toolBudget.deny = patch.deny
                }
              }
              sendJson(res, 200, { ok: true, applied, toolBudget: cfg.toolBudget, snapshot: snapshotPayload() })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/budget')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              if (typeof patch.mode === 'string' && ['off', 'turn', 'session'].includes(patch.mode)) cfg.budget.mode = patch.mode
              if (typeof patch.maxTurnCost === 'number' && patch.maxTurnCost >= 0) cfg.budget.maxTurnCost = patch.maxTurnCost
              if (typeof patch.maxSessionCost === 'number' && patch.maxSessionCost >= 0) cfg.budget.maxSessionCost = patch.maxSessionCost
              if (typeof patch.softRatio === 'number' && patch.softRatio > 0 && patch.softRatio <= 1) cfg.budget.softRatio = patch.softRatio
              if (typeof patch.downshiftEffort === 'string' && ['off', 'low', 'high'].includes(patch.downshiftEffort)) {
                cfg.budget.downshiftEffort = patch.downshiftEffort
              }
              if (cfg.budget.mode === 'off') {
                // Leaving budget mode restores the original effort for live
                // agents that were downshifted by the protector.
                for (const [sid, policyState] of agents) {
                  if (policyState.budgetDownshifted !== true) continue
                  const live = liveAgentsOf(ctx).find((agent) => sessionIdOf(agent) === sid)
                  if (live !== undefined && policyState.originalEffort !== undefined) {
                    applyEffort(live, sid, policyState.originalEffort, 'budget off restore')
                  }
                  policyState.budgetDownshifted = false
                }
              }
              sendJson(res, 200, { ok: true, budget: cfg.budget, snapshot: snapshotPayload() })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/terse')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              if (typeof patch.enabled === 'boolean') cfg.terseStyle.enabled = patch.enabled
              if (patch.mode === 'classical' || patch.mode === 'telegraph' || patch.mode === 'concise') cfg.terseStyle.mode = patch.mode
              if (typeof patch.systemPromptText === 'string') cfg.terseStyle.systemPromptText = patch.systemPromptText
              sendJson(res, 200, {
                ok: true,
                terseStyle: cfg.terseStyle,
                note: '仅对之后创建的 agent 生效；运行中会话不受影响（缓存安全）',
                snapshot: snapshotPayload(),
              })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/tokenize')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              const texts = Array.isArray(patch.texts) ? patch.texts.slice(0, 8).map((text) => String(text)) : []
              let provider = 'deepseek-account'
              let model = 'deepseek-flash'
              let newest = 0
              for (const state of sessions.values()) {
                if ((state.lastRequestAt ?? 0) > newest && typeof state.cache.lastRoute === 'string') {
                  newest = state.lastRequestAt ?? 0
                  const parts = state.cache.lastRoute.split('/')
                  if (parts.length === 2) { provider = parts[0]; model = parts[1] }
                }
              }
              const llm = ctx.get('llm')
              if (llm === undefined) {
                sendJson(res, 500, { ok: false, error: 'llm service unavailable' })
                return
              }
              const results = []
              try {
                for (const text of texts) {
                  let inputTokens = 0
                  const options = {
                    provider,
                    model,
                    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
                    maxTokens: 8,
                    reasoningEffort: 'off',
                    purpose: 'tokenize-probe',
                  }
                  for await (const chunk of llm.stream(options)) {
                    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage' && chunk.usage) {
                      inputTokens += Number(chunk.usage.inputTokens ?? 0) + Number(chunk.usage.cacheReadTokens ?? 0)
                    }
                  }
                  const chars = text.length
                  results.push({ chars, inputTokens, tokensPerChar: chars > 0 ? Number((inputTokens / chars).toFixed(3)) : 0 })
                }
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
                return
              }
              sendJson(res, 200, { ok: true, route: { provider, model }, results })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/tsv')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              if (typeof patch.enabled === 'boolean') cfg.tsvCodec.enabled = patch.enabled
              sendJson(res, 200, { ok: true, tsvCodec: cfg.tsvCodec, snapshot: snapshotPayload() })
              return
            }
            if (req.method === 'GET' && clean.endsWith('/api/plugins')) {
              const rows = loaderRows()
              if (rows === null) {
                sendJson(res, 500, { ok: false, error: 'loader entries unavailable' })
                return
              }
              sendJson(res, 200, { ok: true, rows })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/ab')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              const compress = patch.compress !== false
              cfg.toolOutput.compressEnabled = compress
              cfg.tsvCodec.enabled = compress
              abSegments.push({ startedAt: Date.now(), compress, requests: 0, cost: 0 })
              sendJson(res, 200, { ok: true, compress, segments: abSegments, snapshot: snapshotPayload() })
              return
            }
            if (req.method === 'GET' && clean.endsWith('/api/handoff')) {
              const parsed = new URL(url, 'http://localhost')
              const wanted = parsed.searchParams.get('session')
              let target
              if (wanted !== null && wanted !== '') {
                for (const id of sessions.keys()) {
                  if (id === wanted || shortId(id) === wanted) { target = id; break }
                }
              }
              if (target === undefined) {
                let newest = 0
                for (const state of sessions.values()) {
                  if ((state.lastRequestAt ?? 0) > newest) { newest = state.lastRequestAt ?? 0; target = state.id }
                }
              }
              sendJson(res, 200, { ok: true, text: target === undefined ? '暂无会话数据。' : reportHandoff(target) })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/terse-verify')) {
              if (cfg.terseVerify?.enabled === false) {
                sendJson(res, 403, { ok: false, error: 'terse verify disabled by config' })
                return
              }
              const nowMs = Date.now()
              if (nowMs - lastTerseVerifyAt < (cfg.terseVerify?.cooldownMs ?? 60000)) {
                sendJson(res, 429, {
                  ok: false,
                  error: 'cooldown',
                  retryAfterMs: (cfg.terseVerify?.cooldownMs ?? 60000) - (nowMs - lastTerseVerifyAt),
                })
                return
              }
              lastTerseVerifyAt = nowMs
              const agentsSvc = ctx.get('agents')
              if (agentsSvc === undefined) {
                sendJson(res, 500, { ok: false, error: 'agents service unavailable' })
                return
              }
              let provider = 'deepseek-account'
              let model = 'deepseek-flash'
              let newest = 0
              for (const state of sessions.values()) {
                if ((state.lastRequestAt ?? 0) > newest && typeof state.cache.lastRoute === 'string') {
                  newest = state.lastRequestAt ?? 0
                  const parts = state.cache.lastRoute.split('/')
                  if (parts.length === 2) { provider = parts[0]; model = parts[1] }
                }
              }
              try {
                const handle = await agentsSvc.create({
                  sessionId: `terse-verify-${nowMs.toString(36)}`,
                  agentOptions: { provider, model },
                })
                const agentId = typeof handle?.agent?.id === 'string' ? handle.agent.id : undefined
                let injected = false
                for (let i = terseVerifications.length - 1; i >= 0; i -= 1) {
                  const record = terseVerifications[i]
                  if (Date.now() - record.at < 5000 && (agentId === undefined || record.sessionId === agentId)) {
                    injected = true
                    break
                  }
                }
                if (typeof handle?.dispose === 'function') await handle.dispose()
                if (agentId !== undefined) sessions.delete(agentId)
                sendJson(res, 200, { ok: true, sessionId: agentId ?? null, terseInjected: injected, terseStyle: cfg.terseStyle })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              }
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/style-experiment')) {
              let body = ''
              for await (const chunk of req) body += chunk
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              if (typeof patch.enabled === 'boolean') cfg.styleExperiments.enabled = patch.enabled
              if (patch.assign === 'alternate' || patch.assign === 'random') cfg.styleExperiments.assign = patch.assign
              if (Array.isArray(patch.variants) && patch.variants.length > 0) {
                cfg.styleExperiments.variants = patch.variants.map((variant) => String(variant))
              }
              sendJson(res, 200, { ok: true, received: patch, styleExperiments: cfg.styleExperiments,
                snapshot: snapshotPayload(),
              })
              return
            }
            if (req.method === 'POST' && clean.endsWith('/api/new-session')) {
              let body = ''
              body = await readBody(req)
              const patch = parsePatch(body, new URL(url, 'http://localhost').searchParams)
              if (patch.confirm !== true && patch.confirm !== 'true') {
                sendJson(res, 400, { ok: false, error: 'confirm required' })
                return
              }
              const agentsSvc = ctx.get('agents')
              if (agentsSvc === undefined || cfg.newSession?.enabled === false) {
                sendJson(res, 503, { ok: false, error: 'agents service unavailable or newSession disabled' })
                return
              }
              const parsed = new URL(url, 'http://localhost')
              const wanted = parsed.searchParams.get('session')
              let target
              for (const id of sessions.keys()) {
                if (wanted === null || id === wanted || shortId(id) === wanted) { target = id; break }
              }
              if (target === undefined) {
                let newest = 0
                for (const state of sessions.values()) {
                  if ((state.lastRequestAt ?? 0) > newest) { newest = state.lastRequestAt ?? 0; target = state.id }
                }
              }
              const handoffText = target === undefined ? '暂无会话数据。' : reportHandoff(target)
              try {
                const route = cfg.newSession
                const handle = await agentsSvc.create({ agentOptions: { provider: route.provider, model: route.model } })
                const newId = sessionIdOf(handle?.agent)
                await handle.agent.followup({
                  content: [{ type: 'text', text: (route.promptPrefix ?? '') + handoffText }],
                  source: { kind: 'user' },
                })
                sendJson(res, 200, { ok: true, sessionId: newId ?? null, handoff: handoffText })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
              }
              return
            }
            sendJson(res, 404, { ok: false, error: 'unknown token-governor endpoint' })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }
        apiRoute = webServer.register({ kind: 'prefix', path, handler })
        return () => {
          if (typeof apiRoute === 'function') apiRoute()
        }
      }, 'token-governor: JSON API')
    }
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerApi)
    else if (ctx.get('webServer') !== undefined) registerApi(ctx)
  } catch (error) {
    console.error('token-governor: webServer route unavailable (non-fatal)', error)
  }

  /** Read an HTTP request body from a Fetch Request or a Node IncomingMessage. */
  async function readBody(req) {
    try {
      if (req !== null && typeof req === 'object') {
        if (typeof req.text === 'function') return await req.text()
        const body = req.body
        if (typeof body === 'string') return body
        if (body !== undefined && body !== null && typeof body.getReader === 'function') {
          const reader = body.getReader()
          const chunks = []
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(Buffer.from(value))
          }
          return Buffer.concat(chunks).toString('utf8')
        }
        if (body !== undefined && body !== null && typeof body.arrayBuffer === 'function') {
          return Buffer.from(await body.arrayBuffer()).toString('utf8')
        }
      }
      let text = ''
      for await (const chunk of req) text += chunk
      return text
    } catch {
      return ''
    }
  }

  /** Parse a JSON body with query-string fallback (some transports drop bodies). */
  function parsePatch(body, searchParams) {
    let patch = {}
    try { patch = String(body ?? '').trim().length > 0 ? JSON.parse(body) : {} } catch { patch = {} }
    if (searchParams !== undefined && searchParams !== null) {
      for (const [key, value] of searchParams.entries()) {
        if (patch[key] !== undefined) continue
        if (value === 'true') patch[key] = true
        else if (value === 'false') patch[key] = false
        else if (/^-?\d+(\.\d+)?$/.test(value)) patch[key] = Number(value)
        else if (value.startsWith('[') || value.startsWith('{')) {
          try { patch[key] = JSON.parse(value) } catch { patch[key] = value }
        } else patch[key] = value
      }
    }
    return patch
  }

  function sendJson(res, status, payload) {
    try {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    } catch (error) {
      console.error('token-governor: sendJson failed', error)
    }
  }

  // ---------- the report tool ----------
  // Cache-safe registration: a tool added while sessions are live changes their
  // tool declarations and invalidates the provider prefix cache. When sessions
  // are active, defer the tool to the next load (the /token command and the
  // HTTP API remain usable, and neither costs model prompt tokens).
  let toolRegistered = false
  let toolDeferred = false
  const liveAgents = liveAgentsOf(ctx)
  const shouldDeferTool = cfg.toolPolicy?.enabled !== false &&
    cfg.toolPolicy?.deferWhenSessionsActive !== false &&
    liveAgents.length > 0
  if (shouldDeferTool) {
    toolDeferred = true
    console.log(`token-governor: ${liveAgents.length} active session(s) — token_report tool deferred to next load to keep the prompt cache intact; /token command stays available`)
  } else {
    try {
      ctx.tools.register({
        name: 'token_report',
        description: 'Report real DeepSeek token usage and estimated cost for this session (cache-hit vs cache-miss input, output incl. thinking, peak/off-peak pricing) plus the reasoning-effort policy state. Use when the user asks about token usage, cost, caching, or thinking budget.',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              description: 'Optional: "session" (default) or "all" for every session since plugin load.',
            },
          },
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (args, value) => [{ type: 'text', text: String(value?.text ?? value?.error ?? '') }],
        },
        execute: (args, exec) => {
          const scope = typeof args?.scope === 'string' ? args.scope : 'session'
          if (scope === 'all' || scope === 'global') return Promise.resolve({ text: reportGlobal() })
          const sessionId = sessionIdOf(exec?.agent)
          if (sessionId === undefined) return Promise.resolve({ text: reportGlobal() + '\n（当前工具调用未归属到会话，已返回全局视图）' })
          return Promise.resolve({ text: reportForSession(sessionId) })
        },
      })
      toolRegistered = true
    } catch (error) {
      console.error('token-governor: token_report registration failed', error)
    }
  }

  // ---------- /token command (renders in UI, never becomes a model message) ----------
  try {
    ctx.commands.register({
      name: 'token',
      description: CMD_DESCRIPTION,
      input: { hint: '[auto on|auto off|prices|doctor|all|reset|handoff|new|style on|style off|ab on|ab off]' },
      handler: async ({ agent, rawInput }) => {
        const input = String(rawInput ?? '').trim().toLowerCase()
        const sessionId = sessionIdOf(agent)
        if (input === '') {
          return { kind: 'success', text: sessionId === undefined ? reportGlobal() : reportForSession(sessionId) }
        }
        if (input === 'all' || input === 'global') return { kind: 'success', text: reportGlobal() }
        if (input === 'style on' || input === 'style off') {
          cfg.styleExperiments.enabled = input === 'style on'
          return {
            kind: 'success',
            text: `Prompt 风格实验：已${input === 'style on' ? '开启' : '关闭'}；之后创建的会话按 variants 轮流分配，` +
              '用 /token 看各风格平均输出 token 与失败率（样本≥3 才显示）。',
          }
        }
        if (input === 'prices') return { kind: 'success', text: reportPrices() }
        if (input === 'doctor' || input === 'check' || input === '自检') return { kind: 'success', text: reportDoctor() }
        if (input === 'trim' || input === 'trim on') return { kind: 'success', text: reportTrim() }
        if (input === 'trim off') {
          cfg.toolBudget.enabled = false
          return { kind: 'success', text: '工具裁剪：已关闭（对之后创建的新会话生效，运行中会话不变）。' }
        }
        if (input === 'out on' || input === 'out off') {
          cfg.outputGuard.enabled = input === 'out on'
          return {
            kind: 'success',
            text: `输出治理：已${input === 'out on' ? '开启' : '关闭'}——短输出续步降 effort（默认 low），出错升级、轮末恢复。` +
              '效果用 /token 里的“输出治理”行对比（降档后 vs 其他平均输出）。',
          }
        }
        if (input === 'handoff') return { kind: 'success', text: sessionId === undefined ? '暂无会话数据。' : reportHandoff(sessionId) }
        if (input === 'new') {
          const handoffText = sessionId === undefined ? '暂无会话数据。' : reportHandoff(sessionId)
          const agentsSvc = ctx.get('agents')
          if (agentsSvc === undefined || cfg.newSession?.enabled === false) {
            return {
              kind: 'error',
              text: '无法自动开新会话（agents 服务不可用或 newSession.enabled=false）。交接单：\n\n' + handoffText,
            }
          }
          try {
            const route = cfg.newSession
            const handle = await agentsSvc.create({ agentOptions: { provider: route.provider, model: route.model } })
            const newId = sessionIdOf(handle?.agent)
            await handle.agent.followup({
              content: [{ type: 'text', text: (route.promptPrefix ?? '') + handoffText }],
              source: { kind: 'user' },
            })
            return {
              kind: 'success',
              text: `已创建新会话 ${newId === undefined ? '' : shortId(newId)} 并投递交接单；到会话列表打开它即可继续（旧会话保留备查）。`,
            }
          } catch (error) {
            return {
              kind: 'error',
              text: '创建新会话失败：' + String(error?.message ?? error) + '\n\n交接单：\n\n' + handoffText,
            }
          }
        }
        if (input === 'ab on' || input === 'ab off') {
          const compress = input === 'ab on'
          cfg.toolOutput.compressEnabled = compress
          cfg.tsvCodec.enabled = compress
          abSegments.push({ startedAt: Date.now(), compress, requests: 0, cost: 0 })
          return { kind: 'success', text: `压缩 A/B：已切到「${compress ? '开' : '关'}」，之后用 /token 看两段每请求成本对比（端到端口径）。` }
        }
        if (input === 'auto on') {
          setAutoPolicy(true)
          return { kind: 'success', text: '思考强度调度：已开启（默认仅把 max 降为 high，轮末恢复）' }
        }
        if (input === 'auto off') {
          setAutoPolicy(false)
          return { kind: 'success', text: '思考强度调度：已关闭，并在下一步恢复各 agent 原始强度' }
        }
        if (input === 'auto' || input === 'status') {
          return { kind: 'success', text: `思考强度调度：${cfg.effortPolicy.enabled === false ? '关闭' : '开启'}；续步强度 ${cfg.effortPolicy.continuationEffort}；仅降 max=${cfg.effortPolicy.onlyDownshiftMax !== false}` }
        }
        if (input === 'reset') {
          if (sessionId !== undefined) {
            const state = ensureSession(sessionId)
            state.totals = emptyTotals()
            state.turn.totals = emptyTotals()
            state.requests.length = 0
            state.cache.anomalies.length = 0
            state.turns.length = 0
            state.effort.applications = 0
          }
          return { kind: 'success', text: '本会话的 token 管家统计已清零（不影响真实账单）。' }
        }
        return { kind: 'error', text: `未知参数 "${rawInput}"。可用：/token、/token doctor、/token all、/token prices、/token auto on|off、/token reset` }
      },
    })
  } catch (error) {
    console.error('token-governor: /token registration failed', error)
  }

  // ---------- shutdown ----------
  ctx.effect(() => {
    return () => {
      maybeSnapshot(true)
    }
  }, 'token-governor: final snapshot')

  maybeSnapshot(true)
  cleanupAllSpills()
  console.log(`token-governor loaded: priceVersion=${PRICE_VERSION}, currency=${cfg.currency}, ` +
    `effortPolicy=${cfg.effortPolicy.enabled === false ? 'off' : `continuation->${cfg.effortPolicy.continuationEffort}`}` +
    `${cfg.snapshotPath ? `, snapshot=${cfg.snapshotPath}` : ''}`)
}
