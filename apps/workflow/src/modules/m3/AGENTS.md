# M3 模块 AI 上下文

先读仓库根 AGENTS.md、docs/requirements.md（M3-001～M3-008、INT-001～INT-004）、docs/architecture.md、docs/api-contract.md 和 packages/contracts/openapi.json。

本模块职责：报修、派单、维修、SLA 升级、验收评价、封锁同步。对应页面由本模块负责人放入 apps/web/src/modules/m3/，不能只交付后端。

2026-10-21 已实现 11 个 M3 操作：报修/列表详情/派单/开始/完工/验收/取消/评价及维护政策读写。追加 7 张 m3_ 表，采用政策快照/幂等回执/审计/outbox/租约/版本 fence。M1 三个维修来源接口和 D 两个委托上下文也已实现；12 组真实双服务测试通过。先读 docs/implementation/task-007-m3-workorders.md、apps/workflow/M3-DESIGN.md 与 docs/verification/2026-10-21-workorders.md。页面 /work-orders 已接接口，浏览器人工验收、真实外部通知及生产交付仍未完成。实现某项接口时需同步更新契约的 x-implementation、状态文档及行为测试；不得批量改成成功响应。

约束：NEW→ASSIGNED→BLOCK_PENDING→IN_REPAIR→AWAITING_ACCEPTANCE→RELEASE_PENDING→CLOSED。仅有效当前指派人可开始/完工；HTTP 来源 ACTIVE 确认后才维修中，完工不解封；验收者有范围且不能是实际维修人，失败保留封锁回维修，通过并确认 RELEASED 才关闭。只解除本工单来源，保留个人/M2 与其他工单；不得直连 core 数据库。

公共教室可报修不扩大管理权限：dispatch/repair/accept/管理取消的 DEPARTMENT 必须匹配非空教室院系；SELF 只用于本人取消/评价，MANAGED_ROOMS/ALL 必须来自对应动作权限。取消只允许封锁尚未发出的 NEW/ASSIGNED；本人 CLOSED 后一次 1～5 分评价。SLA 默认响应24h/维修48h/验收24h，版本快照；按 stage+round 持久化接收人并去重升级，不自动关闭/解封，不等于已外部推送。

状态/意图/审计/outbox 同事务，HTTP 在外；固定 operationId/封锁时间，leaseToken 与业务版本 fence 防迟到覆盖。永久撤权释放保留 RELEASE_PENDING+syncError，不能换 actor 绕权。pnpm dev 只注入彼此独立的进程 M2/M3 身份，不写 .env；生产另配。教室院系事实当前有快照，未来 D 主数据写入必须另定重授权/同步方案，不宣称已自动同步。

允许的常规修改：本目录、本模块前端目录、本模块行为测试。公共契约、服务级 Prisma schema/迁移、身份授权和公共运行配置需先与负责人协调并说明影响；本轮默认政策已获用户授权采用推荐规则，不伪称全组批准；新增政策或环境操作继续记录依据和授权边界。

每次任务先列需求 ID、业务状态、失败场景和允许修改路径。验证包含相关越权、并发、重试及时间边界。数据库/HTTP 集成不得 mock 掉核心逻辑。记录真实结果；人工验收后才提交，冲突交由人处理。
