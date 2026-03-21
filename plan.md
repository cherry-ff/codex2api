# codex2api 设计方案

## 1. 项目目标

这个项目的目标不是重做 OpenAI 官方 API，而是把本地可运行的 Codex 封装成一个稳定、可管理、可并发使用的私有 API 服务，方便统一管理多个 Codex 账号，并让外部 agent 通过接近 OpenAI 的接口来调用。

项目定位:

- 个人使用优先
- 功能必须完整可用
- 架构尽量简单
- 默认单机部署
- 需要支持多用户并发请求
- 需要支持多账号管理、用量查看、账号导入

---

## 2. 关键结论

### 2.1 Codex 是否有会话

有。

Codex 本身不是“每次输入天然无状态”的工具，它支持持续线程/会话:

- `codex exec resume`
- `codex resume`
- Codex SDK 的 `startThread()` / `resumeThread()`
- Codex app-server 的 `thread/start` / `thread/resume` / `thread/fork`

也就是说，Codex 内核层面是支持上下文延续的。

### 2.2 本项目对外 API 是否默认保留会话

不默认保留。

本项目对外 API 采用类似 OpenAI 的无状态模式:

- 每次 API 调用默认创建一个新的 Codex thread
- 上下文由调用方自己拼接并传入
- 服务端不自动为调用方保存会话上下文

这样做的原因:

- 对 agent 集成最简单
- 不需要服务端替用户维护复杂上下文
- 更接近 OpenAI `chat/completions` 使用习惯
- 更利于并发调度
- 避免不同用户/任务串上下文

结论:

- Codex 底层支持有状态
- 我们的 API 默认设计成无状态
- 后续可以加可选的“显式续接 thread”能力，但不是第一阶段核心

### 2.3 技术接入方式选择

后端优先基于 `codex app-server` 集成，不优先选择直接 shell 调 `codex exec`。

原因:

- app-server 原生支持 thread/session 管理
- app-server 原生支持账户状态读取
- app-server 原生支持 ChatGPT rate limit 读取与更新通知
- app-server 原生支持 turn 级事件流
- app-server 更适合做前端实时面板
- app-server 更适合做“一个产品包多个账号 runtime”

补充说明:

- 官方文档里对“自动化作业/CI”更推荐 Codex SDK
- 但本项目不只是跑一次任务，而是要做账号管理、用量面板、会话控制、实时事件流
- 因此这里更适合选 app-server 作为主接入层

`codex exec --json` 可以作为兜底或调试手段，但不作为主集成层。

---

## 3. 设计原则

- 简洁优先: 单机、单服务、单数据库，不一开始引入 Redis、Kafka、分布式调度
- 稳定优先: 默认每个账号同一时间只跑 1 个任务
- 兼容优先: 对外接口尽量兼容 OpenAI 风格
- 隔离优先: 每个 Codex 账号使用独立 `CODEX_HOME`
- 可观测优先: 每个任务必须可追踪、可查看状态、可查看用量

---

## 4. 总体架构

```text
+----------------------+
| Frontend Dashboard   |
| - 账号列表/用量      |
| - 导入 auth.json     |
| - 任务状态查看       |
+----------+-----------+
           |
           v
+----------------------+
| API Server           |
| - OpenAI兼容接口     |
| - 管理接口           |
| - 调度器             |
| - 任务状态管理       |
+----------+-----------+
           |
           v
+----------------------+
| Account Runtime Pool |
| - account A runtime  |
| - account B runtime  |
| - account C runtime  |
+----------+-----------+
           |
           v
+----------------------+
| codex app-server     |
| per account          |
| isolated CODEX_HOME  |
+----------------------+
           |
           v
+----------------------+
| Local Codex + OpenAI |
+----------------------+
```

---

## 5. 建议技术栈

为了保持简单，建议统一使用 TypeScript。

### 后端

- Node.js 20+
- TypeScript
- Fastify
- SSE 或 WebSocket 用于实时事件推送
- SQLite + WAL 模式
- `better-sqlite3` 或 `drizzle + sqlite`
- 子进程管理 `codex app-server --listen stdio://`

### 前端

- React
- Vite
- TypeScript
- TanStack Query
- 简单 UI 组件库即可，不追求复杂设计系统

### 不建议第一阶段引入

- Redis
- 消息队列
- 微服务拆分
- 多机调度

---

## 6. 多账号设计

### 6.1 账号隔离

每个 Codex 账号必须有独立目录:

```text
data/
  accounts/
    acc_001/
      .codex/
        auth.json
        config.toml
    acc_002/
      .codex/
        auth.json
        config.toml
```

每个账号启动一个独立的 app-server runtime，并设置:

- `CODEX_HOME=/.../data/accounts/<account_id>/.codex`
- 认证存储方式固定为 file
- 不共享默认 `~/.codex`

这样可以避免:

- 多账号 auth 相互覆盖
- 会话文件相互污染
- 用量统计混淆

### 6.2 账号导入

前端提供 `auth.json` 上传功能。

导入流程:

