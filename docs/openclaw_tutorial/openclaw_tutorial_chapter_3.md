## 第三章：LLM 提供商适配与多模型兼容层 (LLM Provider Adaptation Layer) 🤖

> 对应第一章 **1.3.2 🤖 LLM 提供商适配与多模型兼容**（33 个脏活场景）
> 核心模块：`@mariozechner/pi-ai`
> 索引回跳：如果你想先看全景编号和脏活分布，请先回到 [第一章](./openclaw_tutorial_chapter_1.md) 的 **1.3.2**；如果你是从第一章跳来的，这一章就是对应的手术室展开。

---

### 3.1 开场：一场静悄悄的崩溃 🔥

凌晨 2 点，你的 Agent 正在用 Claude 3.5 Sonnet 帮客户分析冗长的服务器财报。
突然，Anthropic 的服务器回了一个 **529 Overloaded**。
你心想：“没事，我写了重试和降级策略。”于是，系统按照代码设定，平滑地把模型切换成了备用的 **OpenAI GPT-4o** 准备继续这轮对话。

然而，下一秒，6 个群组的 Agent 同时宕机下线。
警报疯狂作响，日志里全是扎眼的 OpenAI 报错：`Error 400: Unexpected content type 'thinking'`。

原来，就在上一轮对话里，Claude 输出了用于深度思考的 `<thinking>` 内容块。这种私有协议格式毫无防备地被当作历史记录，端端正正地喂给了接盘的 GPT-4o。连着历史记忆的一点点“格式异味”，足以让跨模型接力的方案瞬间破产。

### 3.2 天真方案：大多数人会怎么做 🤡

当我们想要自己的应用“兼容多大模型”时，大多数人写出来的接入口往往是这样的：

```javascript
async function getLlmReply(messages, provider) {
  if (provider === "openai") {
    return openaiClient.chat(messages);
  } else if (provider === "anthropic") {
    return anthropicClient.chat(messages);
  }
}
```

“不就是换个 URL，套一套各自的 SDK，把同一串 `messages` 数组丢过去就完事了吗？”

### 3.3 死亡真相：为什么这种方案活不过第一天 💀

真实物理世界的 LLM 调用，远不是一个简单的 `POST` 请求。当你想真正在生产环境中做到模型热切和稳定流式输出，上述代码会踩中以下所有雷区：

1. **协议物种隔离**：Anthropic 强制要求如果有未解决的 `tool_call`（系统没能返回哪怕是执行失败的结果），发新消息时直接报错。如果你碰巧遇到网络阻断，留下了一个“孤儿调用”，接下来的这个会话就永远废了。
2. **怪异的隐形规则**：OpenAI 的新模型（o3/o4-mini）塞入思维链时的格式校验严苛到变态；而某些厂商如果不配置独特的 HTTP Headers，连工具名称都会被强行过滤报错。
3. **乱序的错误字典**：同样是上下文超载，OpenAI 返回 `"exceeds the context window"`，Google 返回 `"input token count exceeds the maximum"`。如果你只依赖 HTTP `400` 错误码去判断是否该触发记忆压缩（Compaction），你甚至抓不住那滑不溜手、直接返回空体的 Cerebras。
4. **底层 JSON 炸弹**：用户的微信消息不知怎么带了一个未闭合的 Unicode 孤儿代理对（例如一半的残缺 Emoji）。直接 `JSON.stringify` 后扔给大模型，你的进程当场挂掉。

#### 3.4 手术室：OpenClaw 的究极缝合怪 🔬

为了抹平全球 14 家顶级 AI 提供商之间巨大的代沟，OpenClaw 剥离出了一个极其重磅的子库 `@mariozechner/pi-ai`。
如果说前面的方案是天真的“换皮 API”，那下面这 6 个模块就是在这个充满谎言、断流和格式变异的黑暗森林里，活活逼出来的“生存套装”。

##### 3.4.1 胶水网关：流式事件拼接 (Streaming JSON Buffer)

当你真正在线上部署大模型时，最大的痛点在于：**在流式吐字（Streaming）期间，JSON 结构是被暴力切碎的**。
你眼睁睁看着模型吐出 `{"tool_calls": [{"function": {"name": "rea`。此时网络卡了一下，或者前端 React 原本指望着用完整的状态树进行无缝重绘，结果拿到这个连引号都没闭合的残片，整个前端立马 `JSON.parse Error` 红屏崩溃。

