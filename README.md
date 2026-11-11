# dsh-plugin-token-governor（Token 管家）

DeepSeek Harness（dsh）插件：**按 DeepSeek 官方计费口径核算真实 token 成本**，并用
**缓存安全的方式**调度推理强度（reasoningEffort），在不删历史、不改工具 schema、
不碰请求前缀的前提下省输出 token。

> 省 token 的红线来自对官方计费与缓存机制的调研结论：  
> 1) 缓存命中价只有未命中价的 1/50（flash）/1/30（pro），**任何改写历史/前缀的行为都可能"省 token 涨成本"**；  
> 2) 1 个输出 token 的价格 = 90~200 个缓存命中输入 token，**思考/输出才是最大杠杆**；  
> 3) 带 tools 的 Agent 请求必须回传 `reasoning_content`，事后剪推理历史不可行——只能事前降 effort。  
> 因此本插件只做三件事：**计量、缓存哨兵、以及步骤边界的 effort 调度**。

## 它做什么

| 能力 | 说明 | 是否改模型输入 |
|---|---|---|
| 真实计费核算 | 读 `llm/stream` 的 provider usage（`inputTokens` 未命中 / `cacheReadTokens` 命中 / `outputTokens` 含思考），按官方价目表（峰谷、CNY/USD、镜像模型名陷阱）算真实费用 | 不改 |
| 思考强度调度 | 步骤边界用 `agent.model.select()` 把工具续步的 effort 从 `max` 降到 `high`；失败/工具报错时升回原始档；轮末自动恢复 | **不改前缀**（effort 不进 prompt token），缓存照常命中 |
| 缓存哨兵 | 相邻主请求的缓存命中率骤降时记一条"疑似前缀失效"，给出额外未命中 token 数与损失金额，并归因到最近的会话事件（工具 schema 变更/系统提示改写/压缩/图片卸载） | 不改 |
| 成本构成 | 缓存命中 vs 未命中 vs 输出三线占比、工具 schema 固定税（42 个工具≈13~16k tokens/请求）、Web 搜索按次成本（¥0.005/次） | 不改 |
| 压缩盈亏提示 | 上下文接近压缩水位时，按缓存价差算出"压缩后需再跑几轮才回本"，明确"压缩是防溢出手段，不是省钱手段" | 不改 |
| 报告出口 | `/token` 命令（不产生模型 token）、`token_report` 工具、可选 HTTP JSON API、OS 临时目录快照 | 仅工具 schema（约 0.2k tokens/请求） |

## 安装

只通过 `plugin_manager` 安装（不要手写 profile 的 `package.json` / `cordis.patch.yml`）：

```
plugin_manager action=install_bundle target="<你克隆本仓库的路径>/dsh-plugin-token-governor"
```

安装后确认行已生效：`cordis_inspect_query` → `Config.listConfigs name=dsh-plugin-token-governor`
（本插件未导出 `Config` schema，config 由 `apply` 宽松合并，`status` 显示 `absent` 属正常）。

## 使用

### GUI（v0.4+，不占模型 token）

- **Settings → 缓存与成本**（order 440）：缓存命中率、**每请求成本（¥/请求、¥/千请求）**、
  **命中输入成本占比（占输入成本 / 占总费用）**、未命中额外成本、其中可避免部分、未命中来源表、
  缓存单元利用率与失效损失、固定前缀与工具税、缓存预警列表、思考强度调度开关。
- **输入框下方实时条**：`缓存 99.9% · ¥0.0148/请求 · miss ¥0.0003 · 正常 / N 条预警`。
- 面板与实时条每 4s / 15s 轮询 Host 的 `/token-governor/api/report`，不产生任何模型请求。
- `/token` 的「成本口径」行同样给出：每请求 ¥、每千请求 ¥、命中输入成本占比（含占输入成本）；
  这是为了直接对照"命中率高 ≠ 账单低"——命中 token 的量才是输入成本主体。
- 若页面未显示新面板，刷新一次页面（F5）即可；新增的面板不改任何 prompt/工具声明，因此不影响缓存。

### 命令与工具

