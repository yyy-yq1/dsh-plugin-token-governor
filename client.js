/**
 * dsh-plugin-token-governor — Client half (Web GUI).
 *
 * Two surfaces, both fed by the Host half's JSON API:
 *   - a Settings section「缓存与成本」: cache hit rate, miss cost attributed by
 *     cause, pre-flight warnings (idle cold resume / model switch / compaction /
 *     system rewrite / tool change), and the effort-policy toggle;
 *   - a composer-dock strip: one-line cache hit rate + miss cost + warning count.
 *
 * This client registers no tool, no prompt text and no page-level resources, so
 * it cannot affect the model prompt or the provider prefix cache. React comes
 * from the module table (`require('react')`), never a second copy.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-token-governor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/token-governor/api'

    const STR = {
      zh: {
        label: '缓存与成本',
        title: 'Token 管家 · 缓存与成本',
        subtitle: '真实计费口径 · 缓存失效归因 · 失效前预警',
        hitRate: '缓存命中率',
        bill: '本会话估算费用',
        missCost: '未命中额外成本',
        avoidable: '其中可避免',
        perReq: '每请求成本',
        perReqSub: '每千请求 {k}',
        hitShare: '命中输入成本占比',
        hitShareSub: '占输入成本 {i}%',
        requestsLabel: '请求',
        stripPerReq: '¥{v}/请求',
        savingsCard: '省钱动作',
        peakRow: '错峰：高峰已花 {c}',
        peakSub: '排到空闲可省 {s}',
        peakNone: '当前无高峰花费',
        trimRow: '工具 schema 裁剪',
        trimSub: '{n} 个未使用工具 ≈ {t} tokens/请求（{c}/请求）',
        trimNoSample: '样本不足（需 ≥20 次工具调用 / 15 请求）',
        trimApply: '应用到新会话',
        trimApplied: '已应用：新会话将裁剪 {n} 个工具（当前会话不变）',
        trimNone: '暂无可裁剪候选',
        trimOn: '已启用：新会话裁剪 {n} 个工具',
        trimDisabled: '未启用（默认关闭，避免能力损失）',
        turnRow: '轮次成本',
        turnSub: '本轮 {t} · 已结束轮次平均 {a}',
        budgetRow: '预算保护（{m}）',
        budgetSub: '{s} / {l} · {p}',
        budgetTurn: '本轮', budgetSession: '本会话',
        budgetProtected: '已触发降档', budgetNotProtected: '未触发',
        budgetOff: '未启用（可设 turn/session 上限自动降档）',
        autoCard: '决策与验证',
        decideRow: '决策（估算）',
        decideSub: '继续 {c}/请求 · compact 后 {m}/请求（一次性 {p} · 回本 {b} 轮）· 新会话 {n}/请求',
        abRow: '压缩 A/B（端到端）',
        abSub: '开 {on} · 关 {off}',
        childRow: '子会话',
        childSub: '{n} 个 · 合计 {c} · 重复工具调用 {d}',
        growthRow: '上下文增长',
        growthSub: '最近 10 步 · 重复读取复用 {r} 次',
        handoffBtn: '生成交接单',
        newSessionBtn: '换新会话（省 ¥）',
        newSessionOk: '已建新会话 {id}，交接单已投递',
        switchesTitle: '开关（点右侧按钮切换，开/关各有什么用它写在行内）',
        switchesHint: '这些是运行时开关，重启后回到 profile 的 cordis.patch.yml 里的配置值。',
        scopeImmediate: '立即生效',
        scopeNewAgent: '仅新会话生效',
        scopeRestart: '重启生效',
        switchOn: '开',
        switchOff: '关',
        onHowPrefix: '开：',
        offHowPrefix: '关：',
        verifyBtn: '验证简洁风格注入',
        totalsCard: '总消耗 Tokens（跨会话/跨重启累计）',
        totalTokens: '总消耗 Tokens',
        inputHit: '输入（命中缓存）',
        inputMiss: '输入（未命中缓存）',
        outputLabel: '输出',
        apiRequests: 'API 请求次数',
        requestsDetail: '主 {main} · 辅助 {aux}',
        ledgerSince: '统计起点 {since} · 记录 {records} 条 · 共 {sessions} 个会话',
        sessCol: '会话',
        reqCol: '请求',
        hitCol: '命中',
        missCol: '未命中',
        outCol: '输出',
        costCol: '费用',
        verifyOk: '已注入（新会话 {id}）',
        verifyFail: '未注入（看 host 日志）',
        source: '未命中来源',
        cause: '来源', requests: '次数', missTokens: '未命中 tokens', cost: '多付',
        advisories: '缓存预警',
        noAdvisories: '暂无预警。空闲冷恢复 / 切模型 / 压缩 / 改系统提示 / 改工具集会在这里提前提示。',
        prefixCard: '固定前缀与失效损失',
        prefixUtil: '缓存单元利用率',
        prefixUtilSub: '实际命中 {a} / 追加式理想 {b}',
        firstReq: '首请求复用',
        firstReqSub: '新增 {m} tokens',
        toolTax: '工具 schema 税（未使用）',
        toolTaxSub: '{n} 个工具 · {c}/请求',
        loss: '失效损失',
        contextRow: '上下文体积',
        contextSub: '平均 {a} tokens · 仅上下文 {c}/请求',
        switchLine: '切换验证：安全 {s} 次 · 回滚 {r} 次',
        switchSuspended: ' · 已暂停自动降档',
        switchSafe: '安全',
        noData: '暂无请求数据（插件刚加载或无活动会话）。',
        loading: '加载中…',
        error: '无法连接 Host 数据接口（插件未启用或路由未注册）。',
        effort: '思考强度调度',
        effortOn: '已开启：续步会把 max 降为 high',
        effortOff: '已关闭（实测 max→high 在 deepseek-flash 上≈不省，默认关）',
        effortHint: '改强度不会破坏缓存，但会写入会话 model/selection。',
        enable: '开启', disable: '关闭',
        refresh: '刷新',
        toolDeferred: '报告工具已延迟注册（当前有活动会话）；/token 命令与本面板不受影响。',
        toolOk: '报告工具已注册。',
        price: '价格版本', generated: '更新于', uptime: '运行', min: '分钟',
        session: '会话', global: '全局',
        stripCache: '缓存 {p}%', stripMiss: 'miss ¥{m}', stripWarn: '{n} 条预警', stripNoWarn: '正常',
        causeNames: {
          first: '首次请求', 'post-compaction': '压缩后', 'model-switch': '模型切换',
          'tool-change': '工具集变更', 'system-rewrite': '系统提示改写', 'idle-cold': '空闲冷缓存',
          'unexplained-miss': '疑似服务端驱逐', incremental: '正常新增',
        },
      },
      en: {
        label: 'Cache & Cost',
        title: 'Token Governor · Cache & Cost',
        subtitle: 'real billing · cache-miss attribution · pre-flight warnings',
        hitRate: 'Cache hit rate',
        bill: 'Estimated session cost',
        missCost: 'Extra miss cost',
        avoidable: 'avoidable',
        perReq: 'Cost per request',
        perReqSub: 'per 1k requests {k}',
        hitShare: 'Cache-hit cost share',
        hitShareSub: '{i}% of input cost',
        requestsLabel: 'requests',
        stripPerReq: '¥{v}/req',
        savingsCard: 'Money-saving actions',
        peakRow: 'Off-peak: peak spend {c}',
        peakSub: 'save {s} off-peak',
        peakNone: 'no peak spend',
        trimRow: 'Tool schema trim',
        trimSub: '{n} unused tools ≈ {t} tokens/request ({c}/request)',
        trimNoSample: 'not enough sample (need ≥20 tool calls / 15 requests)',
        trimApply: 'Apply to new sessions',
        trimApplied: 'Applied: new sessions trim {n} tools (current session unchanged)',
        trimNone: 'no trimmable candidates',
        trimOn: 'enabled: new sessions trim {n} tools',
        trimDisabled: 'disabled by default (avoids capability loss)',
        turnRow: 'Turn cost',
        turnSub: 'this turn {t} · finished-turn average {a}',
        budgetRow: 'Budget protection ({m})',
        budgetSub: '{s} / {l} · {p}',
        budgetTurn: 'turn', budgetSession: 'session',
        budgetProtected: 'downshifted', budgetNotProtected: 'not triggered',
        budgetOff: 'off (set a turn/session cap to auto-downshift)',
        autoCard: 'Decisions & verification',
        decideRow: 'Decision (estimated)',
        decideSub: 'continue {c}/req · after compact {m}/req (one-off {p} · break-even {b} turns) · new session {n}/req',
        abRow: 'Compression A/B (end-to-end)',
        abSub: 'on {on} · off {off}',
        childRow: 'Subagents',
        childSub: '{n} · total {c} · duplicate tool calls {d}',
        growthRow: 'Context growth',
        growthSub: 'last 10 steps · read-reuse {r}',
        handoffBtn: 'Handoff note',
        newSessionBtn: 'New session (save ¥)',
        newSessionOk: 'New session {id} created, handoff posted',
        switchesTitle: 'Switches (click to toggle; each row states what on/off does)',
        switchesHint: 'Runtime switches: restarting returns to the value in the profile cordis.patch.yml.',
        scopeImmediate: 'immediate',
        scopeNewAgent: 'new sessions only',
        scopeRestart: 'restart required',
        switchOn: 'ON',
        switchOff: 'OFF',
        onHowPrefix: 'ON: ',
        offHowPrefix: 'OFF: ',
        verifyBtn: 'Verify terse-style injection',
        totalsCard: 'Total tokens (all sessions, persisted)',
        totalTokens: 'Total consumed tokens',
        inputHit: 'Input (cache hit)',
        inputMiss: 'Input (cache miss)',
        outputLabel: 'Output',
        apiRequests: 'API requests',
        requestsDetail: 'main {main} · aux {aux}',
        ledgerSince: 'since {since} · {records} records · {sessions} sessions',
        sessCol: 'Session',
        reqCol: 'Req',
        hitCol: 'Hit',
        missCol: 'Miss',
        outCol: 'Out',
        costCol: 'Cost',
        verifyOk: 'injected (new session {id})',
        verifyFail: 'not injected (check host log)',
        source: 'Miss sources',
        cause: 'Cause', requests: 'requests', missTokens: 'miss tokens', cost: 'extra',
        advisories: 'Cache warnings',
        noAdvisories: 'No warnings. Idle-cold resume / model switch / compaction / prompt or tool changes appear here before they cost money.',
        prefixCard: 'Fixed prefix & invalidation loss',
        prefixUtil: 'Cache-unit utilization',
        prefixUtilSub: 'actual hit {a} / append-only ideal {b}',
        firstReq: 'First-request reuse',
        firstReqSub: 'new {m} tokens',
        toolTax: 'Unused tool schema tax',
        toolTaxSub: '{n} tools · {c}/request',
        loss: 'Invalidation loss',
        contextRow: 'Context volume',
        contextSub: 'avg {a} tokens · context {c}/request',
        switchLine: 'Switch check: {s} safe · {r} rolled back',
        switchSuspended: ' · auto-downshift suspended',
        switchSafe: 'safe',
        noData: 'No request data yet (plugin just loaded or no active session).',
        loading: 'Loading…',
        error: 'Cannot reach the Host data API (plugin disabled or route missing).',
        effort: 'Reasoning-effort scheduling',
        effortOn: 'On: continuation steps downshift max to high',
        effortOff: 'Off (measured: max→high saves ~0 on deepseek-flash; default)',
        effortHint: 'Effort changes are cache-safe but write model/selection to the session.',
        enable: 'Enable', disable: 'Disable',
        refresh: 'Refresh',
        toolDeferred: 'Report tool deferred (active session); the /token command and this panel still work.',
        toolOk: 'Report tool registered.',
        price: 'price', generated: 'updated', uptime: 'uptime', min: 'min',
        session: 'session', global: 'global',
        stripCache: 'cache {p}%', stripMiss: 'miss ¥{m}', stripWarn: '{n} warnings', stripNoWarn: 'healthy',
        causeNames: {
          first: 'cold start', 'post-compaction': 'post-compaction', 'model-switch': 'model switch',
          'tool-change': 'tool change', 'system-rewrite': 'system rewrite', 'idle-cold': 'idle-cold',
          'unexplained-miss': 'likely eviction', incremental: 'normal growth',
        },
      },
    }

    const pageLang = () => {
      try {
        const lang = (document.documentElement && document.documentElement.lang) || navigator.language || 'en'
        return String(lang).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }
    const T = (key, vars) => {
      const locale = pageLang()
      const dict = STR[locale] || STR.en
      let s = dict[key] !== undefined ? dict[key] : STR.en[key] !== undefined ? STR.en[key] : key
      if (typeof s === 'string' && vars) {
        s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m))
      }
      return s
    }
    const fmtInt = (n) => {
      const v = Number(n || 0)
      return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
    }
    const fmtMoney = (n) => {
      const v = Number(n || 0)
      if (v === 0) return '¥0'
      if (Math.abs(v) < 0.01) return '¥' + v.toFixed(5)
      if (Math.abs(v) < 1) return '¥' + v.toFixed(4)
      return '¥' + v.toFixed(2)
    }

    const CSS = [
      '.tg-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.45;color:var(--dsw-alias-label-primary,#1f2937);max-width:100%;min-width:0;padding-top:2px}',
      '.tg-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}',
      '.tg-headline{min-width:0}',
      '.tg-h1{font-size:17px;font-weight:680;letter-spacing:-.01em;margin:0}',
      '.tg-sub{color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;margin-top:3px}',
      '.tg-meta{justify-content:flex-end}',
      '.tg-tag{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;white-space:nowrap}',
      '.tg-tag strong{color:var(--dsw-alias-label-primary,#1f2937);font-variant-numeric:tabular-nums;font-weight:650}',
      '.tg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.tg-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.tg-kpi{position:relative;background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;padding:12px 14px;min-width:0;overflow:hidden}',
      '.tg-kpi:before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-brand-primary,#2563eb);opacity:.75}',
      '.tg-kpi .tg-l{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.tg-kpi .tg-v{font-size:22px;font-weight:680;font-variant-numeric:tabular-nums;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}',
      '.tg-kpi .tg-s{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;margin-top:3px;line-height:1.35}',
      '.tg-grid{display:flex;flex-direction:column;gap:14px;min-width:0}',
      '.tg-card{background:var(--dsw-alias-bg-layer-2,#f3f4f6);border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;padding:12px 14px;min-width:0;overflow:hidden}',
      '.tg-card.tg-wide{grid-column:1 / -1}',
      '.tg-title{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;font-weight:650;color:var(--dsw-alias-label-secondary,#6b7280);letter-spacing:.05em;text-transform:uppercase;margin-bottom:8px}',
      '.tg-table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}',
      '.tg-table th{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,#6b7280);text-align:left;padding:0 8px 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}',
      '.tg-table td{padding:6px 8px;border-top:1px solid var(--dsw-alias-border-l1,#eceef1);white-space:normal;overflow-wrap:anywhere;vertical-align:top;min-width:0}',
      '.tg-table tbody tr:first-child td{border-top:0}',
      '.tg-table tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 5%,transparent)}',
      '.tg-table td:first-child{color:var(--dsw-alias-label-secondary,#6b7280);width:38%}',
      '.tg-table td.num{text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2937);font-weight:560;white-space:nowrap;width:22%}',
      '.tg-table td.tg-dim{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px;white-space:normal}',
      '.tg-scroll{overflow-x:auto;margin-top:8px;max-width:100%}',
      '.tg-scroll .tg-table{table-layout:auto}',
      '.tg-scroll .tg-table td,.tg-scroll .tg-table th{white-space:nowrap}',
      '.tg-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11.5px}',
      '.tg-summary{display:flex;gap:8px;flex-wrap:wrap}',
      '.tg-warn{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 30%,transparent);border-left:3px solid var(--dsw-alias-state-warn-primary,#d97706);padding:8px 10px;margin-top:8px;font-size:12px;line-height:1.5;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 6%,transparent);border-radius:8px}',
      '.tg-ok{color:var(--dsw-alias-state-success-primary,#15803d)}',
      '.tg-dim{color:var(--dsw-alias-label-secondary,#6b7280)}',
      '.tg-btn{border:1px solid var(--dsw-alias-border-l2,#d1d5db);background:transparent;color:inherit;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:520;cursor:pointer;transition:border-color .12s,background .12s}',
      '.tg-btn:hover{border-color:var(--dsw-alias-brand-primary,#2563eb);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 6%,transparent)}',
      '.tg-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.tg-btn.tg-primary{border-color:var(--dsw-alias-brand-primary,#2563eb);background:var(--dsw-alias-brand-primary,#2563eb);color:#fff}',
      '.tg-btn.tg-primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#2563eb) 88%,#000)}',
      '.tg-pre{white-space:pre-wrap;font-size:11px;line-height:1.5;max-height:200px;overflow:auto;margin:10px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-3,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}',
      '.tg-strip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}',
      '.tg-strip .tg-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#15803d);flex:none}',
      '.tg-strip.tg-strip-warn .tg-dot{background:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.tg-sep{opacity:.45}',
      '@media (max-width:520px){.tg-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}',
    ].join('\n')

    let styled = false
    function ensureStyles() {
      if (styled || typeof document === 'undefined') return
      try {
        const el = document.createElement('style')
        el.setAttribute('data-token-governor', '')
        el.textContent = CSS
        document.head.appendChild(el)
        styled = true
      } catch {}
    }

    async function fetchWithRetry(url, options, attempts) {
      const tries = attempts || 5
      let lastError
      for (let i = 0; i < tries; i += 1) {
        try {
          const response = await fetch(url, options)
          if (response.ok) return response
          lastError = new Error('HTTP ' + response.status)
          // Route missing (host still applying) => retry; other 4xx is final.
          if (response.status !== 404 && response.status < 500) throw lastError
        } catch (error) {
          lastError = error
        }
        if (i < tries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)))
        }
      }
      throw lastError
    }

    async function apiGet(pathname) {
      const response = await fetchWithRetry(API + (pathname || '/report'), { headers: { accept: 'application/json' } })
      return response.json()
    }

    async function apiPost(pathname, body) {
      const payload = body || {}
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(payload)) {
        query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
      const target = API + pathname + (query.toString() ? '?' + query.toString() : '')
      const response = await fetchWithRetry(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      return response.json()
    }
    async function apiPolicy(patch) {
      return apiPost('/policy', patch)
    }

    /** Pick the session with the most recent request; fall back to global. */
    function pickSession(snapshot) {
      const sessions = snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : []
      if (sessions.length === 0) return undefined
      let best
      let bestTs = -1
      for (const session of sessions) {
        const recent = Array.isArray(session.recent) ? session.recent : []
        const ts = recent.length > 0 ? Number(recent[recent.length - 1].ts || 0) : 0
        if (ts > bestTs) { bestTs = ts; best = session }
      }
      return best || sessions[0]
    }

    function useSnapshot(intervalMs) {
      const [state, setState] = React.useState({ status: 'loading', data: undefined })
      const load = React.useCallback(() => {
        apiGet()
          .then((data) => setState({ status: 'ok', data }))
          .catch(() => setState((prev) => ({ status: prev.status === 'ok' ? 'ok' : 'error', data: prev.data })))
      }, [])
      React.useEffect(() => {
        let alive = true
        load()
        const timer = setInterval(() => { if (alive) load() }, intervalMs)
        return () => { alive = false; clearInterval(timer) }
      }, [load, intervalMs])
      return [state, load]
    }

    /** Keep a broken panel from taking down the Settings page or composer. */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h('div', { className: 'tg-warn' }, 'Token Governor UI error: ' + String(this.state.error && this.state.error.message || this.state.error))
        }
        return this.props.children
      }
    }

    function causeRows(session, causeNames) {
      const byCause = (session && session.cache && session.cache.byCause) || {}
      return Object.keys(byCause)
        .map((key) => ({
          key,
          name: causeNames[key] || key,
          requests: byCause[key].requests || 0,
          missTokens: byCause[key].missTokens || 0,
          lossTokens: byCause[key].lossTokens || 0,
          cost: byCause[key].cost || 0,
        }))
        .filter((row) => row.missTokens > 0 || row.lossTokens > 0)
        .sort((a, b) => b.cost - a.cost)
    }

    function Dashboard() {
      ensureStyles()
      const [state, load] = useSnapshot(4000)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [trimNotice, setTrimNotice] = React.useState('')
      const [handoffText, setHandoffText] = React.useState('')
      const [verifyText, setVerifyText] = React.useState('')
      const [newSessionText, setNewSessionText] = React.useState('')

      const snapshot = state.data
      const session = pickSession(snapshot)
      const global = (snapshot && snapshot.global) || {}
      const totals = (session && session.totals) || global.totals || {}
      const hitPct = session ? session.cacheHitPct : global.cacheHitPct
      const causeNames = T('causeNames')
      const rows = causeRows(session, causeNames)
      const metrics = (session && session.cache && session.cache.metrics) || {}
      const missCost = rows.reduce((sum, row) => sum + row.cost, 0)
      const avoidable = Number(metrics.avoidableCost !== undefined
        ? metrics.avoidableCost
        : rows.filter((row) => row.key !== 'first' && row.key !== 'incremental').reduce((sum, row) => sum + row.cost, 0))
      const advisories = (session && session.cache && Array.isArray(session.cache.advisories)) ? session.cache.advisories.slice().reverse() : []
      const effortOn = Boolean(snapshot && snapshot.config && snapshot.config.effortPolicy && snapshot.config.effortPolicy.enabled)
      const t = totals || {}
      const cost = Number(t.cost || 0)
      const requestCount = Number(t.requests || 0)
      const perRequest = Number(metrics.perRequestCost !== undefined ? metrics.perRequestCost : (requestCount > 0 ? cost / requestCount : 0))
      const hitCostSharePct = Number(metrics.hitCostSharePct !== undefined ? metrics.hitCostSharePct : 0)
      const hitShareOfInputPct = Number(metrics.hitShareOfInputPct !== undefined ? metrics.hitShareOfInputPct : 0)

      const toggleEffort = () => {
        if (busy) return
        setBusy(true)
        setNotice('')
        apiPolicy({ enabled: !effortOn })
          .then(() => { setNotice('OK'); load() })
          .catch(() => setNotice(T('error')))
          .finally(() => setBusy(false))
      }

      const applyTrim = () => {
        if (busy) return
        setBusy(true)
        setTrimNotice('')
        apiPost('/tool-budget', { apply: true })
          .then((result) => {
            setTrimNotice(result && result.applied
              ? T('trimApplied', { n: result.toolBudget && result.toolBudget.deny ? result.toolBudget.deny.length : 0 })
              : T('trimNone'))
            load()
          })
          .catch(() => setTrimNotice(T('error')))
          .finally(() => setBusy(false))
      }

      const doHandoff = () => {
        const id = session && session.session ? encodeURIComponent(session.session) : ''
        apiGet('/handoff' + (id ? '?session=' + id : ''))
          .then((result) => setHandoffText(String(result.text || '')))
          .catch(() => setHandoffText(T('error')))
      }
      const doVerify = () => {
        setVerifyText('…')
        apiPost('/terse-verify', {})
          .then((result) => setVerifyText(result && result.terseInjected
            ? T('verifyOk', { id: (result.sessionId || '?').slice(-8) })
            : T('verifyFail')))
          .catch(() => setVerifyText(T('error')))
      }
      // One-click session handoff: creates a fresh session and posts the handoff
      // note into it (the -94%/-request lever for large contexts).
      const doNewSession = () => {
        const id = session && session.session ? encodeURIComponent(session.session) : ''
        setNewSessionText('…')
        apiPost('/new-session' + (id ? '?session=' + id : ''), { confirm: true })
          .then((result) => setNewSessionText(result && result.ok !== false
            ? T('newSessionOk', { id: String(result.sessionId || '?').slice(-8) })
            : T('error')))
          .catch(() => setNewSessionText(T('error')))
      }
      // Every runtime switch from the host snapshot, toggled via POST /switch.
      const switches = Array.isArray(snapshot && snapshot.switches) ? snapshot.switches : []
      const [switchNote, setSwitchNote] = React.useState('')
      const toggleSwitch = (item) => {
        setSwitchNote('…')
        apiPost('/switch', { id: item.id, on: !item.on })
          .then(() => { setSwitchNote(''); load() })
          .catch(() => setSwitchNote(T('error')))
      }

      const kpis = [        { label: T('hitRate'), value: hitPct === undefined ? '—' : Number(hitPct).toFixed(2) + '%', sub: T('session') + ' ' + (session ? session.session : '—') },
        { label: T('perReq'), value: perRequest > 0 ? fmtMoney(perRequest) : '—', sub: T('perReqSub', { k: fmtMoney(perRequest * 1000) }) },
        { label: T('hitShare'), value: hitCostSharePct > 0 ? hitCostSharePct.toFixed(0) + '%' : '—', sub: T('hitShareSub', { i: hitShareOfInputPct.toFixed(0) }) },
        { label: T('avoidable'), value: fmtMoney(avoidable), sub: avoidable > 0 ? '⚠' : T('stripNoWarn') },
      ]

      return h('div', { className: 'tg-root' },
        h('div', { className: 'tg-header' },
          h('div', { className: 'tg-headline' },
            h('div', { className: 'tg-h1' }, T('title')),
            h('div', { className: 'tg-sub' }, T('subtitle')),
          ),
          snapshot ? h('div', { className: 'tg-row tg-meta' },
            h('button', { className: 'tg-btn tg-primary', onClick: load, type: 'button' }, T('refresh')),
          ) : null,
        ),
        state.status === 'error' ? h('div', { className: 'tg-warn' }, T('error')) : null,
        state.status === 'loading' && !snapshot ? h('div', { className: 'tg-dim' }, T('loading')) : null,
        snapshot ? h('div', { className: 'tg-summary' },
          h('span', { className: 'tg-tag' }, T('bill'), ' ', h('strong', null, fmtMoney(cost))),
          h('span', { className: 'tg-tag' }, T('missCost'), ' ', h('strong', null, fmtMoney(missCost))),
          h('span', { className: 'tg-tag' }, h('strong', null, fmtInt(requestCount)), ' ', T('requestsLabel')),
          h('span', { className: 'tg-tag' }, T('price') + ' ' + (snapshot.priceVersion || '—')),
          h('span', { className: 'tg-tag' }, T('uptime') + ' ' + Math.round((snapshot.uptimeSec || 0) / 60) + ' ' + T('min')),
          h('span', { className: 'tg-tag' }, T('generated'), ' ', h('strong', null, String(snapshot.generatedAt || '').slice(11, 19))),
        ) : null,
        snapshot ? h('div', { className: 'tg-kpis' }, kpis.map((kpi, index) => h('div', { className: 'tg-kpi', key: index },
          h('div', { className: 'tg-l' }, kpi.label),
          h('div', { className: 'tg-v' }, kpi.value),
          h('div', { className: 'tg-s' }, kpi.sub),
        ))) : null,
        h('div', { className: 'tg-grid' },
        switches.length > 0 ? h('div', { className: 'tg-card tg-wide' },
          h('div', { className: 'tg-title' }, T('switchesTitle')),
          h('div', { className: 'tg-dim', style: { marginBottom: '6px' } }, T('switchesHint')),
          switches.map((item) => h('div', {
            key: item.id,
            className: 'tg-row',
            style: {
              alignItems: 'flex-start',
              gap: '12px',
              padding: '8px 0',
              borderTop: '1px solid var(--dsw-alias-border-l1,#e5e7eb)',
            },
          },
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('strong', null, item.label),
                h('span', { className: 'tg-tag' },
                  item.scope === 'new-agent' ? T('scopeNewAgent')
                    : item.scope === 'restart' ? T('scopeRestart') : T('scopeImmediate')),
              ),
              h('div', { className: 'tg-dim', style: { marginTop: '2px' } }, T('onHowPrefix') + item.onHow),
              h('div', { className: 'tg-dim' }, T('offHowPrefix') + item.offHow),
            ),
            h('button', {
              className: 'tg-btn' + (item.on ? ' tg-primary' : ''),
              type: 'button',
              onClick: () => toggleSwitch(item),
            }, item.on ? T('switchOn') : T('switchOff')),
          )),
          switchNote ? h('div', { className: 'tg-dim' }, switchNote) : null,
        ) : null,
        rows.length > 0 ? h('div', { className: 'tg-card' },
          h('div', { className: 'tg-title' }, T('source')),
          h('table', { className: 'tg-table' },
            h('tbody', null, rows.slice(0, 7).map((row) => h('tr', { key: row.key },
              h('td', null, row.name),
              h('td', { className: 'num' }, fmtInt(row.requests)),
              h('td', { className: 'num' }, fmtInt(row.lossTokens || row.missTokens)),
              h('td', { className: 'num' }, fmtMoney(row.cost)),
            ))),
          ),
        ) : null,
        h('div', { className: 'tg-card' },
          h('div', { className: 'tg-title' }, T('prefixCard')),
          h('table', { className: 'tg-table' },
            h('tbody', null,
              h('tr', null,
                h('td', null, T('prefixUtil')),
                h('td', { className: 'num' }, metrics.prefixUtilizationPct !== null && metrics.prefixUtilizationPct !== undefined ? Number(metrics.prefixUtilizationPct).toFixed(2) + '%' : '—'),
                h('td', { className: 'tg-dim' }, T('prefixUtilSub', { a: fmtInt(metrics.mainHitTokens || 0), b: fmtInt(metrics.expectedHitTokens || 0) })),
              ),
              h('tr', null,
                h('td', null, T('firstReq')),
                h('td', { className: 'num' }, metrics.firstRequest ? fmtInt(metrics.firstRequest.hit) : '—'),
                h('td', { className: 'tg-dim' }, metrics.firstRequest ? T('firstReqSub', { m: fmtInt(metrics.firstRequest.miss || 0) }) : '—'),
              ),
              h('tr', null,
                h('td', null, T('toolTax')),
                h('td', { className: 'num' }, metrics.toolTax ? fmtInt(metrics.toolTax.tokens) : '—'),
                h('td', { className: 'tg-dim' }, metrics.toolTax ? T('toolTaxSub', { n: metrics.toolTax.count, c: fmtMoney(metrics.toolTax.perRequestCost) }) : '—'),
              ),
              h('tr', null,
                h('td', null, T('loss')),
                h('td', { className: 'num' }, fmtInt(metrics.invalidationLossTokens || 0)),
                h('td', { className: 'num' }, fmtMoney(metrics.invalidationLossCost || 0)),
              ),
              h('tr', null,
                h('td', null, T('contextRow')),
                h('td', { className: 'num' }, fmtInt(metrics.avgContextTokens || 0)),
                h('td', { className: 'tg-dim' }, T('contextSub', {
                  a: fmtInt(metrics.avgContextTokens || 0),
                  c: fmtMoney(metrics.contextCostPerRequest || 0),
                })),
              ),
            ),
          ),
        ),
        h('div', { className: 'tg-card' },
          h('div', { className: 'tg-title' }, T('savingsCard')),
          h('table', { className: 'tg-table' },
            h('tbody', null,
              h('tr', null,
                h('td', null, T('peakRow', { c: fmtMoney(metrics.peakCost || 0) })),
                h('td', { className: 'num' }, Number(metrics.peakSavingPotential || 0) > 0 ? T('peakSub', { s: fmtMoney(metrics.peakSavingPotential) }) : '—'),
                h('td', { className: 'tg-dim' }, Number(metrics.peakCost || 0) > 0 ? '' : T('peakNone')),
              ),
              h('tr', null,
                h('td', null, T('trimRow')),
                h('td', { className: 'num' }, metrics.toolTax ? fmtInt(metrics.toolTax.tokens) : '—'),
                h('td', { className: 'tg-dim' }, metrics.toolTax
                  ? T('trimSub', { n: metrics.toolTax.count, t: fmtInt(metrics.toolTax.tokens), c: fmtMoney(metrics.toolTax.perRequestCost) })
                  : T('trimNoSample')),
              ),
              h('tr', null,
                h('td', null, T('turnRow')),
                h('td', { className: 'num' }, fmtMoney(metrics.turnCost || 0)),
                h('td', { className: 'tg-dim' }, T('turnSub', { t: fmtMoney(metrics.turnCost || 0), a: fmtMoney(metrics.averageTurnCost || 0) })),
              ),
              h('tr', null,
                h('td', null, T('budgetRow', { m: metrics.budget && metrics.budget.active ? (metrics.budget.mode === 'turn' ? T('budgetTurn') : T('budgetSession')) : '—' })),
                h('td', { className: 'num' }, metrics.budget && metrics.budget.active && metrics.budget.ratioPct !== null ? Number(metrics.budget.ratioPct).toFixed(0) + '%' : '—'),
                h('td', { className: 'tg-dim' }, metrics.budget && metrics.budget.active
                  ? T('budgetSub', {
                    s: fmtMoney(metrics.budget.spent || 0),
                    l: fmtMoney(metrics.budget.limit || 0),
                    p: metrics.budget.protectedNow ? T('budgetProtected') : T('budgetNotProtected'),
                  })
                  : T('budgetOff')),
              ),
            ),
          ),
          h('div', { className: 'tg-row', style: { marginTop: '8px' } },
            h('button', { className: 'tg-btn', onClick: applyTrim, disabled: busy || !metrics.toolTax, type: 'button' }, T('trimApply')),
            h('span', { className: 'tg-dim' }, trimNotice
              || (snapshot && snapshot.config && snapshot.config.toolBudget && snapshot.config.toolBudget.enabled
                ? T('trimOn', { n: (snapshot.config.toolBudget.deny || []).length })
                : T('trimDisabled'))),
          ),
        ),
        (() => {
          const decision = metrics.decision || {}
          const segments = (snapshot && Array.isArray(snapshot.ab)) ? snapshot.ab : []
          const abParts = segments.filter((segment) => segment.requests > 0)
            .map((segment) => (segment.compress ? 'ON ' : 'OFF ') + fmtMoney(segment.cost / segment.requests) +
              (segment.errors ? ` (${segment.errors} err)` : ''))
          const children = (snapshot && Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
            .filter((child) => session && child.parentSession === session.session)
          return h('div', { className: 'tg-card' },
            h('div', { className: 'tg-title' }, T('autoCard')),
            h('table', { className: 'tg-table' },
              h('tbody', null,
                h('tr', null,
                  h('td', null, T('decideRow')),
                  h('td', { className: 'num' }, fmtMoney(decision.continuePerRequest || 0)),
                  h('td', { className: 'tg-dim' }, T('decideSub', {
                    c: fmtMoney(decision.continuePerRequest || 0),
                    m: fmtMoney(decision.compactPerRequest || 0),
                    p: fmtMoney(decision.compactPenalty || 0),
                    b: Number(decision.breakEvenTurns || 0).toFixed(1),
                    n: fmtMoney(decision.newSessionPerRequest || 0),
                  })),
                ),
                (metrics.toolOut && Array.isArray(metrics.toolOut.growth) && metrics.toolOut.growth.length > 0) ? h('tr', null,
                  h('td', null, T('growthRow')),
                  h('td', { className: 'num' }, '+' + fmtInt(metrics.toolOut.growth.reduce((sum, item) => sum + Number(item.delta || 0), 0))),
                  h('td', { className: 'tg-dim' }, T('growthSub', { r: fmtInt(metrics.toolOut.readReused || 0) })),
                ) : null,
                segments.length > 1 ? h('tr', null,
                  h('td', null, T('abRow')),
                  h('td', { className: 'num' }, String(segments.length)),
                  h('td', { className: 'tg-dim' }, T('abSub', { on: abParts[0] || '—', off: abParts[1] || '—' })),
                ) : null,
                children.length > 0 ? h('tr', null,
                  h('td', null, T('childRow')),
                  h('td', { className: 'num' }, fmtInt(children.length)),
                  h('td', { className: 'tg-dim' }, T('childSub', {
                    n: children.length,
                    c: fmtMoney(children.reduce((sum, child) => sum + Number((child.totals && child.totals.cost) || 0), 0)),
                    d: children.reduce((sum, child) => sum + Number((child.tools && child.tools.total) || 0), 0),
                  })),
                ) : null,
              ),
            ),
            h('div', { className: 'tg-row', style: { marginTop: '8px' } },
              h('button', { className: 'tg-btn', onClick: doNewSession, type: 'button' }, T('newSessionBtn')),
              h('button', { className: 'tg-btn', onClick: doHandoff, type: 'button' }, T('handoffBtn')),
              h('button', { className: 'tg-btn', onClick: doVerify, type: 'button' }, T('verifyBtn')),
              verifyText ? h('span', { className: 'tg-dim' }, verifyText) : null,
              newSessionText ? h('span', { className: 'tg-dim' }, newSessionText) : null,
            ),
            handoffText ? h('pre', { className: 'tg-pre' }, handoffText) : null,
          )
        })(),
        (() => {
          const ledger = (snapshot && snapshot.ledger) || {}
          const totals = ledger.totals || (snapshot && snapshot.global && snapshot.global.totals) || {}
          const hit = Number(totals.cacheReadTokens || 0)
          const miss = Number(totals.inputMissTokens || 0)
          const output = Number(totals.outputTokens || 0)
          const requests = Number(totals.requests || 0)
          const mainRequests = Number(totals.mainRequests || 0)
          const auxRequests = Number(totals.auxRequests || 0)
          const row = (label, value) => h('tr', null, h('td', null, label), h('td', { className: 'num' }, value))
          return h('div', { className: 'tg-card tg-wide' },
            h('div', { className: 'tg-title' }, T('totalsCard')),
            h('table', { className: 'tg-table' },
              h('tbody', null,
                row(T('totalTokens'), fmtInt(hit + miss + output)),
                row(T('inputHit'), fmtInt(hit)),
                row(T('inputMiss'), fmtInt(miss)),
                row(T('outputLabel'), fmtInt(output)),
                h('tr', null,
                  h('td', null, T('apiRequests')),
                  h('td', { className: 'num' }, fmtInt(requests)),
                  h('td', { className: 'tg-dim' }, T('requestsDetail', { main: fmtInt(mainRequests), aux: fmtInt(auxRequests) })),
                ),
              ),
            ),
            ledger.since !== undefined ? h('div', { className: 'tg-dim', style: { marginTop: '6px' } },
              T('ledgerSince', {
                since: new Date(Number(ledger.since)).toLocaleString(),
                records: fmtInt(ledger.records || 0),
                sessions: fmtInt((ledger.sessions || []).length),
              })) : null,
            (ledger.sessions && ledger.sessions.length > 0) ? h('div', { className: 'tg-scroll' },
              h('table', { className: 'tg-table' },
                h('thead', null, h('tr', null,
                  h('th', null, T('sessCol')),
                  h('th', null, T('reqCol')),
                  h('th', null, T('hitCol')),
                  h('th', null, T('missCol')),
                  h('th', null, T('outCol')),
                  h('th', null, T('costCol')),
                )),
                h('tbody', null, ledger.sessions.slice(0, 8).map((entry) =>
                  h('tr', { key: entry.id },
                    h('td', { className: 'tg-mono' }, entry.short),
                    h('td', { className: 'num' }, fmtInt(entry.totals.requests)),
                    h('td', { className: 'num' }, fmtInt(entry.totals.cacheReadTokens)),
                    h('td', { className: 'num' }, fmtInt(entry.totals.inputMissTokens)),
                    h('td', { className: 'num' }, fmtInt(entry.totals.outputTokens)),
                    h('td', { className: 'num' }, fmtMoney(entry.totals.cost)),
                  ))),
              ),
            ) : null,
          )
        })(),
        h('div', { className: 'tg-card' },
          h('div', { className: 'tg-title' }, T('advisories')),
          advisories.length === 0
            ? h('div', { className: 'tg-dim tg-ok' }, T('noAdvisories'))
            : h('div', null, advisories.slice(0, 6).map((item, index) => h('div', { className: 'tg-warn', key: index }, '⚠ ' + String(item.text || '')))),
        ),
        h('div', { className: 'tg-card' },
          h('div', { className: 'tg-title' }, T('effort')),
          h('div', { className: 'tg-row' },
            h('span', null, effortOn ? T('effortOn') : T('effortOff')),
            h('button', { className: 'tg-btn', onClick: toggleEffort, disabled: busy, type: 'button' }, effortOn ? T('disable') : T('enable')),
          ),
          h('div', { className: 'tg-sub' }, T('effortHint')),
          h('div', { className: 'tg-sub' }, T('switchLine', {
            s: (session && session.effort && session.effort.switchSafe) || 0,
            r: (session && session.effort && session.effort.rollbacks) || 0,
          }) + (session && session.effort && session.effort.suspended ? T('switchSuspended') : '')),
          h('div', { className: 'tg-sub' }, snapshot && snapshot.tool && snapshot.tool.deferred ? T('toolDeferred') : T('toolOk')),
          notice ? h('div', { className: 'tg-sub' }, notice) : null,
        ),
        ),
      )
    }

    function Strip() {
      ensureStyles()
      const [state] = useSnapshot(15000)
      const snapshot = state.data
      if (!snapshot) return null
      const session = pickSession(snapshot)
      const global = snapshot.global || {}
      const hitPct = session ? session.cacheHitPct : global.cacheHitPct
      const advisories = (session && session.cache && session.cache.advisories) || []
      const byCause = (session && session.cache && session.cache.byCause) || {}
      const metrics = (session && session.cache && session.cache.metrics) || {}
      const perRequest = Number(metrics.perRequestCost || 0)
      const missCost = Object.keys(byCause).reduce((sum, key) => sum + Number(byCause[key].cost || 0), 0)
      const warnCount = advisories.length
      const title = T('title') + ' · ' + T('hitRate') + ' ' + Number(hitPct || 0).toFixed(2) + '% · ' + T('missCost') + ' ' + fmtMoney(missCost)
      return h('div', { className: 'tg-strip' + (warnCount > 0 ? ' tg-strip-warn' : ''), title },
        h('span', { className: 'tg-dot' }),
        h('span', null, T('stripCache', { p: Number(hitPct || 0).toFixed(1) })),
        h('span', { className: 'tg-sep' }, '·'),
        h('span', null, T('stripPerReq', { v: perRequest > 0 ? fmtMoney(perRequest).replace('¥', '') : '0' })),
        h('span', { className: 'tg-sep' }, '·'),
        h('span', null, T('stripMiss', { m: fmtMoney(missCost).replace('¥', '') })),
        h('span', { className: 'tg-sep' }, '·'),
        h('span', null, warnCount > 0 ? T('stripWarn', { n: warnCount }) : T('stripNoWarn')),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'token-governor', order: 440, label: () => T('label') },
          function () { return h(Boundary, null, h(Dashboard)) },
        ))
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'token-governor-strip', order: 86 },
          function () { return h(Boundary, null, h(Strip)) },
        ))
      },
    }
  },
})