OpenClaw 并不傻等，它直接在底层网桥挂了一个带 `try-catch` 补偿机制的“胶水池”：

```javascript
// pi-ai/json-parse.js 核心脱敏骨架
let jsonBuffer = "";
let accumulatedResult = null;

for await (const chunk of llmStream) {
  jsonBuffer += chunk.text;

  try {
    // 尝试暴力解析这个碎片
    accumulatedResult = JSON.parse(jsonBuffer);
  } catch (err) {
    // 缝合算法：JSON 不完整时，我们动态为其补齐尾巴（如冒号、闭合大括号）
    const repairedJson = attemptRepairJSON(jsonBuffer);
    if (repairedJson) {
       accumulatedResult = repairedJson;
    } else {
       continue; // 烂得无法修补，维持上一帧合法状态
    }
  }

  yield accumulatedResult; // 永远向外抛出完整的中间态
}
```

**这一招，保证了即使物理断网，主系统记录的状态也绝不会是非法结构体。**

##### 3.4.2 记忆洗脑术：Thinking 块的无损手术

回到开头的那个崩溃场景。当系统需要**跨越不同的模型供应商重放历史**时，你不能指望 GPT-4o 会温文尔雅地接受 Claude 带有内部推理（`type: thinking`）的“异端格式”。

直接删掉思考过程？大模型的对话逻辑会当场断裂（模型会觉得“我怎么毫无缘由得出这个结论的？”）。
OpenClaw 在 `transform-messages.js` 中做了极其暴力的隐形清洗——**强行把它拍平成一个纯文本的历史遗言**：

```javascript
// 跨模型清洗算法核心片段
function sanitizeMessagesForOpenAI(messages) {
  return messages.map((msg) => {
    // 发现异端格式：Claude 的内部思考区块
    if (msg.type === "thinking") {
      return {
        // 抹除敏感身份签发特征，转换为普通人或系统发言
        role: "user",
        content: `[System Note: Previous Thought Process]\n${msg.content}`,
      };
    }
    return msg;
  });
}
```

这段映射（Map），让历史记忆既不丢失逻辑推演，又能骗过新模型严苛的 Schema 校验。

##### 3.4.3 假骨灰盒：孤儿 ToolCall 填补

这是新手死得最惨的地方：**状态机时序断层**。
OpenAI 规定：如果你上一轮抛给用户的消息是一个 `tool_call`（让系统查天气），下一轮回传给 OpenAI 的消息树**必须！必须！必须！**带着那个函数的 `toolResult`。如果在这期间进程重启了，或者用户手欠直接发了句“别查了”，这个悬在半空的 `tool_call` 就成了孤儿，导致接下来的一切都会直接报 `HTTP 400 Bad Request` 卡死。

OpenClaw 怎么填这个雷？造假！

```javascript
// Session-state 扫描拦截器
const lastMsg = history[history.length - 1];

// 扫描发现尾部存在未闭合的悬空工具调用
if (lastMsg.toolCalls && !lastMsg.toolCalls.every((tc) => hasResult(tc.id))) {
  // 强行插入一个伪造的结果节点填补时空虚空
  history.push({
    role: "tool",
    tool_call_id: lastMsg.toolCalls[0].id,
    content: "System Interrupted. No result provided.",
    isError: true, // 大声声明这是个意外终止，让模型放下执念
  });
}
```

通过前置清洗拦截，彻底终结了“重启后对话永远卡在 Bad Request”的离奇怪圈。

##### 3.4.4 隐形与妥协：Anthropic 潜入路线

在发给 Anthropic 家族时，你不仅面临官方对工具命名格式极其偏执的要求，还要面临新出的“深层思考额度（Budget）”分配问题。

```javascript
// Request Builder 的核心拨算逻辑
const requestPayload = { ... };

// 如果使用的是带大脑核的新模型 (如 3.7)
if (modelName.includes('claude-3-7-sonnet')) {
  requestPayload.thinking = {
    type: "enabled",
    // 强制从总 Token 里切出至少 1024 留给它的内部思考区
    // 如果不强行切除，过高会撑爆 API，没有则直接报 400 格式错
    budget_tokens: Math.min(Math.max(1024, maxTokens * 0.3), 16000)
  };
}

// 隐形潜入：为了防止被降级排队，幽灵般地伪装成第一方 CLI 身份
fetchOptions.headers['User-Agent'] = 'claude-cli/2.1.2';
```

