## 第八章：多渠道适配与消息路由 (Multi-Channel Adaptation & Message Routing) 📡

> 对应第一章 **1.3.4 📡 多渠道适配与消息路由**（22 个脏活场景）
> 核心代码：`src/channels/dock.ts`, `src/channels/mention-gating.ts`, `src/channels/command-gating.ts`, `src/channels/conversation-label.ts`, `src/channels/draft-stream-loop.ts`, `src/channels/deliver.ts`
> 索引回跳：如果你想先看全景脏活编号，请先回到 [第一章](./openclaw_tutorial_chapter_1.md) 的 **1.3.4**；这一章会把接入漏斗、路由锚点和安全送达拆成完整链路。

---

### 8.1 开场：一场由“在吗”引发的平行宇宙惨案 🔥

为了方便团队使用，你花费了一个周末，把你的 Agent 成功接入了 Discord、Telegram、WhatsApp 和 Slack。一切看来岁月静好。

直到周一早上，某位心急的主管在 WhatsApp 群里因为发消息习惯，按下了三次发送键：

> “在吗”
> “帮我”
> “写一段跑马灯代码”

他以为这是连贯的一句话。但由于 WhatsApp 是按条推给 Webhook 的，你的 Agent 瞬间把这三句话当成了三个独立的用户指令。
结果？Agent 瞬间分裂成了三个平行宇宙的意识体，在群里同时疯狂作答：
第一条回复：“在的！有什么我可以帮您？”
第二条回复：“需要我帮什么忙？请详细说明。”
第三条回复：“这是一段 React 跑马灯代码……”
群里几十个人看着这个原地精神分裂的机器人，陷入了死寂。

这还没完。在 Discord 那边，因为 Agent 回复的跑马灯代码加上废话超过了平台死板的 2000 字符限制，消息被 Discord 服务器硬生生从腰部一刀截断——代码块彻底残缺，三个反引号没能闭合，排版全毁。
而在 Telegram 那边，由于你图省事用了大模型的流式输出回调（每吐一个字就调一次 Edit Message API），用户的手机在 10 秒内爆发了疯狂的 30 次通知震动，随后你的机器人被 Telegram 官方 API 以前所未有的 `429 Too Many Requests` 给直接封号封停了 24 小时。

### 8.2 天真方案：大多数人会怎么做 🤡

“这能有多难？”你打开编辑器，“针对不同渠道写几个 `if-else`，太长了就截取一千字，群发限制就 `sleep` 一下嘛。”

```javascript
if (channel === "discord" && msg.length > 2000) {
  msg = msg.substring(0, 1999);
}
```

这种充满“学生作业感”的破烂网关，在你下一次把 Agent 接入钉钉或飞书的那个晚上，会立刻化为由 15 个甚至 20 个嵌套 `if-else` 构成的屎山代码，任何新人都无法维护。

### 8.3 结构真相：为什么你接不住人类的杂乱输入

在对抗全球各地的通讯聚合网关时，有三个极其痛的常客：

1. **碎嘴子发射器**：人类根本不喜欢一次性把话说完；而当你收到 Webhook 时，如果立刻去调大模型，你不仅浪费昂贵的 Token，还丧失了完整的上下文。
2. **群聊的 Mention 错乱**：在含有 100 人的群里，由于不同软件对 `@` 的实体解析不同，如果你的判定逻辑哪怕松了一公分，Agent 就会变成一个疯狂插话、每句话必答的智障。
3. **格式严格斩首**：在 2000 或 4096 的字符边界物理切割字符串，100% 会拦腰切断 Markdown 加粗、代码块围栏甚至 URL 链接，导致渲染器彻底崩溃。

### 8.4 手术室：OpenClaw 的消息大坝 🔬

如何驯服世界上最可怕的东西——人类的输入接口？为了把脏水变成纯净水，OpenClaw 设计了高度严密的漏斗防御阀。

#### 8.4.1 Mention 门控与群聊失忆防线 (脏活 142/158)