1. 前端上传 `auth.json`
2. 后端创建新账号目录
3. 后端将文件写入对应 `CODEX_HOME/auth.json`
4. 文件权限设为仅服务进程可读
5. 启动该账号对应的 app-server
6. 调用 `account/read` 校验该账号是否可用
7. 调用 `account/rateLimits/read` 拉取初始用量

后续可加:

- API key 账号导入
- 账号别名
- 手动启停账号

### 6.3 安全要求

`auth.json` 是敏感凭证，必须满足:

- 不写入 git
- 不通过接口回显原文
- 文件权限最小化
- 日志中禁止打印内容
- 删除账号时同步清理本地文件

---

## 7. 并发与调度设计

### 7.1 调度原则

默认每个账号同一时间只处理 1 个任务。

这是第一阶段最稳妥的策略，因为:

- Codex 本身是重量级 agent 执行
- 本地文件操作与 shell 执行容易相互干扰
- ChatGPT 账号用量窗口存在限制
- 个人使用场景下，账号数量比单账号并发更重要

### 7.2 任务队列

服务端维护两层队列:

- 全局等待队列
- 每个账号自己的执行槽位

调度选择逻辑:

1. 过滤掉不可用账号
2. 过滤掉认证失效账号
3. 过滤掉当前达到并发上限的账号
4. 优先选择用量较低、最近空闲、失败率低的账号
5. 若都忙，则进入等待队列

### 7.3 背压策略

为了避免把单机拖死，需要明确背压:

- 全局排队数超过阈值时直接返回 `429` 或 `503`
- 单任务设置最大执行时间
- 前端显示队列长度和运行中数量
- 长任务支持取消

### 7.4 取消任务

任务取消通过 app-server 的 turn 中断能力实现。

任务状态至少包括:

- `queued`
- `running`
- `completed`
- `failed`
- `cancelled`
- `timeout`

---

## 8. 会话与上下文策略

### 8.1 默认模式: 无状态

OpenAI 兼容接口默认无状态。

行为定义:

- 每个请求创建一个新的 Codex thread
- 将 `messages` 按顺序拼成一份完整 prompt
- 只执行一次 turn
- 请求结束后返回结果

这意味着:

- agent 自己维护上下文
- 调用下一次时，把历史消息一起重新传入

### 8.2 消息拼接规则

建议统一转为一个结构化 prompt:

```text
[system]
...

[developer]
...

[conversation]
user: ...
assistant: ...
user: ...

[latest user request]
...
```

第一阶段只支持文本消息。

### 8.3 可选扩展: 显式 thread 续接

后续可增加自定义字段，例如:

- `metadata.codex_thread_id`
- `metadata.session_mode = "stateless" | "stateful"`

当传入 `codex_thread_id` 时:

- 服务端不新建 thread
- 改为 `thread/resume`
- 在已有上下文上继续执行

但这个能力不是第一阶段必须功能。

---

## 9. 用量与状态刷新

这里要区分两类“用量”:

### 9.1 账号窗口用量

这是 ChatGPT 账号层面的 Codex 用量窗口。

通过 app-server 获取:

- `account/rateLimits/read`
- `account/rateLimits/updated`

前端展示字段:

- 当前使用百分比
- 窗口时长
- 重置时间
- 账号状态

### 9.2 单任务 token 用量

这是每个任务本次消耗的 token。

通过 `thread/tokenUsage/updated` 和 turn 完成事件记录:

- `input_tokens`
- `cached_input_tokens`
- `output_tokens`

前端展示:

- 单次请求 token
- 最近任务 token 趋势
- 每个账号近 24h 任务消耗

### 9.3 刷新机制

建议组合两种方式:

- 事件驱动: 订阅 app-server 更新通知
- 定时兜底: 每 30 到 60 秒主动拉一次

这样可避免面板长时间不刷新。

---

## 10. 对外 API 设计

### 10.1 OpenAI 兼容接口

第一阶段建议实现:

- `GET /v1/models`
- `POST /v1/chat/completions`

可选第二阶段:

- `POST /v1/responses`

### 10.2 `POST /v1/chat/completions`

目标:

- 让现有 agent/SDK 尽量少改代码就能接入

支持字段:

- `model`
- `messages`
- `stream`
- `temperature` 可先忽略或透传为弱兼容字段
- `metadata` 用于扩展 Codex 专用参数

自定义扩展建议放在 `metadata`:

- `workspace_id`
- `account_policy`
- `sandbox`
- `approval_policy`
- `codex_thread_id` 后续可用

### 10.3 推荐请求示例

```json
{
  "model": "gpt-5.4",
  "stream": true,
  "messages": [
    {"role": "system", "content": "You are a coding agent."},
    {"role": "user", "content": "检查这个仓库并修复测试失败"}
  ],
  "metadata": {
    "workspace_id": "project-main"
  }
}
```

### 10.4 返回策略

#### 非流式

- 等待 Codex 完成 turn
- 聚合最终文本
- 返回 OpenAI 风格 response

#### 流式

- 将 Codex agent message 增量转换为 SSE
- 兼容 `chat.completion.chunk`
- 任务结束时补 usage

### 10.5 原生管理接口