这就是你在通用官方文档上永远学不到的脏活：用魔法打败风控，用公式平衡预算。

##### 3.4.5 Google 死亡矿井：穷举断言

Google 的 Gemini 简直是个地雷阵。它的 `FinishReason`（返回结束原因）有极其吓人的 14 种状态（包括 `PROHIBITED_CONTENT` 甚至莫名其妙的 `IMAGE_RECITATION`）。如果你的系统里只简单写了 `default: throw Error`，一旦明天 Google 随心情加入第 15 种死法，你的应用就成了午夜的黑盒盲锁。

在 `google-shared.js` 中，OpenClaw 动用了 TypeScript 中极其暴力的**穷举断言模式 (Exhaustive Assertion)**：

```typescript
switch (reason) {
  case "STOP":
    return handleStop();
  case "PROHIBITED_CONTENT":
    return triggerSafetyLock();
  // ... 其他 12 种原因 ...
  default:
    // 如果开发者遗漏了枚举，或者升级时遇到没见过的状态
    // 这里会引发代码编译期(tsc)报错，直接无法打包部署！！
    const _exhaustive: never = reason;
    throw new Error(`Unknown Google FinishReason: ${_exhaustive}`);
}
```

这就是顶级工程库的底气：“宁可编译失败不给你跑，也绝不在线上漏跑一个空指针”。

##### 3.4.6 OpenAI 泥腿子暗语：# Juice: 0

由于 OpenAI 高智商大基座（如 o系列）绑定了耗时长久的深度网络树，而且官方抠门到没给关闭推理的布尔值开关。这导致有时候就算只问一句“当前路径在哪”，它也可能在后台干烧 5 秒显卡。
如何强拉闸？使用在开发者酒馆里扒出来的非官方暗黑口令：

```javascript
// Final Payload Patcher
if (model.includes("o3") || model.includes("o4")) {
  // 不讲道理地在内核提示词最后面插入截断咒语
  systemMessage.content += "\n\n# Juice: 0 !important\n";
}
```

##### 3.4.7 爆仓漏斗：15 股正则合围网

当大模型被超长的代码文件撑爆上下文长度限制时，世界上每一家的 API 报出的错都不一样。有的是优雅的 `400`，有的是粗暴的 `413 Payload Too Large`，有的根本是一个带着 C++ `string too long` 断言的残破烂摊子。

`overflow.js` 里干脆放弃了对 HTTP CODE 的幻想，拉起了一张 15 片的正则大网：

```javascript
// 跨服搜捕器
const OVERFLOW_ERRORS = [
  /prompt is too long/i,
  /exceeds the max(?:imum)? (?:context )?length/i, // OpenAI系
  /^413\b/i, // API 网关硬生生的切断
  /string too long/i,
  /input token count exceeds/i, // Google 粗语
];

function isContextOverflow(errorText) {
  return OVERFLOW_ERRORS.some((regex) => regex.test(errorText));
}
```

这成了后面第 4 章启动**“内核大幅的内存压缩（Compaction）”**最坚定不移的哨兵信号。

##### 3.4.8 鉴权档案轮换：不是一把 Key，而是一整个冷却熔断矩阵

大多数所谓“多模型兼容”系统，在鉴权层的理解还停留在 `.env` 里塞一把 `OPENAI_API_KEY`，失效了就报错，用户自己手动换。

这种方案在真实线上几乎没有生还率。因为你面对的不是“有没有 Key”这么简单，而是：

- 同一个 provider 下可能并存多份 OAuth / Token / API Key；
- 某一份凭证刚刚撞上了 `429 rate limit`，但另外两份还能继续跑；
- 某份凭证因为 billing、auth、model_not_found 等不同类型错误进入不可用窗口，恢复策略完全不同；
- 如果冷却结束后不清空惩罚计数，下一次短暂抖动又会立刻被打回冷宫。

OpenClaw 在这里做的不是“找一把能用的钥匙”，而是构建了一个**带轮换、冷却、排序和故障归因的凭证调度器**：

```typescript
// src/agents/auth-profiles/order.ts 核心机制
export function resolveAuthProfileOrder({ cfg, store, provider, preferredProfile }) {
  clearExpiredCooldowns(store, Date.now());

  // 优先遵从显式配置，但仍然把处于 cooldown 的凭证挪到后面
  // 对可用凭证再按类型与 lastUsed 做轮换排序
  const sorted = orderProfilesByMode(deduped, store);

  if (preferredProfile && sorted.includes(preferredProfile)) {
    return [preferredProfile, ...sorted.filter((e) => e !== preferredProfile)];
  }

  return sorted;
}
```