你要解决的第一个问题是：“这消息到底是冲我（Agent）来的，还是群友在互相扯皮？”
群聊环境极其险恶，OpenClaw 建立了一套严苛的降级与推断法则：

```typescript
// src/channels/mention-gating.ts 核心机制
function shouldTargetAgent(msg: Message, env: Env) {
  // 1. 私聊是上帝视角，全盘接纳
  if (msg.isDirectMessage) return true;

  // 2. 群聊中，只有明确的 @，且 @ 的是我，才放行
  // 坚决抛弃正则匹配，只认平台底层的 mention 实体树
  if (msg.mentions.includes(env.AGENT_ID)) return true;

  // 3. 极其重要的下文衔接：如果群用户直接“引用(Reply)了 Agent 的上一句话
  if (msg.replyTo === env.AGENT_ID) return true;

  return false; // 否则静默！就像石头一样，忽视掉周遭的旁观聊天！
}
```

**机制点评**：如果不卡死这条边界，大模型会在 20 人的工作群里一天烧掉你一万块钱的 API 账单。

#### 8.4.2 漏斗防抖与幂等去盾 (脏活 18/20/45)

在防线的第一站：怎样把那个因为人类碎嘴子而导致的三句断头话重新熔炼成一条明确的指令？

```typescript
// src/channels/draft-stream-loop.ts 漏斗骨架
const messageBuffer = new Map();
const seenMessageIds = new Set(); // LRU 缓存

function handleIncoming(incomingMessage) {
  // 1. 发送端幂等去重：防御 Telegram 服务器超时后重发的老毛病
  if (seenMessageIds.has(incomingMessage.id)) return;
  seenMessageIds.add(incomingMessage.id);

  // 2. 时间窗聚合（Debouncing）
  const userId = incomingMessage.authorId;
  let entry = messageBuffer.get(userId);

  if (!entry) {
    // 设置 5 秒级别的“冰冻期”
    entry = {
      text: "",
      timer: setTimeout(() => flushToLLM(userId), 5000),
    };
    messageBuffer.set(userId, entry);
  }

  // 只要 5 秒内用户又发了消息，不仅拼接到一起，并且重置倒计时！
  entry.text += incomingMessage.text + "\n";
  refreshTimer(entry.timer);
}
```

**机制点评**：真实世界的人类不会一次性写完指令。这个时间窗大坝把三滴“在吗/帮我/写代码”的雨水完美聚合成了一个能发送给大模型的水杯，避免了疯狂发卡的平行宇宙。

#### 8.4.3 双层幂等账本：内存先挡，磁盘留痕，跨进程也不重放

上面的 `Set/LRU` 只够防最表层的重复投递，但它扛不住更真实的战场：

- 同一条消息在进程重启后又被 webhook 平台重发；
- 同一机器上有两个 worker 或两个窗口同时在处理同一渠道；
- 某个进程加锁后崩溃，留下一个没人清理的僵尸锁文件；
- 同一个消息 ID 在极短时间内被并发打到同一个去重器，两个协程都以为“自己是第一个”。

OpenClaw 在这里不是只做一个 TTL cache，而是做了一个**双层幂等账本**：先用内存层高速挡掉热重复，再用磁盘层跨进程留痕，最后用文件锁保证“检查并记账”是原子的。