除了兼容接口，还需要一组管理接口供前端使用:

- `GET /api/accounts`
- `POST /api/accounts/import-auth`
- `POST /api/accounts/:id/restart`
- `POST /api/accounts/:id/refresh`
- `GET /api/jobs`
- `GET /api/jobs/:id`
- `GET /api/jobs/:id/events`
- `POST /api/jobs/:id/cancel`
- `GET /api/dashboard/overview`

---

## 11. Workspace 设计

Codex 本质上要在本地目录中工作，所以必须明确工作目录。

不建议允许调用方随便传任意路径。

建议增加 `workspace` 概念:

- 每个 workspace 有固定 id
- 每个 workspace 对应一个本地路径
- API 请求通过 `workspace_id` 选择目标项目

示例:

```text
workspaces:
  - id: project-main
    path: /srv/projects/main
  - id: docs
    path: /srv/projects/docs
```

好处:

- 安全
- 易管理
- 前端可视化
- 避免路径注入

---

## 12. 数据存储设计

个人使用场景下，用 SQLite 足够。

建议表:

### `accounts`

- `id`
- `name`
- `status`
- `auth_type`
- `codex_home`
- `created_at`
- `updated_at`
- `last_rate_limit_refresh_at`

### `account_rate_limits`

- `account_id`
- `limit_id`
- `used_percent`
- `window_duration_mins`
- `resets_at`
- `updated_at`

### `workspaces`

- `id`
- `name`
- `path`
- `enabled`

### `jobs`

- `id`
- `user_id` 可空
- `account_id`
- `workspace_id`
- `thread_id`
- `status`
- `request_body`
- `final_text`
- `input_tokens`
- `cached_input_tokens`
- `output_tokens`
- `error_message`
- `created_at`
- `started_at`
- `finished_at`

### `job_events`

- `id`
- `job_id`
- `seq`
- `event_type`
- `payload_json`
- `created_at`

说明:

- `request_body` 可以只保留脱敏版本
- 完整流式事件写 `job_events`
- 大文本日志可按需落 JSONL 文件

---

## 13. 前端最小功能范围

第一阶段前端只做真正必要的页面:

### 13.1 账号页

- 查看全部账号
- 查看账号状态
- 查看当前用量
- 查看重置时间
- 手动刷新
- 启停/重启账号 runtime

### 13.2 导入账号页/弹窗

- 上传 `auth.json`
- 填写账号名称
- 导入后立即校验
- 展示导入是否成功

### 13.3 任务页

- 查看队列中的任务
- 查看运行中的任务
- 查看完成/失败任务
- 查看任务日志流
- 查看任务 token 用量
- 手动取消任务

### 13.4 总览页

- 账号总数
- 可用账号数
- 当前队列长度
- 当前运行任务数
- 各账号用量概览

---

## 14. 安全与权限

虽然是个人使用，也要有基础安全边界。

### 14.1 API 访问控制

至少实现一种:

- 单一 `ADMIN_TOKEN`
- 或简单用户 token 表

### 14.2 工作目录白名单

- 只允许访问已配置 workspace
- 禁止请求体直接指定任意绝对路径

### 14.3 账号凭证保护

- `auth.json` 不回显
- 不打印日志
- 最小权限写文件
- 删除账号时物理删除

### 14.4 执行边界

默认建议:

- sandbox 使用受限模式
- approval policy 使用固定安全配置
- 不把这个服务暴露到公网

---

## 15. 第一阶段不做的事

为了保证项目能尽快落地，以下内容不在第一阶段:

- 分布式多机调度
- 自动扩容
- 多租户强隔离
- 完整 RBAC
- 任意文件系统路径直通
- 完整 Responses API 全量兼容
- 图像/多模态消息

---

## 16. 实施顺序

### Phase 1: 后端核心

1. 建立 Fastify + TypeScript 基础工程
2. 建立 SQLite 数据结构
3. 实现 account runtime manager
4. 实现 `auth.json` 导入
5. 实现 `account/rateLimits/read` 同步
6. 实现 `POST /v1/chat/completions`
7. 实现任务队列与调度
8. 实现任务状态与事件落库

### Phase 2: 前端管理面板

1. 账号列表页
2. 用量总览页
3. 导入账号弹窗
4. 任务列表与详情页
5. SSE/WS 实时刷新

### Phase 3: 进阶能力

1. 可选 stateful thread 模式
2. `/v1/responses` 兼容接口
3. API key 账号导入
4. 更细的调度策略
5. 更完整的指标面板

---

## 17. 最终建议

这个项目第一版最合理的落地方式是:

- 后端用 TypeScript
- 通过 `codex app-server` 管理每个账号
- 每个账号独立 `CODEX_HOME`
- 对外提供 OpenAI 风格的无状态接口
- agent 自己管理上下文
- 服务端只负责调度、隔离、流式转发、用量统计、账号管理
- 前端先做账号与任务面板，不做复杂聊天界面

一句话总结:

这个项目应该做成“多账号 Codex runtime 管理器 + OpenAI 风格代理层 + 简洁管理后台”，而不是“把 Codex 会话逻辑全部封进服务端”。
