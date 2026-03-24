# OpenClaw 第二层地图：`runEmbeddedPiAgent` 外层调度与重试壳

这份地图专门回答一个问题：

`src/agents/pi-embedded-runner/run.ts` 里的 `runEmbeddedPiAgent`，到底负责什么，和 `runEmbeddedAttempt` 的边界在哪里。

如果说：

- `runEmbeddedAttempt` 是“一次具体执行”
- 那么 `runEmbeddedPiAgent` 就是“这次执行前后的总调度壳”

它不负责真正拼完整 system prompt，也不直接跑 tool loop。
它真正负责的是：

1. 把一次请求放进正确的 lane
2. 解析 workspace / model / auth profile
3. 决定是否允许当前模型继续跑
4. 调用 `runEmbeddedAttempt`
5. 根据结果决定是否重试、换 profile、降 thinking、做 compaction、截断 tool result
6. 最后把 attempt 结果整理成统一返回格式

---

## 一句话区分它和 `runEmbeddedAttempt`

你可以先记住这句：

```text
runEmbeddedPiAgent = 外层“跑不跑下一轮”的调度器
runEmbeddedAttempt = 内层“这一轮具体怎么跑”的执行体
```

所以阅读顺序应该是：

1. 先看 `runEmbeddedPiAgent` 如何决定“要不要再试一次”
2. 再看 `runEmbeddedAttempt` 如何完成“一次尝试”

---

## 它在系统里的位置

主关系可以先压成这样：

```text
调用方 / channel / daemon
  -> runEmbeddedPiAgent
       -> lane 排队
       -> workspace / model / auth profile 解析
       -> 外层 retry / failover / compaction 恢复
       -> runEmbeddedAttempt
            -> 单次 session 装配
            -> prompt / tools / provider stream
            -> 单次结果返回
       -> buildEmbeddedRunPayloads
       -> 统一 EmbeddedPiRunResult
```

所以这个函数最核心的价值不是“执行”，而是“裁决”。

---

## 依赖簇：`run.ts` 主要在调哪些模块

### 1. Lane 与排队

- `lanes.ts`
- `process/command-queue.ts`

作用：

- 给当前 session 算 session lane
- 给系统整体算 global lane
- 保证同 session 和全局资源不会乱抢

### 2. workspace 与运行上下文

- `workspace-run.ts`
- `agent-paths.ts`
- `models-config.ts`

作用：

- 解析这次运行真正要用的 workspace
- 处理 workspace fallback
- 保证 models 配置文件存在

### 3. 模型解析与上下文窗口护栏

- `model.ts`
- `context-window-guard.ts`
- `defaults.ts`

作用：

- 把 `provider/model` 解析成可运行的模型对象
- 在真正发请求前检查 context window 是否太小
- 过小就直接拦截，不让进入 attempt

### 4. 鉴权档位与 failover

- `model-auth.ts`
- `auth-profiles.ts`
- `failover-error.ts`

作用：

- 决定当前 provider 用哪个 auth profile
- 失败后是否切换 profile
- 是否升级成 `FailoverError` 交给更高层换模型

### 5. 单次尝试执行

- `run/attempt.ts`

作用：

- 真正执行一次 embedded agent 尝试
- 返回单轮结果、错误、usage、compaction 信息

### 6. 恢复与降级

- `compact.ts`
- `tool-result-truncation.ts`
- `pi-embedded-helpers.ts`

作用：

- 遇到 context overflow 时决定怎么救
- 先试 compaction，再试 tool result truncation
- 必要时降 thinking、换 profile、或者终止

### 7. 输出整理

- `run/payloads.ts`
- `usage.ts`

作用：

- 把单轮结果整理成最终 payload
- 计算 usage、prompt tokens、last call usage

---

## 主执行链：按 9 个阶段理解

### 阶段 0：lane 排队

关键点：

- `resolveSessionLane`
- `resolveGlobalLane`
- `enqueueSession`
- `enqueueGlobal`

它做什么：

- 先保证“同一会话内部”的请求排队
- 再保证“全局共享资源”层面也有统一排队

你应该理解成：

- 这不是性能优化细节
- 这是防止并发把 transcript、工具执行和 provider 请求打乱的第一道闸门

### 阶段 1：workspace 定位与 fallback

关键点：

- `resolveRunWorkspaceDir`
- `redactRunIdentifier`

它做什么：

- 决定这次 run 的实际 workspace
- 如果调用方给的路径不可靠，允许按规则 fallback
- 记录脱敏日志，避免把真实路径和 session 标识直接打出去

### 阶段 2：模型 override 与模型解析

关键点：

- `before_model_resolve`
- `before_agent_start`
- `resolveModel`

它做什么：

- 允许插件在正式选模型前覆盖 provider / model
- 再把最终值解析成模型对象

这里最容易误解的一点是：

- hook 改的是“选择哪条模型路径”
- 不是改已经创建好的 session

### 阶段 3：context window 护栏

关键点：

- `resolveContextWindowInfo`
- `evaluateContextWindowGuard`

它做什么：

- 在真正进入 attempt 之前先看模型窗口够不够大
- 太小就直接阻断

原因很简单：

- 如果明知窗口太小还继续跑，后面的 prompt 构建、tool 历史修复、图片加载都在浪费时间

### 阶段 4：auth profile 选择

关键点：

- `resolveAuthProfileOrder`
- `applyApiKeyInfo`
- `advanceAuthProfile`