```typescript
// src/plugin-sdk/persistent-dedupe.ts + file-lock.ts 核心脱敏
const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
const inflight = new Map<string, Promise<boolean>>();

async function checkAndRecord(key, namespace = "global") {
  const scopedKey = `${namespace}:${key.trim()}`;

  // 第一层：同进程热路径短路
  if (memory.check(scopedKey, Date.now())) {
    return false;
  }

  // 第二层：同一个 scopedKey 的并发调用直接折叠
  if (inflight.has(scopedKey)) {
    return false;
  }

  const work = withFileLock(resolveFilePath(namespace), lockOptions, async () => {
    const data = sanitize(readJsonFileWithFallback(path, {}));
    if (isRecent(data[key])) {
      return true;
    }

    data[key] = Date.now();
    pruneData(data, ttlMs, fileMaxEntries);
    await writeJsonFileAtomically(path, data);
    return false;
  });

  inflight.set(scopedKey, work);
  try {
    return !(await work);
  } finally {
    inflight.delete(scopedKey);
  }
}

async function acquireFileLock(filePath, options) {
  const lockPath = `${normalize(filePath)}.lock`;

  // 如果锁文件存在，先检查是不是死进程或过期锁
  if (await isStaleLock(lockPath, options.stale)) {
    await rm(lockPath, { force: true });
  }

  // 指数退避 + 抖动，避免所有进程一起撞锁
  return open(lockPath, "wx");
}
```

这套设计有几个很细的优点：

1. **内存层负责便宜地挡住热重复**。对于刚刚收到又被平台马上重发的消息，连磁盘都不用碰。
2. **`inflight` 负责折叠同 key 并发**。这不是缓存，而是“同一发子弹只允许一个协程去做磁盘判决”，避免两个并发请求同时穿透到锁层外侧。
3. **磁盘层负责跨重启与跨进程记忆**。哪怕服务重启了，或者另一进程接手了流量，也知道这个消息 ID 近期是否已经处理过。
4. **锁文件不是傻等**。它会读取锁里的 `pid` 和 `createdAt`，配合 `isPidAlive()` 判断持锁进程是不是已经死掉；若死掉或过期，就主动清除僵尸锁，而不是永远卡死在“有人占着锁”的假象里。
5. **锁竞争带随机抖动的指数退避**。这防的是群体重试时的惊群效应，不让多个 worker 在同一个时间点一起猛撞 `.lock` 文件。

它体现的不是“我也有幂等”这种口号，而是一种更成熟的工程判断：**幂等不是一个布尔判断，而是一条从内存、并发、磁盘到进程死亡恢复的完整责任链。**

#### 8.4.4 Markdown 感知的分块之神 (脏活 112/139)

对于 Agent 吐出的万字长文，面对 Discord (2000字符) 或 Telegram (4096字符) 的硬性斩首限制，怎么优雅地切成几条发出去而不会破坏语法树？

````typescript
// src/channels/deliver.ts 核心脱敏
function splitMessageIntelligently(text: string, maxLength: number) {
  if (text.length <= maxLength) return [text];

  // 严格不会粗暴 slice(0, maxLength)
  // 算法：优先在“双换行符(段落)”边界寻找切割点！
  let splitPoint = text.lastIndexOf("\n\n", maxLength);

  // 如果实在没有段落，就找单换行，绝不能切碎一个 URL 或者一个单词！
  if (splitPoint === -1) splitPoint = text.lastIndexOf("\n", maxLength);

  let chunk = text.slice(0, splitPoint);

  // 最极致的脏活：判断被切落的这段里，是否存在 ` ``` ` 被打开但没闭合
  if (hasOpenCodeFence(chunk)) {
    chunk += "\n```"; // 强行为本段补上围栏，防止黑盘崩溃
    // 递归下一段时，还要为下一段的开头强行重新加上 ``` !!
  }

  return [chunk, ...splitMessageIntelligently(text.slice(splitPoint), maxLength)];
}
````

**机制点评**：这个叫“感知式分块”的函数，拯救了数百万行因为被暴力截断而在手机端变成纯文本黑块的代码阅读体验。

#### 8.4.5 API 封禁防御：投递节流池 (Throttle) (脏活 128)

如何把大模型 20token/s 的极速流式快感，翻译给限制 1次/秒 的传统聊天软件而不被封号？

```typescript
// src/channels/throttle.ts 骨架
class ThrottledSender {
  private pendingText = "";

  async onLLMToken(token) {
    this.pendingText += token;

    // 动态节流策略：距离上次发信超过 1.5 秒，或者刚好遇到一个合理的换行停顿点
    if (Date.now() - this.lastSendTime > 1500 || token.includes("\n")) {
      await this.editPlatformMessage(this.pendingText);
      this.lastSendTime = Date.now();
    }
  }
}
```

