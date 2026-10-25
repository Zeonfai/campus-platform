# D 模块 AI 上下文

先读仓库根 AGENTS.md、docs/requirements.md（D-001～D-008）、docs/architecture.md、docs/api-contract.md 和 packages/contracts/openapi.json。

本模块职责：身份、会话、动态 RBAC、院系/教室/座位、通知、审计。对应页面由本模块负责人放入 apps/web/src/modules/d/，不能只交付后端。

当前16个D操作已有实现：身份/目录读取、M2/M3委托上下文、版本化预约政策读写及本人站内通知/幂等已读。剩余12个主数据/RBAC/开放规则/公共审计查询接口仍鉴权后返回501；外部通知渠道未接入。新增能力见docs/implementation/task-009-booking-lifecycle.md和docs/verification/2026-10-26-booking-lifecycle.md。政策写限该权限ALL范围并检查revision，规则修改不追溯影响旧预约。通知按事件+收件人唯一，不能读取或标记他人消息。新增管理写接口继续沿用SessionGuard、显式权限、校验、幂等与追加迁移；停用/改密同事务撤销会话，不得用成功占位替代业务。

约束：不自行写 M1 占用表；停用主数据应协调调度内核。角色和管理范围必须在后端检查。

允许的常规修改：本目录、本模块前端目录、本模块行为测试。公共契约、服务级 Prisma schema/迁移、身份授权和公共运行配置需先与负责人协调并说明影响；未确定的政策回到 Q-001～Q-005。

每次任务先列需求 ID、业务状态、失败场景和允许修改路径。验证包含相关越权、并发、重试及时间边界。数据库/HTTP 集成不得 mock 掉核心逻辑。记录真实结果；人工验收后才提交，冲突交由人处理。
