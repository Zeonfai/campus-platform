# D 模块 AI 上下文

先读仓库根 AGENTS.md、docs/requirements.md（D-001～D-008）、docs/architecture.md、docs/api-contract.md 和 packages/contracts/openapi.json。

本模块职责：身份、会话、动态 RBAC、院系/教室/座位、通知、审计。对应页面由本模块负责人放入 apps/web/src/modules/d/，不能只交付后端。

当前已实现登录/退出/当前用户及 5 个目录读操作，另有工作流内部用户上下文接口；其他操作仍为占位并在鉴权后返回 501。方案和证据见 docs/implementation/task-005-identity.md 与 docs/verification/2026-10-15-identity.md。新增写接口须沿用 SessionGuard、显式权限、运行时校验和版本化迁移；禁用/改密同事务撤销会话。实现某项接口时需同步更新契约的 x-implementation、状态文档及行为测试；不得批量改成成功响应。

约束：不自行写 M1 占用表；停用主数据应协调调度内核。角色和管理范围必须在后端检查。

允许的常规修改：本目录、本模块前端目录、本模块行为测试。公共契约、服务级 Prisma schema/迁移、身份授权和公共运行配置需先与负责人协调并说明影响；未确定的政策回到 Q-001～Q-005。

每次任务先列需求 ID、业务状态、失败场景和允许修改路径。验证包含相关越权、并发、重试及时间边界。数据库/HTTP 集成不得 mock 掉核心逻辑。记录真实结果；人工验收后才提交，冲突交由人处理。
