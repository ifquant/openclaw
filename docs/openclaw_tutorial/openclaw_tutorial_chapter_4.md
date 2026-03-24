## 第四章：Agent 核心循环与会话管理 (Agent Core Loop & Session Management) 🧠

> 对应第一章 **1.3.9 🧠 Agent 核心循环与子 Agent 编排**（8 个脏活场景）+ 存储/扩容相关场景
> 核心代码：`@mariozechner/pi-coding-agent`、`@mariozechner/pi-agent-core`
> 索引回跳：如果你想先看全景脏活地图，请先回到 [第一章](./openclaw_tutorial_chapter_1.md) 的 **1.3.9**；这一章负责把核心循环、会话树和上下文压缩拆开讲透。

---

### 4.1 开场：一场“失忆”引发的血案 🔥

你的 Agent 已经在线上稳定运行了 3 个月，由于某个超级重度用户每天都在让 Agent 帮他写代码，那个名为 `transcripts.jsonl` 的 Session 文件已经膨胀到了 50MB。

某天，用户发了一句简单的指令：“继续昨天的重构任务”。
Agent 沉默了足足 20 秒，试图把 50MB 的 JSON 整个反序列化并塞给大模型，结果遇到了严格的 `413 Payload Too Large` 或者 `Token limit exceeded`，直接崩溃下线。

你一看急了，为了让 Agent 活过来，你写了一段脚本：“如果数组长度大于 100，就把前面的 50 条消息 shift() 截断丢弃。”
Agent 终于活过来了。它爽快地回复了用户：“好的，请告诉我你在重构什么文件？”

用户看着屏幕，暴怒地掀翻了桌子——他花了 3 天时间给 Agent 喂养的代码边界条件和上下文，全被你这一刀截断物理清除了。

### 4.2 天真方案：大多数人会怎么做 🤡

“管理对话数据能有多难？不就是建一个 `const history = []`，用户发话就 `push`，大模型回答也 `push`，满了就删掉旧的，最后存到数据库里不就行了？”

如果你的产品只是一个“聊两句就关掉”的基础客服，这么做没问题。但对于需要在复杂代码库里进行数百轮交互、不断试错、走弯路甚至还要回滚操作的 Engineering Agent 来说，这种线性数组模型就是灾难的温床。

### 4.3 死亡真相：为什么线性数组会死得很惨 💀

1. **截断 = 永久性脑损伤**：强行丢弃数组前面的元素，意味着早期的重要约束（如“严格不要使用 React 类组件”）被彻底抹杀，模型会突然开始引入违禁库。
2. **没有分支 = 无法回滚时空**：Agent 写错了一段代码，执行报错了。用户说：“退回三步之前的状态重新来”。如果是线性数组，你只能让 Agent 带着错误记忆硬着头皮继续改，最终越改越乱。
3. **高并发覆盖**：当系统试图把 50MB 的 JSON 数组覆写进硬盘时，用户正好点了一下系统设置（Settings），也触发了一次写操作。由于没有脏字段隔离，整个 Session 文件当场变成损坏的乱码。
4. **中断僵尸**：用户看着 LLM 正在飞速地瞎扯，立刻发了一句“停！方向错了！”。由于你的代码在一个死板的 `await llm.generate()` 循环里，系统根本无法打断它，硬生生烧掉了几十万 Token。

### 4.4 手术室：OpenClaw 重塑“海马体” 🔬

为了让 Agent 拥有照相机级别的无限记忆，同时还能保持极速的反应，OpenClaw 彻底抛弃了上面所有的天真幻想，采用了极其严谨的四重架构。

#### 4.4.1 追加式事件树的流式构建算法 (Append-Only JSONL Tree)

在 OpenClaw 中，对话数据**严格不会被删除或覆写**。
它把 `transcripts` 存储为一种类似 Git Commit 记录的单向追加结构：`transcripts.jsonl`（JSON Lines格式）。每一行都是一个不可变的 Event 节点，拥有各自唯一的 `id` 和溯源的 `parentId`。

由于工业级 Agent 的对话日志动辄 50MB 以上，如果用 `JSON.parse(fs.readFileSync(...))`，Node.js 主线程会当场失去响应。OpenClaw 采用了内存高度友好的流式读取加上指针重建算法：

