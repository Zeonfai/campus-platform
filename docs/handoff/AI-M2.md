# M2 后续 AI 任务卡

2026-10-22主要流程已粗验，初版已获上传准备/团队接入授权；在现有主链上完善，不从零重写，实际上传以Git记录为准。先读根/M2 AGENTS、requirements M2-001～008/INT、architecture §6/7、api-contract、implementation/task-006-m2-workflow.md、apps/workflow/M2-DESIGN.md、公共 OpenAPI/ResourceCoreClient 和 verification/2026-10-20-workflow.md。

## 已有实现，不重复搭建

M2 已有 7 个操作：申请、本人/审批范围查询/详情、步骤决定、撤回、政策列表/追加版本。对应 workflow 的申请/步骤/政策快照/审计/写入回执/outbox，前端 `/applications` 已接真实 API。8组真实双服务与10月21日回归通过；主要流程已粗验，系统性页面/异常/权限边界验收、政策管理页与运维仍待完善。

默认政策经本轮用户授权采用推荐方案：申请需要当前有效 create 权限与教室范围，未来整点、同一上海自然日最多 24 小时；pending 不预占。默认院系→房管至少两步，冻结角色/步骤/期限版本，禁止自审、同人多步/跳步，角色范围和 decide grant 范围同时检查。总截止 min(提交后48小时,开始)。本人开始前可撤回，超时未完成自动撤销；只有资源确认且本地状态提交后才 APPROVED。

用户与申请教室上下文通过双身份真实 HTTP 读取，workflow 自行确认所有权/步骤事实；不得访问 core 数据库、共享实体、信任前端 actor 或借用无关权限范围。用户 bearer 仅在请求内存，不进入数据库/outbox/日志。

## 必须保留的不变量

状态/意图/审计与 outbox 同事务提交，HTTP 在事务外。固定 operationId/revision 重试，SKIP LOCKED 领取、租约和 leaseToken/applicationRevision 双保护；迟到回执不能复活撤回。core 的历史命令回执不是当前资源事实，必要时来源 GET 确认；超时属于未知，不直接写成功。

占用命令有限重试；释放未知始终 RELEASE_PENDING，同命令重试，24 次后默认 5 分钟低频。core 持久化的明确失败保留 FAILED 命令与审计，另追加更高版本释放意图。**释放执行人永久禁用/撤权会一直 RELEASE_PENDING + syncError；恢复资格后后续补偿才可能收敛**。本轮没有自动替换执行人的机制，不能擅自切换 actor 或强行写已撤回。

本地 `pnpm dev` 用 tools/dev-local.mjs 提供不同且仅进程有效的M2/M3随机服务身份和 loopback origin，不写 .env；现有两端凭据不一致应失败。生产和单独启动服务必须正式配置，不把令牌放源码/VITE_*。修改永久配置遵守环境授权边界。

## 后续可审查切片

- 用真实浏览器验收申请、审批、状态刷新、失败恢复和权限变更，修复实际问题；不要把构建通过当成已点验。
- 补政策版本编辑管理页面与安全输入引导，保留 expectedRevision/历史快照与范围约束。
- 完善 RELEASE_PENDING/syncError、outbox 积压和凭据/执行资格失效的运维可见性、授权恢复指引；设计安全兜底需明确责任/权限和验收，不能仅为了绿灯绕过 core。
- 为新变更补相应行为、并发/时间边界与故意破坏测试；保持追加迁移、幂等 seed，不改历史证据或伪造已执行结果。

现有验收入口 `pnpm test:workflow`；迁移种子入口 `pnpm test:workflow:data`；再按实际变更运行 check 与 identity/scheduling 回归。具体本轮执行结果查验证记录，不将命令清单视为全已通过。测试使用真实 HTTP 和分离数据库、定向清理自己的样本，禁止 mock 核心或直接写 M1 表。