#### 8.4.6 正在飞行的这一轮回复，不能被别的频道偷走

多渠道系统里有一个很隐蔽的竞态，表面上看不像 bug，实际上风险很高：

- 你的 bot 把多个 DM 都收进同一个共享 session，比如 `dmScope = "main"`；
- WhatsApp 用户 A 发来一条消息，触发了一次 agent turn；
- 这轮回复还在推理时，Slack 用户 B 又发来一条消息，把 session 里的 `lastChannel/lastTo` 改成了 Slack；
- 等这轮 agent turn 终于要回复时，如果系统只是“读当前 session 的最后出口”，它就会把本该回给 WhatsApp A 的内容发给 Slack B。

这类 bug 最恶心的地方在于：**数据没有丢、逻辑没有崩、监控也未必报错，但回复会悄悄串频道。**

OpenClaw 在这里的匠心，不是继续给 `lastChannel` 打补丁，而是引入一套 **turn-scoped delivery context**。也就是：session 可以共享，但正在飞行中的这一轮回复，必须记住自己究竟从哪个入口起飞。

```typescript
// src/infra/outbound/targets.ts
export function resolveSessionDeliveryTarget(params) {
  const hasTurnSourceChannel = params.turnSourceChannel != null;

  // 一旦提供 turnSource，就完全切走 session 上那套可变尾指针
  const lastChannel = hasTurnSourceChannel ? params.turnSourceChannel : context?.channel;
  const lastTo = hasTurnSourceChannel ? params.turnSourceTo : context?.to;
  const lastAccountId = hasTurnSourceChannel ? params.turnSourceAccountId : context?.accountId;
  const lastThreadId = hasTurnSourceChannel ? params.turnSourceThreadId : context?.threadId;

  // Falling back to mutable session fields would re-introduce routing races.
}

// src/infra/outbound/agent-delivery.ts
const baseDelivery = resolveSessionDeliveryTarget({
  entry: params.sessionEntry,
  requestedChannel,
  explicitTo,
  turnSourceChannel,
  turnSourceTo,
  turnSourceAccountId,
  turnSourceThreadId,
});
```

这套设计有四个很漂亮的点。

第一，它承认 **session 级“最后出口”是可变状态，不适合给正在执行中的 turn 当真相来源**。源码注释写得非常直接：如果已经拿到了 `turnSourceChannel`，就不要再回退到 session 上那套 mutable 字段，否则跨渠道 reply race 会被重新引入。

第二，它不是只保存 `channel`，而是把 `to`、`accountId`、`threadId` 一起作为 turn-scoped 元数据打包传递。这样同一个 agent turn 即使跨过审批、转发、内部 deliver 甚至重试链路，仍然能知道自己应该回到哪个账号、哪个线程、哪个收件人。

第三，它的防守边界很硬。测试里专门覆盖了最脏的场景：session 的 `lastChannel` 已经被并发消息改成 Slack，但当前 turn 只要带着 `turnSourceChannel: "whatsapp"` 和 `turnSourceTo` 进入，最终 reply 仍然必须回到 WhatsApp；反过来，如果只给了 `turnSourceChannel` 却没有 `turnSourceTo`，系统也不会偷偷回退去复用 session 上那份已经可能过期的 `lastTo`。**宁可不给你发，也不允许悄悄发错人。**

第四，这种 turn-scoped 设计不是只给普通聊天回复用。`exec-approval-forwarder.ts` 这种审批转发路径同样会携带 `turnSourceChannel / turnSourceTo / turnSourceThreadId`，说明作者已经把它视为一条贯穿控制面的路由纪律，而不是某个单点补丁。

从工程角度看，这是一种很成熟的判断：**共享 session 可以提高连续性，但回复出口绝不能依赖共享可变状态。** 历史可以共享，出口必须锚定到本轮 turn 的起飞坐标；否则多渠道系统越活跃，串路由就越隐蔽、越难排查。