```javascript
// session-manager.js 核心脱敏骨架
import fs from "fs";
import readline from "readline";

async function loadSessionTree(filepath) {
  const fileStream = fs.createReadStream(filepath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  // 这里的 Map 是重建时空的关键
  const tree = new Map();
  let headId = null;

  for await (const line of rl) {
    if (!line.trim()) continue;

    // 脏活 99：自动消除由于强制中断残留的 "正在思考..." 垃圾状态
    if (line.includes('"status":"thinking_interrupted"')) continue;

    const event = JSON.parse(line);
    tree.set(event.id, event);
    headId = event.id; // 流的末尾天然是最新的 Head

    // 算法核心：用 parentId 还原树的拓扑关系
    if (event.parentId && tree.has(event.parentId)) {
      const parent = tree.get(event.parentId);
      parent.children = parent.children || [];
      parent.children.push(event.id);
    }
  }

  return { tree, headId };
}
```

**机制点评**：

- **闪电级加载与防乱码**：逐行流式读取，哪怕文件高达 500MB 也能瞬间载入；如果某一行因为断电变成了半截乱码，直接忽略该行，不会像全量 JSON 那样导致整个文件报毁。
- **平行宇宙（分支跳转）**：在内存里，这其实是一棵树！如果用户想“退回三步之前的状态”，系统根本不需要去删除硬盘上的旧数据。它只需要把对话树的指针（Head）重新指向树干上的一个老 `id` 即可。再发新消息时，文件末尾只会追加一条带有旧 `parentId` 的新分支。数据永远不会丢失，甚至支持跨项目从根部横向 Fork 整个记忆栈。

#### 4.4.2 方向盘抢夺锁 (Steering Abort Controller)

当 Agent 在疯狂执行批量工具（比如正在并行读取 20 个代码文件的循环体内）时，如果用户看出了方向不对头，突然发来一条新消息要求打断，这在没有良好设计的异步编程框架中是极其危险甚至不可能的。

如果用普通的 `let isStopped = false` 去在一个 `while` 循环里做软判断，是根本阻滞不了底层已经被 `await` 挂起的并发网络请求的。OpenClaw 的 `agent-loop.js` 祭出了 JavaScript 中最高级别的斩断器：`AbortController`，设计了一个名为 `Steering` 的硬夺权机制。

```javascript
// agent-loop.js 核心脱敏骨架
let currentAbortController = null;

function handleNewUserMessage(msg) {
  // 如果当前的大循环或大模型正在高速运转，直接发送物理级截断信号
  if (currentAbortController) {
    currentAbortController.abort(new Error("SteeringInterrupted"));
    // 脏活 83：确保打断不会把整个 Agent 进程杀掉
  }
  // 开辟一条属于新消息的平行宇宙
  spawnNewBranch(msg);
}

async function executeAgentLoop() {
  currentAbortController = new AbortController();

  try {
    // 将原生的 signal 深层透传给底层的所有 Fetch 请求和工具链
    await llm.generate(prompt, {
      signal: currentAbortController.signal,
    });
  } catch (err) {
    if (err.message === "SteeringInterrupted") {
      console.log("用户夺回了方向盘，当前执行链被扬弃。");
      return;
    }
    throw err;
  }
}
```

**机制点评**：
原生 `AbortController` 绑定到底层是**唯一**能瞬间阻止 Node.js I/O 继续执行并切断远程（比如 OpenAI 服务器）计费的严谨方案。这让 Agent 在执行错误路径时，用户的“Stop”指令能像真实驾驶舱里的 E-Stop 急停按钮一样管用。

#### 4.4.3 双路并行的无损记忆压实 (Split-Turn Compaction)

内存和 Token 不是无限的，当这棵树长得太粗壮，遇到 `413 Payload Too Large` 前，系统会静默启动传说中的 **Compaction 原型机**。
它严格不会粗暴地使用 `history.slice(-50)` 来截断失忆，而是分为“语义边界寻找”与“后台廉价总结”双轨运行：

