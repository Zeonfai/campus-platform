# D 模块 AI 上下文

先读仓库根 AGENTS.md、docs/requirements.md（D-001～D-008）、docs/architecture.md、docs/api-contract.md 和 packages/contracts/openapi.json。

本模块职责：身份、会话、动态 RBAC、院系/教室/座位、通知、审计。对应页面由本模块负责人放入 apps/web/src/modules/d/，不能只交付后端。

当前D29个操作均已有实现，全项目63操作（D29/M1 16/M2 7/M3 11），不等于任务书完成。TASK-010补齐院系/角色/已有用户访问/房座/开放规则/core审计与GET全周规则；方案docs/implementation/task-010-admin-management.md，最终验证docs/verification/2026-10-26-admin-management.md。TASK-009已推送5d1a3f7，本轮feat/admin-management未提交/推送或人工体验。已有10组管理及last-admin破坏红/恢复绿与旧模块一轮回归；最终完整本地ci-check含11组管理、原业务/数据/schema diff检查已全部通过，平台Actions仍未执行。

约束：不自行写 M1 占用表；停用主数据应协调调度内核。角色和管理范围必须在后端检查。

允许的常规修改：本目录、本模块前端目录、本模块行为测试。公共契约、服务级 Prisma schema/迁移、身份授权和公共运行配置需先与负责人协调并说明影响；未确定的政策回到 Q-001～Q-005。

每次任务先列需求 ID、业务状态、失败场景和允许修改路径。验证包含相关越权、并发、重试及时间边界。数据库/HTTP 集成不得 mock 掉核心逻辑。记录真实结果；人工验收后才提交，冲突交由人处理。

TASK-010约束：精确权限与授予上限，用户重新启用/指定教室扩权均重查；禁止自改本人授权、同事务撤销相应会话。d-write→d-security-admin→锁后actor重读保护管理写、包括预约政策，再按需取policy/room锁；保留最后有效全域安全管理员。所有资源/开放规则变更用M1同一room锁，保留已有占用/历史，房间归属/专属属性创建后固定。全周GET使用RepeatableRead；前端409必须冻结草稿直至显式重读。

注册资料限院系与房座，院系只有登记/改名，房座注销用停用，不提供公开用户注册/改密码。核心审计不冒充跨服务汇聚；正式身份运维/外部投递/申诉/云及完整发布仍待。用户暂无外部渠道先本地检查，不代表免除任务书要求。CI源码已准备而非平台已通过，不把接口全实现冒充所有需求交付。