如果把这一节和后面的两章连起来看，会发现 OpenClaw 在维护三种不同时间尺度的会话连续性：**第八章保的是“一轮回复期间别串出口”**，**第九章保的是“系统演化之后别丢身份”**，**第十章保的是“跨渠道与跨线程的会话边界本身要有统一协议”**。这三层叠在一起，才构成真正稳定的多渠道会话宇宙。

#### 8.4.10 一图速记：多渠道消息从进站到出站的决策树

```text
[平台原生消息]
   │
   ▼
 协议解包 / 标准化
   │
   ▼
 Mention / command gating
   │
   ├── 未命中? ──▶ [静默丢弃]
   │
   ▼
 Debounce 时间窗合并
   │
   ▼
 双层幂等去重
   │
   ├── 重复消息? ──▶ [拒绝二次处理]
   │
   ▼
 会话绑定 / turn source 记录
   │
   ▼
 进入核心循环
   │
   ▼
 回复分块 / 节流 / 平台适配
   │
   ▼
 turn-scoped delivery anchoring
   │
   ▼
 [回到正确频道 / 正确线程 / 正确账号]
```

### 8.5 架构模式提炼 📐

把这一章压缩成方法论，可以得到五个多渠道投递模式：

- **漏斗防抖模式 (Funnel Debouncing)**: 用带过期重置机制的时间窗（Time Window），把人类零碎多动的沟通习惯压缩进一个符合大机器吞吐成本的标准上下文中。
- **双层幂等账本 (Two-Tier Idempotency Ledger)**: 用内存层拦截热重复、用磁盘层跨进程留痕、用锁文件把“检查并写入”做成原子操作，并为崩溃后的僵尸锁提供自清理能力。
- **边界感知截断 (Syntax-Aware Chunking)**: 切割长文本时绝不按物理字符粗暴下刀，必须深入语法树（即使只是轻量的 Markdown 符号匹配），保全代码栅栏与排印闭包。
- **节流编辑阀 (Throttled Edit Valve)**: 在追求极速体验（流式输出）与传统通信载体的反作弊防火墙（API Rate Limit）间建立妥协冰冻期。
- **回合锚定路由 (Turn-Scoped Delivery Anchoring)**: session 可以共享，但每一轮 reply 的出口必须绑定到本轮 turn 的来源 channel、recipient、account 与 thread，不能在发送时再回头读取共享 session 上已经被并发流量改写的“最后出口”。

| 模式         | OpenClaw 中的落点   | 通用等价物                     | 适用场景                 |
| ------------ | ------------------- | ------------------------------ | ------------------------ |
| 漏斗防抖     | inbound debouncer   | Burst Coalescing               | 碎片化 IM 输入           |
| 双层幂等账本 | 内存去重 + 磁盘留痕 | Hot cache + durable dedupe     | 重试风暴、跨进程重复投递 |
| 语法感知分块 | Markdown fence 保留 | Syntax-Aware Chunker           | 长回复、多平台消息上限   |
| 回合锚定路由 | turn source 元数据  | Request-scoped routing context | 多渠道并发回复           |

### 8.6 启示录

> 思考题：如果现在要接入一个“既支持群聊 thread，又会频繁重试 webhook”的新平台，你首先要复用哪几个现有模式，才能避免回复串线和重复执行？

**“多渠道适配真正困难的部分，从来不是把 API 连上。”**

真正困难的，是让消息在不同平台、不同节奏、不同失败模式下，仍然保持正确的收束、正确的幂等性，以及正确的回复出口。把这一层打稳之后，系统的下一个问题才会暴露出来：如果进程中断、主机重启、磁盘写入失败，已经建立起来的会话连续性还能不能活下来。

所以第九章要处理的，不再是“消息如何送达”，而是**状态如何在故障和演化中存活**。下一章进入：**原子操作与底层存储容灾**。