```javascript
// compaction.js 核心脱敏骨架
async function compactMemoryIfNeeded(history) {
  const currentTokens = countTokens(history);

  // 阈值预警触发
  if (currentTokens > MAX_TOKENS * 0.8) {
    // 1. Split-Turn 机制：不能断在句子中间，也不能切断紧密相连的悬崖 ToolCall
    const splitIndex = findSemanticBoundary(history);
    const staleContext = history.slice(0, splitIndex);
    const activeContext = history.slice(splitIndex);

    // 2. LLM 提取提纯：拉起极快廉价的小模型（如 Claude Haiku 或 gpt-4o-mini）
    const summaryNode = await cheapModel.summarize({
      instructions: "剥离无用寒暄，提取以下对话中的核心事实、踩过的坑及当前目标。",
      messages: staleContext,
    });

    // 脏活 62：无缝缝合进入上下文头部
    return [{ role: "system", content: `[SYSTEM_SUMMARY]: ${summaryNode}` }, ...activeContext];
  }
  return history;
}
```

**机制点评**：
这保证了“近期记忆清晰如昨，久远记忆凝练如钢”。对于那些连摘要空间也快耗尽的史诗级长文工程，系统还会触发**多级缓存滑动**，完美模拟哺乳动物的突触修剪机制。

#### 4.4.4 字段级脏追踪与快照化串行落盘 (Field-Level Dirty Tracking with Snapshot-Serialized Persistence)

我们提到过全量覆盖 JSON 配置导致的互斥死锁灾难。
在 OpenClaw 中，真正值得学的不是“记住哪些字段改过了”这么简单，而是把**脏字段追踪、写入串行化、锁内重读、增量合并**四件事拼成了一整套闭环。否则，即便你知道 `compaction.enabled` 变了，也照样可能在并发保存时把别人刚写进去的 `defaultModel` 覆盖掉。

```javascript
// settings-manager.js 核心脱敏骨架
class SettingsManager {
  modifiedFields = new Set();
  modifiedNestedFields = new Map();
  modifiedProjectFields = new Set();
  modifiedProjectNestedFields = new Map();
  writeQueue = Promise.resolve();

  markModified(field, nestedKey) {
    this.modifiedFields.add(field);
    if (nestedKey) {
      if (!this.modifiedNestedFields.has(field)) {
        this.modifiedNestedFields.set(field, new Set());
      }
      this.modifiedNestedFields.get(field).add(nestedKey);
    }
  }

  save() {
    const snapshotSettings = structuredClone(this.globalSettings);
    const modifiedFields = new Set(this.modifiedFields);
    const modifiedNestedFields = cloneNested(this.modifiedNestedFields);

    this.writeQueue = this.writeQueue.then(() => {
      return storage.withLock("global", (current) => {
        const currentFileSettings = current ? migrate(JSON.parse(current)) : {};
        const merged = { ...currentFileSettings };

        for (const field of modifiedFields) {
          const value = snapshotSettings[field];
          if (modifiedNestedFields.has(field) && value && typeof value === "object") {
            const baseNested = currentFileSettings[field] ?? {};
            merged[field] = { ...baseNested };
            for (const nestedKey of modifiedNestedFields.get(field)) {
              merged[field][nestedKey] = value[nestedKey];
            }
          } else {
            merged[field] = value;
          }
        }

        return JSON.stringify(merged, null, 2);
      });
    });
  }
}
```

**机制点评**：
这里真正有匠气的地方有四层：

1. 全局作用域和项目作用域分开追踪，顶层字段与嵌套字段也分开追踪，不会因为改了 `compaction.enabled` 就把整棵 `compaction` 树当成脏数据全部砸回磁盘。
2. 每次 `save()` 先 `structuredClone` 出一个**写入快照**，再把脏字段集合复制一份。这样即便用户在写盘过程中继续改设置，当前这次写入处理的仍然是一个稳定版本，不会被半路篡改。
3. 所有写入都进入同一条 `writeQueue` Promise 链，形成**进程内串行落盘**。这避免了 UI 连点或多个命令快速改设置时出现交错写入。
4. 真正写文件时，并不是直接把内存态 dump 回去，而是在文件锁内先重读磁盘上的最新版本，再只把本次标记为脏的字段 merge 回去。也就是说，它防的不是“单线程写错”，而是**多进程或多窗口同时改同一份 settings.json** 的覆盖事故。

