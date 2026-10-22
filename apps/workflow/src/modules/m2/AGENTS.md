# M2 模块 AI 上下文

先读仓库根 AGENTS.md、docs/requirements.md（M2-001～M2-008、INT-001～INT-004）、docs/architecture.md、docs/api-contract.md 和 packages/contracts/openapi.json。

本模块职责：申请资格、至少两级审批、驳回撤销、超时、资源同步。对应页面由本模块负责人放入 apps/web/src/modules/m2/，不能只交付后端。

2026-10-20 已实现 7 个 M2 操作：申请、mine/approvals 查询/详情、顺序步骤决定、撤回、政策列表与追加版本。申请/步骤/快照/审计/原子 outbox、租约/退避、版本与 leaseToken fence 已有；真实双服务数据库/HTTP 8 组测试通过。Web `/applications` 页面已接接口，浏览器人工验收尚未完成。先读 `docs/implementation/task-006-m2-workflow.md`、`apps/workflow/M2-DESIGN.md` 与 `docs/verification/2026-10-20-workflow.md`，不重写另一套工作流。实现某项接口时需同步更新契约的 x-implementation、状态文档及行为测试；不得批量改成成功响应。

约束：业务意图和 outbox 同事务持久化，事务提交后才调用 M1。最终批准前必须确认资源占用。不得直连 core 数据库。禁止自审、同一人完成多步；步骤角色/范围与当前 decide grant 均检查；政策快照不得被后续更新改写。用户 bearer 只存请求内存。

释放未知结果保持 RELEASE_PENDING，以固定命令重试；超过 24 次按默认 5 分钟低频补偿。core 明确拒绝时保留原 FAILED 命令并追加更高版本释放意图。执行人永久禁用/撤权时持续 RELEASE_PENDING + syncError，须恢复相应资格；不要换 actor 绕过授权或写成已撤回。`pnpm dev` 自动提供仅进程有效本地服务身份，单独启动/生产须配置正式身份，不能写入 VITE_*。

允许的常规修改：本目录、本模块前端目录、本模块行为测试。公共契约、服务级 Prisma schema/迁移、身份授权和公共运行配置需先与负责人协调并说明影响；默认政策已由用户授权推荐推进，详见实现方案；新政策/外部环境变化仍须记录依据并按授权边界执行。

每次任务先列需求 ID、业务状态、失败场景和允许修改路径。验证包含相关越权、并发、重试及时间边界。数据库/HTTP 集成不得 mock 掉核心逻辑。记录真实结果；人工验收后才提交，冲突交由人处理。
