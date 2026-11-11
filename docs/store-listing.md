# 上架资料（可直接复制粘贴）

用于 DSH-Store / deepseek.stream 等插件市场上架时的字段填写。仓库：[yyy-yq1/dsh-plugin-token-governor](https://github.com/yyy-yq1/dsh-plugin-token-governor)

## 基础字段

| 字段 | 内容 |
|---|---|
| 插件名（中文） | Token 管家 |
| 插件名（英文） | Token Governor |
| 包名 | `dsh-plugin-token-governor` |
| 当前版本 | 0.20.2 |
| 分类 | 费用与账单 / 用量统计 / 工作流与自动化 |
| 标签 | DeepSeek、计费、缓存命中、省钱、token 优化、工具输出压缩、成本观测 |
| 许可证 | MIT |
| 仓库 | https://github.com/yyy-yq1/dsh-plugin-token-governor |
| 封面图 | `docs/social-preview.png`（1280×640） |
| 图标 | `icon.svg` |

## 一句话简介（≤60 字）

> 看板告诉你花了多少；Token 管家告诉你为什么这么贵、下一笔哪会白烧、怎么让同样任务更便宜。

## 短简介（≤200 字）

> 按 DeepSeek 官方计费口径核算真实成本：缓存命中/未命中/输出三线费用、峰谷价、每请求 ¥。缓存前缀哨兵在命中率骤降时告警并归因，effort 切换导致崩塌时自动回滚。工具输出走无损 TSV 重编码、结构压缩、近重复 stub 与读取复用，只在结果进入上下文时发生、绝不改写历史。/token new 交接新会话，实测 42 万上下文单请求成本 −94%。面板、命令、HTTP 全部零模型 token 开销。

## 功能列表（详情页用）

1. **真实计费核算** — 读 provider 真实 usage（含思考），按官方价目表算 ¥（CNY/USD、峰谷、镜像模型名）。
2. **缓存前缀哨兵** — 命中率骤降时给出多付 token/金额，归因到换 effort、压缩、工具变动、空闲过期、服务端驱逐；切换守卫自动回滚。
3. **无损工具输出优化** — 均匀 JSON→TSV（可逆，−32%~−59%）、结构感知压缩（−51%~−69%，全文落盘可回取）、近重复 stub（−99%）、同文件读取复用。
4. **换会话省钱** — `/token new` 生成交接单并开新会话；`/token handoff` 只出交接单。
5. **成本归因与决策** — 子会话成本、上下文增长归因、继续/压缩/新会话三选一每请求成本与回本轮数。
6. **持久账本** — 跨会话、跨重启累计总消耗/命中/未命中/输出/API 请求次数，分会话明细；`/token` 与设置页面板零 token 开销。

## 三条设计红线（详情页"为什么可信"）

1. **绝不改写历史**：压缩只发生在结果进入上下文时（append-only），已缓存前缀不动。
2. **绝不改工具 schema**：有活动会话时延迟注册自身工具，避免前缀整段失效。
3. **官方机制优先**：≥12,500 tokens 的超大结果让给官方 `spill-policy`，只处理它不管的那一档。

## 反直觉实测（差异化内容，详情页可引用）

- 文言文压缩 token **更贵**：同义现代中文 123 tok → 文言文 135 tok（+9.8%），电报体 117。
- effort 降档默认**不省**：同会话配对 max 续步 1,017 tok vs high 1,011 tok（−0.5%，噪声内），故默认关闭。
- 命中率天花板 **≈99%**：72 会话 9,839 请求中，未命中 59.9% 是每步新内容（不可避免），20% 服务端驱逐。

## 安装说明（详情页用）

```bash
# 官方 CLI，从 Git 安装
dsh plugin --profile web add 'git+https://github.com/yyy-yq1/dsh-plugin-token-governor.git'
```

或使用插件管理器：`plugin_manager action=install_bundle target="<clone 路径>/dsh-plugin-token-governor"`。

装完即用：`/token` 看本会话账单；设置 →「缓存与成本」看面板（不产生模型请求，没显示就刷新页面）。

## 权限与数据说明（审核用）

- 不发起网络请求、不读取提示词正文、不含生命周期脚本。
- 注册 Host HTTP 路由前缀 `/token-governor`（`apiEnabled: false` 可关闭）。
- 有活动会话时延迟注册 `token_report` 工具，避免改动工具声明导致缓存失效。
- 账本写入 `~/.dsh/token-governor/ledger.jsonl`（`ledgerPath` 可改）；压缩原文落盘 OS 临时目录，72h 后清理。
- 面板/命令/HTTP 均本地处理，不产生模型 token 消耗。

## 截图建议

| 位置 | 内容 |
|---|---|
| 封面 | `docs/social-preview.png` |
| 截图 1 | 设置 →「缓存与成本」面板（KPI + 总消耗 + 分会话明细） |
| 截图 2 | `/token` 命令输出（含"决策"行） |
| 截图 3 | 压缩前后对比（300 行 22,127B → 6,790B） |