因此这个设计的关键，不只是 Dirty Tracking，而是**Snapshot Then Merge Under Lock**。当两个进程几乎同时改配置时，它依然尽量把冲突收敛到真正改过的字段，而不是把最后到达的整份对象当作胜利者。

#### 4.4.5 深度优先的祖先链配置狩猎 (Ancestor Chain Discovery)

当系统初始化时，大模型怎么知道用户的代码风格是什么？
OpenClaw 并不是傻傻地只读取当前目录的配置，它的 `resource-loader.js` 会沿着操作系统的真实目录树**向上一路狂奔寻找**，构建一条“祖先优先链”。

```javascript
// resource-loader.js 核心脱敏骨架
import fs from "fs";
import path from "path";
import deepmerge from "deepmerge";

let configCascade = {};
let currentDir = process.cwd();

// 沿着目录树一路拔高，直到抵达系统根目录 (如 '/')
while (currentDir !== path.parse(currentDir).root) {
  const potentialAgf = path.join(currentDir, "AGENTS.md");

  if (fs.existsSync(potentialAgf)) {
    const localConfig = parseMarkdownConfig(potentialAgf);
    // 算法核心：越是底层的目录（比如当前项目），优先级越高，向上深拷贝覆盖
    configCascade = deepmerge(localConfig, configCascade);
  }

  // 拔高一级
  currentDir = path.dirname(currentDir);
}
```

**机制点评**：
这就跟 Git 的 `.gitignore` 规则如出一辙——系统会自动把 `~/.config/openclaw/CLAUDE.md` 的全局喜好设定，与你当前 `~/projects/company-repo/AGENTS.md` 的严格企业规控完美叠加起来使用（脏活 81 / 82 / 109）。

#### 4.4.6 上下文预算守门员：在模型开跑前先审上下文窗口

很多 Agent 框架会等到请求真的打到 provider，收到一句 `context window exceeded` 才意识到出事了。OpenClaw 在这里多做了一层非常克制但极有价值的前置判断：**先判断你选中的模型到底配不配承载这一轮任务，再决定是否让它起跑。**

```typescript
// src/agents/context-window-guard.ts 核心机制
export const CONTEXT_WINDOW_HARD_MIN_TOKENS = 16_000;
export const CONTEXT_WINDOW_WARN_BELOW_TOKENS = 32_000;

export function resolveContextWindowInfo({
  cfg,
  provider,
  modelId,
  modelContextWindow,
  defaultTokens,
}) {
  // 先看 models 配置，再看模型元数据，再回落到默认值
  // 如果 agent 默认 contextTokens 更小，还要再向下收口
}

export function evaluateContextWindowGuard({ info }) {
  return {
    shouldWarn: info.tokens < CONTEXT_WINDOW_WARN_BELOW_TOKENS,
    shouldBlock: info.tokens < CONTEXT_WINDOW_HARD_MIN_TOKENS,
  };
}
```

这件事的妙处在于，它不是简单写死一个“默认上下文大小”，而是明确分层：

1. 优先读取 `models.providers[].models[].contextWindow` 这种显式配置；
2. 再退回模型自身上报的 `contextWindow`；
3. 最后才回到系统默认值；
4. 但如果 agent 级别又额外设了更小的 `contextTokens`，还要再次强制收口。

这相当于在模型调用前先做一次**预算审计**。当用户不小心把一个超小上下文模型绑到复杂工程任务上时，系统不会等到线上撞墙才报错，而是提前给出 `warn` 或 `block`。这是一种非常典型的高级工程心态：**不要把明显错误的配置放到运行时碰碰运气。**

#### 4.4.7 工具结果防爆护栏：单次 Tool Result 不准吞掉整个上下文

Agent 的真正危险，不只是用户说太多，而是某个工具一次性吐出太多。比如 `read` 读了 2 万行日志，`search` 扫出一整个仓库的结果，或者浏览器工具把庞大的 DOM 文本整块塞回上下文。很多系统面对这种情况的做法是：

- 要么什么都不管，让下一轮直接因为上下文爆炸而失败；
- 要么在工具层粗暴截断，结果截掉了最需要的部分；
- 要么把大块结果硬塞给模型，让单个 Tool Result 吃掉整轮对话 80% 的预算。