- `/token` — 本会话报告（请求数、缓存命中率、三线费用、effort 调度次数、缓存异常、schema 固定税、最近轮次）
- `/token all` — 全局（进程启动以来）
- `/token prices` — 官方价目表 + 当前处于高峰/空闲
- `/token auto off` / `/token auto on` — 即时开关 effort 调度（默认关闭）
- `/token reset` — 清零本会话统计（不影响真实账单）
- `token_report` 工具（无活动会话时注册；有活动会话时延迟到下次加载，`/token` 与 HTTP API 不受影响）

### HTTP（调试/自建看板）

```
GET  /token-governor/api/report                 # 结构化 JSON（面板数据）
GET  /token-governor/api/text?session=<短id>    # 与会话报告相同的文本
POST /token-governor/api/policy {"enabled":true,"continuationEffort":"low"}
POST /token-governor/api/auto   {"enabled":false}
```


## 配置（bundle 行 `config:`，改后需重启插件）

```yaml
- id: token-governor
  name: dsh-plugin-token-governor
  config:
    currency: CNY                 # CNY | USD（两套官方价，不是汇率换算）
    modelPrices: {}               # 自定义模型价格（每 1M tokens）
    holidayDates: []              # 北京时间法定节假日 YYYY-MM-DD（空闲价）
    effortPolicy:
      enabled: true
      continuationEffort: high    # 工具续步使用的 effort（off|low|high|max）
      onlyDownshiftMax: true      # 保守：只降 max，不动用户的其他设置
      escalateOnError: true       # 请求失败后升回原始 effort
      escalateOnToolError: true   # 工具报错后升回
      restoreAtTurnEnd: true      # 轮末恢复原始 effort
      firstStepEffort: null       # 显式指定"每轮第一步"的 effort；null=沿用原值
    cacheAnomaly:
      enabled: true
      minPromptTokens: 5000       # 上一条主请求 prompt 至少这么大才检测
      hitRateFloor: 0.5           # 命中率低于上一条 prompt×0.5 视为异常
      causeWindowMs: 120000       # 归因窗口
    snapshotPath: ''              # 空=写 OS 临时目录 dsh-token-governor.snapshot.json
    snapshotIntervalMs: 1500
    apiEnabled: true
    apiPath: /token-governor      # GET <path>/api/report, POST <path>/api/auto
```

价格版本固定在 `governance.js` 的 `PRICE_VERSION = '2026-11-11'`（官方抓取日）。
DeepSeek 2026 年内多次调价，**上线前请核对官方价格页并按需覆盖 `modelPrices`**。

## v0.18：上下文体积六项优化

1. **一键交接新会话**：`/token new`（或 `POST /api/new-session?confirm=true`）生成交接单、创建新会话并把交接单作为首条消息投递；当前 42 万上下文下每请求约 ¥0.0084 → ¥0.0005。
2. **无损编码扩展**：嵌套 JSON 扁平化为点号字段、JSONL 按行解析为数组，仍是零损失 TSV。
3. **重复读取复用**：同一文件同一区间内容未变时，第二次 `read` 直接引用上文（不重复占上下文）。
4. **压缩预算**：估算超过 4000 tokens 的大结果按 ≤35% 目标压缩（实测 300 行 22,127B→6,790B，−69%）。
5. **上下文增长归因**：按请求记录 prompt 增量，`/token` 与面板显示"本会话 +N（工具结果占 X%），最近 5 步 +M"。
6. **compaction 后端 spike**：`docs/compaction-backend-spike.md`，结论是保持官方 backend，优先用交接新会话替代。



## v0.15：六项开源灵感优化

