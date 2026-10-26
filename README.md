# dsh-speed-meter

在输入框下方显示实时输出速度（tok/s）：生成中滚动更新，空闲时显示上一轮的平均速度。

| 项目 | 内容 |
| --- | --- |
| 包名 | `@apples1949/dsh-speed-meter` |
| 版本 | **不声明版本号**：跟随 `main` 分支，见 [更新与支持](#更新与支持) |
| 类型 | DSH **客户端**插件（Web）；Host 侧 `lib/index.js` 是空 `apply()`，只负责让 Loader 行能解析 |
| 挂载点 | slot `conversation.composer.dock`，`id: speed-meter`，`order: 10` |
| 数据来源 | chat 快照 `legacy.partial` / `legacy.nodes` + `sessionStats` 投影 |
| 定时器 | **没有**（无 `setInterval` / `rAF`）——显示刷新完全由流式增量驱动 |
| 分发 | 只从本仓库装（没有发布到 npm）；也可通过自建格式 1 索引源在「插件 → 发现」里看到 |

## 它显示什么

- 生成中：`● 45.3 tok/s` —— 圆点是品牌色并做 1.15s 脉冲动画
- 空闲：`上轮均值 38.2 tok/s`，拿不到本轮数据时退化成 `会话均值 41.0 tok/s`
- 什么都拿不到：组件返回 `null`，整块不渲染（不留空壳）

数值 ≥ 100 取整，否则保留一位小数；`font-variant-numeric: tabular-nums`，所以数字变化时不会左右抖。

## 它是怎么算的

流里只有文本，没有 token，所以速率是**估算**的：加权字符数 → 用真实 `usage.outputTokens` 自校准。

```
用 chat 快照的两个选择器 + 一个投影
  useChat(s => s.legacy.partial)   正在流的 {turn, step, blocks}
  useChat(s => s.legacy.nodes)     已结算的节点（带 usage / timing）
  useProjection("sessionStats")    整个会话的 decodeTokens / decodeMs

useEffect([partial])
  ① consumeBlocks：按块下标记住上次长度，只对**变长的后缀**计权
       text / reasoning → CJK 0.6 tok/字，其它 0.25 tok/字符（≈4 字符/token）
       tool-call        → (name + argsRaw) 长度 / 4
       内容被重写（长度回退且总量变小）→ 整个 tracker 重置
  ② samples.push({t, d})，裁掉 1.5s 之前的样本
  ③ stepRate   = 累计 / max(自首 token 起, 250ms)          ← 锚在首 token，不含首包延迟
     windowRate = 窗内和 / max(窗跨度 + 一个平均间隔, 250ms) ← 补平均间隔，防 burst 高估一倍
  ④ blended = 0.7 * windowRate + 0.3 * stepRate
     eased   = 上一帧 + (blended - 上一帧) * 0.18            ← EMA
  ⑤ 显示值 = round(eased * calibration.scale, 1)，值没变就不 setState（不触发重渲染）
```

| 常量 | 值 | 作用 |
| --- | --- | --- |
| `WINDOW_MS` | 1500 | 滑动窗口长度 |
| `MIN_SPAN_MS` | 250 | 分母下限，避免首个 delta 算出天文数字 |
| `DECAY_MS` | 2600 | 窗口空了多久之后认为本轮停止 |
| `EASE` | 0.18 | EMA 平滑系数 |
| `MIN_DECODE_MS` | 600 | 结算时 span 短于此视为 burst，不给数据 |
| `MAX_PLAUSIBLE_RATE` | 400 | 结算速率上限，超过视为异常丢弃 |

**校准**：`scale = usage.outputTokens / Σ加权字符数`，用最近一个已结算的 assistant 节点自学，让实时读数和空闲均值同口径。

**空闲时的取值优先级**：本组件实测的本步速率 → 本轮所有 step 的 `outputTokens / Σ(completedTime - firstTokenTime)` → `sessionStats` 的会话均值。

## 安装

本包**没有** `cordis.patch.yml`，所以不进 `dsh.profile.bundles`。它靠插件市场（`dshmarket`）的 *client-only shim* 挂载：

1. profile 的 `package.json` 里加依赖（本地路径用 `link:` / `file:`；本包**没有发布到 npm**，也可以直接 `pnpm add github:apples1949/dsh-speed-meter`）：

```jsonc
{
  "dependencies": {
    "@apples1949/dsh-speed-meter": "link:../../plugins/dsh-speed-meter"
  }
}
```

2. 在 profile 目录下 `pnpm install`。
3. 保持 `dshmarket` 启用。它启动时会为本包写一条热挂载行（`<profile>/.dsh-market/hot-1.yml`）：

```yaml
- id: 'mkt-client--apples1949-dsh-speed-meter'
  name: 'file:///C:/Users/<you>/.dsh/plugins/dsh-speed-meter/lib/index.js'
```

日志里对应 `hot-mount: @apples1949/dsh-speed-meter: live (client-only shim)`。

也可以直接从仓库装（不需要手写上面那行，市场会重新生成）：

```sh
dsh plugin --profile <profile> add github:apples1949/dsh-speed-meter
```

**生效**：它是客户端插件，刷新页面即可；改 `lib/client.js` 不需要重启宿主进程。

### 客户端 bundle 的两条硬约束

- `package.json` 必须有 `"dsh": { "client": { "platform": "web" } }`，且 `exports["./client"]` 指向 bundle 文件；
- bundle 里 `window.__ModuleLoader__.load({ id })` 的 **id 必须等于包名**，否则页面报 `loaded without registering "<id>"`。

## 配置

无。行为常量都写死在 `lib/client.js` 顶部（`WINDOW_MS` / `EASE` / …），要改就改源码。

## 已知边界

- 依赖 `legacy.partial` / `legacy.nodes` / `sessionStats` 这些**内部快照字段**。DSH 若改投影结构，组件会安静地不渲染，不会报错。
- `turnSpeed` 需要节点的 `timing.firstTokenTime`，它由**本页**收到的实时 chunk 派生。刷新页面后历史 step 通常没有这个字段，于是退化成"会话均值"。
- 结算是"宁可不说也不说错"：span < 600ms 或速率 > 400 tok/s 一律丢弃——一次性整段返回的响应本来就没有可观测的解码跨度。
- `calibration` 是**模块级单例**，跨轮、跨会话共享；会话切换后的头几个数字可能带着上一个会话的系数。
- 组件状态不绑 `sessionId`；切会话时可能短暂显示上一会话的读数（`spanRef` 只按 `turn/step` 配对）。
- 文案（"上轮均值" / "会话均值" / tooltip）硬编码中文，没走客户端 locale。
- 注入的 `<style>` 在 `apply()` 里直接 append，没有包 `ctx.effect` 返回清理函数——插件热卸载后会留到页面刷新（有 `querySelector` 幂等保护，不会重复堆积）。

## 更新与支持

- **不声明版本号。** `package.json` 里的 `version` 只是包管理器的技术要求，不是发版节奏，也不构成兼容性承诺；这个仓库没有 `releases`、没有更新日志承诺。
- **仅按维护者自己的需求更新**，不保证会继续更新，也不保证跟进新版 DSH。能用就用，别把它当有 SLA 的依赖。
- 想要稳定就钉提交：`github:apples1949/dsh-speed-meter#<sha>`。
- 通过自建索引源安装时，条目钉在某个 commit 上——只有索引被手动刷新时才会变。

## 许可证

MIT