OpenClaw 这里做了两层非常细的防线：

```typescript
// src/agents/pi-embedded-runner/tool-result-truncation.ts
const MAX_TOOL_RESULT_CONTEXT_SHARE = 0.3;
export const HARD_MAX_TOOL_RESULT_CHARS = 400_000;

// src/agents/pi-embedded-runner/tool-result-context-guard.ts
const CONTEXT_INPUT_HEADROOM_RATIO = 0.75;
const SINGLE_TOOL_RESULT_CONTEXT_SHARE = 0.5;
export const PREEMPTIVE_TOOL_RESULT_COMPACTION_PLACEHOLDER =
  "[compacted: tool output removed to free context]";
```

第一层是**单条结果上限**：单个 tool result 不允许占据整个 context window 的过大比例，默认按 30% 左右估算，并且再加一个绝对字符上限 `400_000` 作为保险丝。

第二层是**整轮上下文护栏**：在真正拼装消息树时，系统会估算当前所有消息的字符体量，为 tool result 额外施加保守的 headroom。如果发现已经逼近模型可承受极限，就主动把旧的工具结果压成占位符，或者把当前结果截成保留开头的版本，并显式附上：

`[truncated: output exceeded context limit]`

这套做法非常有匠气，因为它体现的是一种罕见的节制：**不是所有工具输出都值得完整喂给模型。**
真正高质量的 Agent，不是“看见文本就吃”，而是会在内部做一次信息财政预算，把最贵的上下文槽位留给真正影响推理的内容。

### 4.5 架构模式提炼 📐

纵观 OpenClaw 的会话架构，以下范式值得所有企业级 Agent 效仿：

- **追加式事件溯源 (Append-Only Event Sourcing)**：放弃 Update 和 Delete，只用 `.jsonl` 追加 Insert。通过改变“读取时指针”来达到时空漫游、Fork 分支和历史快照，彻底根绝数据不一致。
- **渐进式降级压实 (Progressive Degradation Compaction)**：用 LLM 来总结 LLM 自己的历史并注入 System 头部，实现冷热数据无缝过渡。
- **原生异常阻断链 (Abort Signal Propagation)**：不要用标识变量控制循环，使用原生的 `AbortController`，将中止信号犹如毒液一样注入到极深层的工具执行与网络 Fetch 中。
- **快照化串行写入 (Snapshot-Serialized Persistence)**：先冻结本次修改快照，再把写入排进单线程队列，最后在文件锁内重读磁盘做字段级 merge，避免“最后一次全量覆盖”这种低级并发事故。
- **预算前置审计 (Preflight Budget Guard)**：在模型调用前就先解析 context window 的真实来源与上限，不把明显超载的配置交给运行时硬碰硬。
- **单消息占比限流 (Single-Message Context Quota)**：为单个 Tool Result 设定硬上限和上下文占比，避免一条“合法输出”把整轮推理预算吃干抹净。

| 模式           | OpenClaw 中的落点               | 通用等价物                    | 适用场景               |
| -------------- | ------------------------------- | ----------------------------- | ---------------------- |
| 追加式事件溯源 | `transcripts.jsonl` + leaf 指针 | Event Sourcing                | 多轮会话、回滚、分叉   |
| 历史压实       | CompactionEntry + 摘要注入      | Log Compaction / Snapshotting | 超长上下文长期运行     |
| 中止信号贯穿   | `AbortController` 深层传递      | Cooperative Cancellation      | 流式回复半路改向       |
| 预算前置审计   | context window guard            | Admission Control             | 小窗口模型误绑复杂任务 |

### 4.6 启示录

> 思考题：如果你把 JSONL 树换成“覆盖式数组 + 定时全量落盘”，短期会省掉哪些复杂度，长期又会在哪三个场景下必然出事？

**状态应该越来越轻，但记忆不能丢。** 仅仅依靠大模型的超长上下文（哪怕是 1M Token），在线上环境也严格是不负责任的做法——它极其昂贵、延迟巨大，且充满幻觉。

掌握了稳固坚韧的记忆控制后，我们将 Agent 推向物理世界的悬崖边——
进入第五章 **Shell 命令安全与审批体系**，看看一条原本人畜无害的命令，是如何差一点把你的整个服务器连根拔起的。