这个排序并不是随机的，而是有明确偏好的：**`oauth > token > api_key`**，然后在同类型内部按 `lastUsed` 最久未使用者优先，形成一种近似 round-robin 的轮换。这样做的结果是：

- 最稳定、最长期的授权形态优先上场；
- 不会把同一把 Key 永远压在第一位反复打爆；
- 用户显式点名的 profile 仍然拥有最高优先权。

更细的一层匠心藏在 `usage.ts`。OpenClaw 没有把所有失败都粗暴归成“不可用”，而是显式区分了 `auth_permanent`、`auth`、`billing`、`format`、`model_not_found`、`timeout`、`rate_limit`、`unknown` 这些原因，并做权重归因：

```typescript
// src/agents/auth-profiles/usage.ts 核心机制
export function resolveProfilesUnavailableReason({ store, profileIds, now }) {
  // 优先相信显式 disabledReason
  // 否则再根据 failureCounts 做加权统计
  // 最终返回当前这一批凭证整体最可能的不可用原因
}

export function clearExpiredCooldowns(store, now) {
  // cooldown 过期后，不只是把时间清掉
  // 还要一并重置 errorCount / failureCounts，避免下一次瞬时失败立刻被重罚
}
```

这一层非常容易被忽略，但它决定了系统到底是在“机械重试”，还是在做真正的**凭证熔断与半开恢复**。

最后，这整套凭证轮换并不是孤立地躺在 auth 模块里，而是被 `model-auth.ts` 接到了模型解析入口：系统会先尝试 profile 顺序，再尝试环境变量、再尝试 provider 的静态配置。也就是说，OpenClaw 的鉴权不是“单一路径读取”，而是**多来源、多优先级、可降级的身份装配线**。

### 3.5 架构模式提炼 📐

透视上面的源码骨架，我们在多模型架构上提炼出以下设计范式：

- **适配器流式整形 (Streaming Adapter Mutilation)**: 用累加 `Buffer` 和 `repairJSON` 算法，将残损的片段硬吃成一个稳定的迭代器循环。
- **消息异端隔离 (Cross-Model Context Normalization)**: 绝不信任外部注入状态，对 `Thinking` 和悬挂 `ToolCall` 执行降级+造假的无死角擦除补位。
- **防御性编译态阻遏 (Exhaustive Assertions)**: 对抗变幻莫测的大型第三方 API 枚举字典最稳妥的路标。
- **冷却驱动的凭证轮换 (Cooldown-Driven Credential Rotation)**: 把鉴权档案视为一个可调度池，而不是一把固定密钥。对短时故障做冷却，对永久故障做禁用，对恢复后的档案做计数清零与重新排队。

| 模式         | OpenClaw 中的落点                    | 通用等价物                       | 适用场景                  |
| ------------ | ------------------------------------ | -------------------------------- | ------------------------- |
| 流式整形     | `transform-messages`、流式 JSON 修补 | API Gateway 适配层               | 多家 LLM 流协议不一致     |
| 上下文归一化 | Thinking 降级、孤儿 ToolCall 补齐    | Compatibility Layer              | 跨模型切换、历史消息回放  |
| 穷举断言     | finish reason / provider 枚举检查    | Exhaustive switch + never guard  | 第三方 SDK 暗改字段       |
| 凭证调度池   | auth profiles 冷却轮换               | Circuit Breaker + Pool Scheduler | 多把 Key / OAuth 混合运行 |

### 3.6 启示录

> 思考题：如果明天要接入一家“会流式吐出半截 JSON、并且错误码语义完全不同”的新模型厂商，你会优先把逻辑放进哪一层，才能保证现有调用方几乎不用改？

**永远不要相信一行简单的 `await openai.chat()` 能在线上存活超过三天。**
当物理断网、孤儿回调、API提供商暗改协议、多模型切换等问题接踵而至，你今天所欠下的边缘状态处理（Edge Cases），明天全都会化为客户端滚动的 Red Error。

大模型的嘴巴已经封锁完毕，接下来，让我们翻到第四章——看看在面对超大型、数万字多轮对话时，**OpenClaw 的大脑海马体（核心循环与 JSONL 树结构）**，是如何保持记忆永不穿孔的。
