# 本地启动与实现状态

更新：2026-10-21。只记录实际状态，自动测试通过不表示浏览器人工验收、全组批准、Git 提交或线上交付。用户要求按推荐默认方案继续本地提高完成度，暂不交接或推送。

## 当前业务

契约共 **62 个操作：41 个实现、21 个占位**。数量不是需求完成率。

| 范围 | 已有实现 | 未完成范围 |
| --- | --- | --- |
| D：12 个操作 | 身份/目录只读；内部用户、M2申请教室、M3报修教室与维修人上下文；实时权限与范围 | 用户/RBAC/主数据/配置管理写接口及管理台、真实通知、完整审计查询 |
| M1：11 个操作 | 个人预约；M2/M3各三项来源接口；事务教室锁/版本；本人记录维修影响提示 | 签到码/签到、提醒/违约、再预约、统计、来源详情 |
| M2：7 个操作 | 申请、mine/approvals 查询/详情、顺序决定、撤回、政策列表/追加版本；持久 outbox、租约/退避/版本保护和截止扫描 | 浏览器人工验收、政策编辑管理页面、生产运维与异常执行资格恢复流程 |
| M3：11 个操作 | 工单创建/查询/派单/开始/完工/验收/取消/评价、政策读写；SLA快照/接收人升级事件、持久outbox与来源对账 | 浏览器人工验收、政策管理编辑页面、外部真实通知、运维恢复及未来教室归属变化同步 |
| 工程交付 | 可运行源码、本地 PostgreSQL Compose、验证脚本、规则/方案和迁移 | CI 平台真实门禁、云端全组自动部署、生产审批/回滚演练、Git 历史和人工验收 |

M2历史8组真实双数据库/双服务测试见 [2026-10-20 工作流验证](verification/2026-10-20-workflow.md)。涉及申请/顺序两人审批/真实占用释放、scope/owner/严格入参与幂等、自审和同人多步、政策快照、个人资源冲突、已提交但响应丢失、持久重启、撤回 supersede、长意见及持续释放恢复、pending/syncing 超时。本轮M3 12组真实双服务和14项SDK HTTP测试已通过，见 [2026-10-21 维修验证](verification/2026-10-21-workorders.md)，覆盖完整维修链/多来源/严格管理范围/重启丢响应/SLA去重等。本轮完整check、旧模块回归、迁移与种子重放按最终记录列出，不拿入口清单当通过证据。

释放执行人永久禁用或撤权时仍会持续 RELEASE_PENDING + syncError，恢复资格后按默认 5 分钟低频补偿；没有实现无需恢复执行授权的自动兜底。不能把同步中的撤回写成已释放，也不能替换 actor 绕过权限。

## 本机环境与配置边界

已配置工具链为 WSL Ubuntu、Node 24.22.0、pnpm 10.33.4、Docker Desktop 的 WSL 集成；业务依赖在项目 node_modules，未改 Python 环境。PostgreSQL 镜像固定版本/摘要，本地服务器 17.11，端口仅 `127.0.0.1:15432`。core/workflow 用两个应用账户和数据库，不允许跨库连接或高权限，历史实际验证见 [数据库记录](verification/2026-10-15-database.md)。

本地四个 .env 和 `.local/demo-accounts.json` 是私密、Git 忽略的配置，不在状态文档输出值。已有配置不要重新跑初始化覆盖。core保持3条迁移；workflow新增并已应用 `20261021000100_m3_work_orders`，共3条迁移和14表（含元数据，M3新增7表）。不要改写已执行迁移；未应用的草稿不计发布版本。本轮空库/种子重放是否通过以维修验证记录为准。

## 当前启动方法

在 WSL 项目根目录：

```bash
nvm use
pnpm dev
```

`pnpm dev` 先生成契约/构建公共包，再由 `tools/dev-local.mjs` 启动前端和两个后端。它检查已有本地 development/test 配置、loopback 服务和数据库，仅在进程中给两后端提供彼此独立的随机 M2/M3 服务令牌及本地 core origin，不写 .env、不保存密钥。已有两端令牌不一致时拒绝启动。单独启动后端或生产部署必须正式配置对应服务身份；生产禁止使用本地启动器。

访问 `/login`、`/directory`、`/bookings`、`/applications`、`/work-orders`。密码只在本机私密文件中由本人查看；用户会话仅在浏览器内存，刷新后重新登录。M2 演示为 demo-student-a 申请 demo-room-a，demo-department-a 与 demo-manager-a 顺序审批。M3示例为学生报修demo-room-a，manager-a派给department-a维修，由manager-a验收，报告人关闭后评价。SLA默认24/48/24快照；公共开放不扩大院系管理权；旧个人/M2记录保留并提示影响。前端已接真实API，但浏览器仍未人工验收。

服务 `/health/live` 与 `/health/ready` 区分存活与数据库基础就绪，均不证明所有业务完成。M2/M3未正确配置HTTP origin/独立服务身份时业务失败关闭，健康检查仍只说明基础设施。

## 验证入口与历史

```bash
pnpm check
pnpm test:database
pnpm test:identity
pnpm test:scheduling
pnpm test:workflow
pnpm test:workorders
pnpm test:identity:data
pnpm test:workflow:data
pnpm test:workorders:data
```

上述是可用入口清单，不代表本轮全部已执行。数据库测试只清理自己的随机样本或隔离测试 schema，不清共享库/卷。`pnpm check` 本身不包含全部数据库业务测试，后续 CI 必须显式调用。

- [2026-10-15 身份记录](verification/2026-10-15-identity.md)：当时 D 8 个操作、48 个占位，权限/会话/数据库和故意破坏实验。
- [2026-10-16 调度记录](verification/2026-10-16-scheduling.md)：当时 57 个操作、17 实现/40 占位，core 调度/SDK/来源并发与锁破坏实验；core 三条 SQL 在隔离空 schema 重放 19 表、幂等 seed。
- [2026-10-20 工作流记录](verification/2026-10-20-workflow.md)：当时58操作、25/33，M2初版结果。
- [2026-10-21 维修记录](verification/2026-10-21-workorders.md)：本轮M3实际结果与证明边界。不能将历史通过项自动视为本轮回归结论。

目前没有 Git 提交/推送、实际 CI 或云发布的记录。后续继续M1/D缺失业务、真实通知及浏览器/运维验收，按用户要求暂不发起团队交接；每批本地成果仍须可审查、人工验收后再授权提交。