1. **近重复压缩**：工具输出先归一化（去时间戳/UUID/hex），相似度 ≥0.9 且差异 ≤12 行 → 用 stub 替代，只列出变更行 + 全文 locator（实测 7,313B→stub，~99% 相同只改 1 行）。
2. **按工具保留策略**：`read` 保留 import/class/def/签名/TODO 等 landmark 行且目标压到 40%；`grep/search` 每个结果前缀保留 1 行多样化采样；日志/表格保留错误行 ±1 上下文 + 步进采样。
3. **Prompt 风格实验框架**：`/token style on|off` 或 `POST /api/style-experiment`，新会话按 concise/telegraph/dense 轮流分配，`/token` 对比各风格平均输出 token 与失败率。
4. **子会话模型路由**：报告给出"若改 flash 约省 ¥X"；`subagentRoute.enabled` 可对新子 agent 自动降档（fresh 无缓存风险）。
5. **分支/前缀审计**：记录各会话首请求命中，结合父会话重复调用率给出 fork/fresh 建议（已在 v0.13 基础上补充）。
6. **压缩替代（compaction digest）**：上下文超阈值时提示用 `/token handoff` 交接开新会话，避免 /compact 后常驻检查点；自定义 compaction backend 风险过高，暂以交接单替代。

配套修复：HTTP POST 请求体解析增加 query 回退与 Fetch/Node 双模读取（部分传输会吞 body）；单测扩到 **21 项全绿**。



## v0.14：验收缺陷全量修复

- 省 token 估算改为**分词器校准**（CJK ≈0.20、ASCII ≈0.25 tok/char；TSV/JSON 用实测率），不再用字符/4。
- terse-verify：限流（60s）+ 唯一 session id + 用完即删，不再污染会话列表。
- 简洁风格效果可测：按 terse/normal 分组统计平均输出与失败数。
- 压缩 A/B 增加质量指标：失败/触顶/工具错误，按段对比。
- 决策规划器读取真实模型窗口（`llm.resolveModelInfo`），价格未知时不再乱估。
- 官方 spill 预算从 loader 行配置自动读取（不再硬编码 12,500）。
- effort 切换归因：有 compaction/model-switch/system-rewrite/tool-change 等其他已知原因时不再误判为切换导致。
- 错误输出压缩保留错误行 ±1 上下文行。
- 子会话重复检测改用完整指纹字符串（去掉 32-bit hash 碰撞风险）。
- spill 清理：启动时全量清扫 + 运行期每 10 分钟；72h / 每会话 40 个上限。
- 价格表超过 90 天未更新会在 `/token` 告警；`apiToken` 可给 HTTP API 加简易鉴权。
- 移除死配置 `guard.hardTurnCost`；修复 `retries`/触顶统计从未累加的 bug。



## v0.13：压缩 A/B、子会话归因、决策规划器、交接单

- **压缩 A/B**：`/token ab on|off`（或 `POST /api/ab`）切段，`/token` 对比"压缩开/关"的**每请求真实成本**
  （端到端账单口径，不看压缩率）。
- **子会话成本归因**：`/token` 列出子会话请求/成本/上下文，并与父会话比对重复工具调用率：
  ≥40% → 建议 fork（继承上下文省重复读取），否则 fresh（隔离更省）。
- **决策规划器**：`/token` 的「决策」行给出：继续本会话 vs `/compact` 后 vs 新任务新会话的每请求成本、
  压缩一次性代价与回本回合数。
- **交接单**：`/token handoff` 或 `GET /api/handoff`，输出可直接粘贴到新会话的模板（成本、上下文、
  常用工具、落盘原文路径、最近动作）。
- 验收修复：spill 文件 72h/40 个/session 自动清理；snapshot 原子写（避免并发读到半截）；新增编码器单测。



## v0.12.3：与官方原生机制的分工（不冲突）

| 结果规模 | 处理者 | 模型看到 |
|---|---|---|
| ≥12,500 estimated tokens（≈50KB，官方 spill-policy 预算） | **官方 dsh-spill-policy** | head/tail 预览 + 官方 notice + 原文文件路径；我们的插件让路（计入「让路官方 spill」） |
| 1.4KB ~ 预算内 | **Token 管家** | 均匀 JSON→无损 TSV；表格/日志→结构感知步进采样（带行号）；去重 stub；全文落盘 locator |
| 已被官方处理（notice 标记命中） | 官方 | 我们检测 `Omitted N bytes. Full formatted result stored at:` 后跳过（计入「已被官方 spill 处理」） |
| `read/write/edit/present` 等 | 不处理 | 原样 |