它做什么：

- 生成当前 provider 可用的 profile 候选序列
- 处理用户锁定 profile 与自动轮换 profile 两种模式
- 把最终 API key 写进 runtime authStorage

这一段的本质是：

- `provider/model` 决定“往哪打”
- `auth profile` 决定“拿谁的凭证打”

### 阶段 5：外层重试循环

关键点：

- `MAX_RUN_LOOP_ITERATIONS`
- `attemptedThinking`
- `runLoopIterations`

它做什么：

- 限制整轮外层 retry 次数
- 记录已经试过哪些 thinking level
- 每次循环真正调用 `runEmbeddedAttempt`

你应该把这里理解成：

- 这是整个 embedded run 的总 retry 壳
- 不是单次 provider SDK retry

### 阶段 6：context overflow 恢复

关键点：

- `isLikelyContextOverflowError`
- `compactEmbeddedPiSessionDirect`
- `truncateOversizedToolResultsInSession`

它做什么：

- 先识别这次失败是不是 context overflow
- 如果是，优先试 compaction
- compaction 仍不够，再试裁大 tool result
- 还不行才最终报错

这是这个函数最重要的一条恢复路径。

因为 OpenClaw 不想把“上下文太大”直接等价成“用户这轮彻底失败”。

### 阶段 7：prompt/assistant 错误分流

关键点：

- `promptError`
- `pickFallbackThinkingLevel`
- `classifyFailoverReason`
- `FailoverError`

它做什么：

- 区分是 prompt 提交失败，还是 assistant 生成后报错
- 识别是否可以降 thinking 重试
- 识别是否应该切 profile
- 如果配置了模型 fallback，就把问题升级成 `FailoverError`

这里最关键的理解是：

- 不是所有错误都在当前函数里“自己解决”
- 一部分错误会被包装成 `FailoverError`，交给更高层换模型

### 阶段 8：结果整理与成功收尾

关键点：

- `toNormalizedUsage`
- `buildEmbeddedRunPayloads`
- `markAuthProfileGood`
- `markAuthProfileUsed`

它做什么：

- 整理 usage 和 prompt tokens
- 构建最终返回 payload
- 在成功情况下把当前 profile 标记为 good / used

这一步不是简单 return。

它其实是在把 attempt 的“内部运行细节”压缩成调用方看得懂的稳定结果。

### 阶段 9：finally 恢复 cwd

关键点：

- `process.chdir(prevCwd)`

它做什么：

- 不管中间换了多少目录，退出时都把进程 cwd 还原

这一行虽然简单，但属于运行壳必须做的卫生动作。

---

## 你最该重点理解的 5 个局部变量

### `fallbackConfigured`

含义：

- 当前 agent / session 是否配置了模型 fallback

影响：

- 决定某些错误是“直接结束”，还是“升级成 FailoverError 交给上层换模型”

### `lockedProfileId`

含义：

- 用户是否把 auth profile 锁死到某个具体账号

影响：

- 锁死后就不能自动轮换到别的 profile

### `attemptedThinking`

含义：

- 这一轮外层 run 已经试过哪些 thinking level

影响：

- 防止 unsupported thinking 错误导致无限来回重试

### `overflowCompactionAttempts`

含义：

- 这轮 run 因 context overflow 已经尝试过多少次 compaction 恢复

影响：

- 防止一直 compaction -> retry -> compaction 的死循环

### `lastRunPromptUsage`

含义：

- 记录“最近一次模型调用”的 prompt usage，而不是累加 usage

影响：

- 给 context window 展示一个更真实的当前上下文大小

---

## 它和 `runEmbeddedAttempt` 的真实分工

可以直接背这个对照：

### `runEmbeddedPiAgent` 负责

- lane
- workspace fallback
- 模型解析
- auth profile 选择
- 外层 retry
- thinking 降级
- profile 轮换
- overflow 恢复
- 返回 payload 整理

### `runEmbeddedAttempt` 负责

- sandbox/workspace 视图
- skills/bootstrap
- tools
- system prompt
- session transcript 打开与修复
- embedded agent session 创建
- prompt 真正发出
- 单次 compaction 等待与清理

---

## 你现在读这个函数时要重点问自己的问题

如果你真的读懂了 `runEmbeddedPiAgent`，应该能回答下面这些问题：

1. 为什么 lane 排队要分 `session lane` 和 `global lane` 两层？
2. 为什么 context window 过小要在 `runEmbeddedAttempt` 之前就拦住？
3. `auth profile` 轮换和 `model fallback` 是两层不同的恢复机制，区别是什么？
4. 为什么 context overflow 时先试 compaction，再试 tool result truncation？
5. 为什么 usage 既要累计，又要单独保留“最后一次调用”的 usage？

如果你答不出来，就说明你现在还只是“看过代码”，还没把它的外层控制逻辑真正装进脑子里。

---

## 推荐你接下来怎么连着读

顺序建议是：

1. `source_maps/openclaw_runEmbeddedPiAgent_map.md`
2. `src/agents/pi-embedded-runner/run.ts`
3. `source_maps/openclaw_attempt_call_map.md`
4. `src/agents/pi-embedded-runner/run/attempt.ts`

这样你会先建立：

- 外层怎么决定“再不再来一轮”
- 内层怎么完成“这一轮具体执行”

这个分层一旦清楚，OpenClaw 的 embedded runner 这条主线就不会再糊成一团。
