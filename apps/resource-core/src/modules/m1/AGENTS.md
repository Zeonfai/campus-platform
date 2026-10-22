# M1 模块 AI 上下文

先读仓库根 AGENTS.md、docs/requirements.md（M1-001～M1-012、INT-001～INT-004）、docs/architecture.md、docs/api-contract.md 和 packages/contracts/openapi.json。

本模块职责：搜索、预约、签到、提醒、违约、统计，以及唯一调度入口。对应页面由本模块负责人放入 apps/web/src/modules/m1/，不能只交付后端。

当前已实现可用性/预约/本人记录/取消及 M2、M3 各三个来源接口，共 11 个操作。M3 使用真实开始时间、整室无固定终点封锁；不取消既有个人/M2 记录，阻止新分配，仅释放本工单来源。本人预约列表/详情含 maintenanceAffected 影响提示，不能将提示当成通知已投递。签到/再次预约/统计/来源明细仍为占位。方案见 docs/implementation/task-006-resource-kernel.md 与 task-007-m3-workorders.md；历史调度证据见 docs/verification/2026-10-16-scheduling.md，本轮证据见 docs/verification/2026-10-21-workorders.md。实现某项接口时需同步更新契约的 x-implementation、状态文档及行为测试；不得批量改成成功响应。

约束：同教室的预约、整室占用和维修封锁须竞争同一数据库调度锁。按来源释放，保留幂等结果和版本墓碑。M3 时间不强制整点，不能误用个人预约 4 小时限制。M3 服务身份独立于 M2；报修公共可见性不扩大维修/派单/验收等 DEPARTMENT 管理权限，只覆盖同院系非空归属教室；core 与 workflow 保持一致。

允许的常规修改：本目录、本模块前端目录、本模块行为测试。公共契约、服务级 Prisma schema/迁移、身份授权和公共运行配置需先与负责人协调并说明影响；未确定的政策回到 Q-001～Q-005。

每次任务先列需求 ID、业务状态、失败场景和允许修改路径。验证包含相关越权、并发、重试及时间边界。数据库/HTTP 集成不得 mock 掉核心逻辑。记录真实结果；人工验收后才提交，冲突交由人处理。