实现细节：启动后惰性读 loader 行一次判断 `spill-policy` 是否 active（不在则不设上限，由我们兜底）；
替换时**保留 `additionalContexts`**（修复 save-token 曾吞掉 repeat-tool-reminder 上下文的问题）；
两条链路各写各的 locator，绝不对同一结果二次改写。实测 4000 行输出：官方 spill 处理，本插件让路，无冲突。



## v0.10：TSV 无损重编码（实测生效）+ 简洁输出

**实测**（本会话，30 行均匀 JSON 工具输出）：`1,705 → 694 字符（−59%），估算省 token ≈253`；
结果是可逆的 TSV（`#tsv lossless rows=N fields=...` + 表头 + 行），非截断/摘要。

- 触发条件保守：顶层或单包装数组、全行同构扁平对象、值仅 string/number/boolean/null、
  无 tab/换行/空串/`\N` 歧义；字符节省 <30% 不采纳；`read/write/edit/present` 等工具豁免。
- **与 save-token 的关系**：它先处理时（其压缩开启）会加 `[save-token` 标记，我们的编码让路（不叠加、
  不损坏）。想要"无损优先"：在 Token Saver 面板把 **Compress 关掉**（Dedupe 可保留），TSV 就会接手。
- `/api/tsv {"enabled":false}` 可关；`/token` 显示编码次数/字符节省/让路次数。
- 输出简洁：`terseStyle.mode: concise`（默认对新会话开启）——直接给结论，不重复解释，除非用户要求解释。



## v0.9：文言文/极简压缩方向 —— 用真实 tokenizer 实测后修正

方向假设："文言文 = 意思不变、上下文更短"。用插件自带的 `/api/tokenize` 探针（直接读 provider 的
`input_tokens`，不是字符估算）实测同一段含义的四种写法：

| 写法 | 字符数 | 实际 token | 相对现代中文 |
|---|---:|---:|---:|
| 现代中文 | 664 | 123 | 100% |
| 文言文 | 536 | 135 | **109.8%（更贵）** |
| 电报体（现代词+极简） | 312 | 117 | 95.1% |
| 英文 | 1167 | 255 | 207% |

结论：**文言文在 DeepSeek-V4.1 tokenizer 下反而更贵**——分词器按现代中文高频串合并 token，
文言文用了更"冷门"的字词组合，合并率差。方向本身对，但载体不是文言文：

| 实测有效的"同样信息更短" | 相对基线 |
|---|---:|
| 现代中文行文压缩（保留现代词、删冗余/套话/重复） | **83.7%** |
| JSON 压缩（pretty → minified） | **45.7%** |
| **TSV/表格编码（均匀数组，无损）** | **JSON-pretty 的 30.8% / JSON-min 的 67.5%** |

插件落地：
- `/api/tokenize`：任意文本 → 真实 token 数（用于继续验证各种压缩编码）；
- `terseStyle`：新会话可选 `classical`/`telegraph` 风格注入系统提示（**仅对新 agent 生效，缓存安全**，
  默认关闭；实测 telegraph 只省 ~5%，文言文不推荐）；
- 下一步的正确方向：**工具输出里的均匀 JSON/表格 → 无损 TSV 重编码**（append-only 安全），
  而不是文言文。



## v0.8：强度切换缓存防护 + 上下文体积治理

**① effort 切换的缓存失效检测 + 自动回滚**（防止"中途降档触发整段 miss"重复发生）：
- 每次**自动降档**后盯住下一次主请求：若命中 < 上一条 prompt 的 50%（可配），判定为
  `强度切换（已回滚）` 失效来源，**自动把 effort 切回切换前的值**，并在本会话**暂停自动降档**
  （`/token` 显示"已暂停自动降档"，手动选一次强度或用 `/token auto on` 可解除）；
- 预防：`switchGuard.maxContextTokens` 可设置"超过该上下文大小就不再自动降档"（默认 0=不限）；
- 计量：`思考强度：… 调度 N 次 · 切换安全 S · 回滚 R`。

**② 上下文体积治理**（命中输入是成本主体：本机 39 会话 ≈¥61.9，单请求 ~¥0.012 且随上下文线性）：
- `/token` 新增：`上下文体积：当前 X tokens · 主请求平均 Y · 仅上下文成本约 ¥Z/请求`；
- **任务边界新会话建议**：每个新轮次第一步若上下文 ≥ `contextAdvice.minContextTokens`（默认 15 万），
  提示"若是新任务，新开会话每请求约省 ¥S（冷启动一次性成本另计）"；
- 面板「固定前缀与失效损失」卡片新增"上下文体积（平均 tokens · 每请求成本）"。

```yaml
effortPolicy:
  switchGuard: { enabled: true, maxContextTokens: 0, minContextTokens: 5000, invalidationRatio: 0.5, autoRollback: true }
contextAdvice: { enabled: true, minContextTokens: 150000, newSessionExpectedTokens: 25000 }
```



## 省钱动作（v0.7，能直接省钱的开关）

**任务级结论（本机 39 个 deepseek-account 会话实测）**：每请求成本 ≈ **¥0.012**，且几乎不随步数变化
（第 1-5 步 ¥0.018，第 40+ 步 ¥0.012）→ **同样任务的花费 ≈ 请求次数 × 单请求成本**。
省钱 = 少步数 + 降单请求成本（输出/上下文）+ 避峰。插件把可执行的部分做成了开关：

| 动作 | 数据来源 | 预期省钱 | 风险 |
|---|---|---|---|
| **预算保护（v0.7）**：设本轮/本会话花费上限，达到 softRatio 后**自动把当前任务的续步 effort 降为 low/off**，任务继续但思考更省 | 每轮/每会话真实费用累计 | 输出占比（约 37-45%）× 降档幅度；超预算任务不再失控 | 触发后思考变少（默认 low，可选 off）；默认关闭 |
| **错峰**：显示高峰已花与"排到空闲可省 50%" | 峰/谷分别计价 | 高峰花费的 **50%** | 无 |
| **工具 schema 裁剪**：一键写入 `toolBudget.deny`，只对新会话生效 | 真实调用次数 + schema 大小 | ~6k tokens/请求固定税 | 新会话少这些工具，默认关闭 |
| **轮次成本预警**：`guard.softTurnCost` | 每轮费用 | 防失控 | 无 |

```yaml
budget:
  mode: 'session'        # off | turn | session
  maxSessionCost: 2      # 元；本轮/会话花费上限
  softRatio: 0.8         # 达 80% 触发降档
  downshiftEffort: 'low' # off | low | high
```

```
POST /token-governor/api/budget {"mode":"session","maxSessionCost":2,"softRatio":0.8,"downshiftEffort":"low"}
POST /token-governor/api/budget {"mode":"off"}   # 关闭并恢复原 effort
```

## 缓存命中率治理（重点能力）

先看本机实测（72 个会话 / 9,839 次请求）：

- 整体缓存命中率 **98.93%**；`deepseek-account/deepseek-flash` 路由 **98.86%**。
- 把未命中的 12.4M tokens（该路由）拆开：

| 未命中来源 | 占比 | 说明 |
|---|---:|---|
| 正常新增内容 | 59.9% | 每步新追加的工具结果/消息，**不可避免**（第一次发送必然是 miss） |
| 疑似服务端驱逐 | 20.0% | 空闲/负载导致的 best-effort 缓存清空，平均每次 22.5 万 tokens |
| 压缩后首个请求 | 12.9% | 压缩重写历史 → 新前缀整段 miss，平均 26.6 万 tokens |
| 首次请求（冷启动） | 6.4% | 系统提示+工具 schema+首条消息 |
| 模型切换 | 0.8% | 缓存域重置 |
| 系统提示改写 | 少量 | 前缀从改写点失效 |

**结论：命中率的自然上限就在 99% 附近**（新增内容必然 miss），真正能改善的是那 20%+ 的"一次性灾难性失效"。插件 v0.2 起专门处理这一类：

### v0.5：从"完整匹配缓存单元"原理出发的三项量化

DeepSeek 命中 = **完整匹配某个已落盘的缓存前缀单元**。由此推出一条可度量的"追加式理想"：
历史只追加时，本次请求应命中**上一条 prompt 的全部 tokens**。插件据此计算：

1. **缓存单元利用率** = 实际命中 ÷ 追加式理想（比 `hit/(hit+miss)` 更接近"缓存有没有被破坏"）；
2. **失效损失** = Σ max(0, 上一条 prompt − 本次实际命中)：本机 72 会话合计 **7,314,068 tokens**
   （按 flash 峰/闲价差 ≈ **¥7.2~14.3**），并按来源（压缩后/模型切换/工具集变更/系统提示改写/驱逐）拆分；
3. **首请求固定前缀复用**：41 个 deepseek-account 会话中 **32 个首请求命中 17,792~20,992 tokens**
   （跨会话"公共前缀检测落盘"确实生效；平均首请求 miss 19,439 / hit 12,847）；
4. **工具 schema 固定税**：基于真实调用次数，找出"从未被调用但每请求都在付钱"的工具——
   本机 **26 个未使用工具 ≈ 5,955 tokens/请求**（占工具 schema 约一半；命中价 ≈¥0.00024/请求，
   每会话首请求另省 ≈¥0.012）。可用 `toolBudget.deny` 在**新 agent 创建时**静态裁剪
   （只影响新会话，绝不会改变运行中会话的前缀，缓存安全）：

```yaml
toolBudget:
  enabled: true
  deny: ['schedule_create', 'subagent_fork', 'cordis_define']   # 示例：按 /token 报告候选
```


- **失配归因**：每次主请求的 miss 按来源归类（首次/压缩后/模型切换/工具集变更/系统提示改写/空闲冷缓存/疑似驱逐/正常新增），各自折算多付的 ¥；
- **失效前预警**（写入 `/token` 报告与快照）：
  - 空闲 ≥ `idleColdMinutes`（默认 30 分钟）：提示"缓存可能已过期，下一次请求预计整段未命中 ≈ ¥X，简单问题建议新开会话"；
  - 模型/提供方切换：提示缓存域重置的一次性成本；
  - 压缩重写历史：提示新前缀整段未命中成本 + 回本判断；
  - 系统提示改写：提示前缀失效风险；
  - 工具集变更：提示"从第一个变化的声明 token 起失效"。
- **插件自身零历史改写、零 system prompt 注入**；工具 schema 固定（升级插件不会改变工具字节，避免像 v0.1 安装时那样给运行中的会话造成一次整段 miss）。

**缓存安全做法（有数据支撑）**：
1. **安装/升级带工具的插件请选在会话之间**——本机实测：会话进行中给 PTC 长上下文加一个工具，下一次请求多付 30.8 万 miss tokens（≈¥0.3–0.6）。
2. **不要在同一会话中途切模型/提供方**。
3. **长空闲后恢复**：上下文很大（>20 万）时，若只是简单问题，新开会话比续用旧会话便宜（旧会话首请求整段 miss）。
4. **压缩只在会话还会继续很多轮时做**（break-even：flash 约 10.7 轮、pro 约 6.3 轮，还要算摘要调用）。

**v0.2 验证**：升级重载后本会话命中率 99.9%（命中 448,384 / 未命中 544 tokens），报告能逐笔给出
「未命中额外成本 + 来源 + 可避免/不可避免拆分」；注意：插件重载期间工具短暂消失会触发一次
上下文级 miss（本例约 ¥0.45），这正说明"升级也要选在会话之间"。

**v0.3 缓存安全安装（默认开启）**：插件加载时若检测到**有活动会话**，不再向全局注册
`token_report` 工具（工具声明变化会让运行中的会话前缀缓存从 token 0 失效），而是**延迟到下次
加载**（重启后无会话时注册）。`/token` 命令与 HTTP API 仍可用（命令/HTTP 都不进模型 prompt，
零缓存影响）。这样"安装/升级插件"本身不会再打爆缓存。配置项：
```yaml
toolPolicy:
  enabled: true
  deferWhenSessionsActive: true
```
被延迟时，`GET /token-governor/api/text?session=<id>` 可拿到与会话报告完全相同的文本。

**v0.3.1 实测**：在有活动会话时安装后，快照显示 `tool.registered=false, tool.deferred=true`，
随后请求仍命中 **46.4 万~47.3 万** 缓存 tokens（miss 仅 161~237），**安装/升级不再打爆缓存**；
`/api/text` 正常返回报告。代价只落在"移除旧版本→装新版本"之间的那一次请求（本次约 8.5k miss；
历史多次升级合计：v0.1 首装 30.2 万、两次升级 5.4 万/7.2 万、v0.2 重载 12.3 万 miss）。

## 实测：开/不开省多少（2026-11-11，本机真实数据）

> 结论先行：**默认策略（max→high，仅续步）在 deepseek-flash 上实测≈不省**。

- **会话内配对**（本机 4 个发生 max/high 切换的会话，续步对比）：输出 token 变化 −5% ~ +10%，
  方向混杂；当前会话 max 续步平均 1,017 tokens（n=117）vs high 续步 1,011 tokens（n=19），≈**−0.5%（噪声内）**。
- **跨会话自然实验**（同一路由 deepseek-account/deepseek-flash，n≈2,000/组）：
  max 续步平均输出 1,461 tokens、high 1,175 tokens（−20%），但**同会话配对显示无差异** →
  −20% 是"轻任务会话更常被设成 high"的选择偏差，不能当作 effort 的因果收益。
- **插件固定开销**：新增 `token_report` 工具 schema ≈ **125 tokens/请求**（≈¥0.0000025/请求，
  命中价；首次请求按未命中 ≈¥0.000125 一次性）。缓存未受影响（本会话 99.8% 命中）。
- **真正能省的配置**（用插件 `/token prices` 看当前费率为准）：
  - `continuationEffort: low`：历史同路由 low 续步平均输出 899 tokens（样本少、任务不同，仅参考）；
  - `continuationEffort: off`：续步平均输出 387 tokens（关闭思考，机制上必然大降；**复杂任务质量风险最高**）；
  - 这两档下"输出费用"可降 20%~70%，按本会话成本结构（输出约占 47%）折算总账单约 **−10%~−35%**，
    但都需要自己对任务质量做 A/B；插件只是把开关和证据摆出来。
- **无质量风险的钱**：本会话当前是空闲时段（5 折）；重活排到空闲时段直接 **−50%**；避免不必要的
  compaction（摘要 86% 未命中缓存）；保持前缀稳定（插件缓存哨兵负责告警）。

## 设计边界（与历史/官方机制的关系）

- **不改写历史**：任何缩写都在"结果进入上下文时"发生（append-only），因此不会让已缓存前缀失效；
  压缩后原文始终落盘，可通过 locator 用 `read` 取回。
- **官方机制优先**：≥12,500 estimated tokens 的超大结果交给官方 `spill-policy`；`read/write/edit/present`
  等豁免；检测到官方 notice 不再二次改写。
- **不主动 compaction**：历史改写类优化只做盈亏提示（break-even），由官方 `compaction-basic` 负责防溢出。
- **文字压缩只用实测有效的方式**：TSV 无损编码（同数据 −32%~−69% tokens）、结构感知步进采样、去重；
  文言文方向经真实 tokenizer 实测为负收益，不采用。

## 已知限制

- 统计从**插件加载时刻**开始；加载前的历史请求不在本会话总计里。
- 思考 token 与普通输出 token 在 DeepSeek Anthropic 接口上不可拆分，`outputTokens` 含思考。
- effort 变更会写入会话 `model/selection` 事件（用户可见）；`/token auto off` 可随时关闭。
- 峰谷按请求开始时刻判定；跨边界请求可能有一半价差误差。
- 价格与节假日表可能过时，以官方账单为准。

## 测试

```bash
npm test        # 21 项单测（node --test）
```

## License

MIT © 2026 yyy-yq1 — 见 [LICENSE](LICENSE)。
