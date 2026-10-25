# 本地启动与实现状态

2026-10-26保存说明：用户已明确授权推送feat/admin-management，供10月27日体验后通过PR合并main；提交/推送和平台检查以GitHub实际记录为准。尚未人工验收，不自动合并。验收与剩余事项见 [当前检查点](checkpoints/2026-10-26-review.md)。

更新：2026-10-26 TASK-010。原初版74822b9已推送并邀请协作；TASK-009已按用户明确授权提交5d1a3f7并推送feat/booking-lifecycle。当前feat/admin-management未人工体验、提交或推送，不代表main合并或全任务书/线上交付。

## 当前业务

契约共 **63个操作，均已有实现**：D29、M1 16、M2 7、M3 11，含新增GET开放规则。数量不是任务书完成率，正式身份运维、外部通知和工程交付仍有缺口。

| 范围          | 已有实现                                                                                                     | 未完成范围                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| D：29个操作   | 身份/目录/委托上下文、政策/站内通知、院系/角色/已有用户授权、房座/全周开放规则、core审计与/admin             | 人工体验、正式账号注册/改密、院系注销、外部投递、跨服务审计汇聚等              |
| M1：16个操作  | 个人预约/再次预约、每日码/签到、持久站内提醒与超时违约/免罚、来源/统计与页面、M2/M3来源及维修影响提示        | 本轮页面人工体验、外部提醒接入、申诉及生产调度运维完善                         |
| M2：7 个操作  | 申请、mine/approvals 查询/详情、顺序决定、撤回、政策列表/追加版本；持久 outbox、租约/退避/版本保护和截止扫描 | 浏览器人工验收、政策编辑管理页面、生产运维与异常执行资格恢复流程               |
| M3：11 个操作 | 工单创建/查询/派单/开始/完工/验收/取消/评价、政策读写；SLA快照/接收人升级事件、持久outbox与来源对账          | 浏览器人工验收、政策管理编辑页面、外部真实通知、运维恢复及未来教室归属变化同步 |
| 工程交付      | 可运行源码、本地Compose、验证工具、增量迁移；CI工作流源码与ci-check入口                                      | Actions实际运行/门禁、云统一部署、生产审批/回退及持续人验                      |

最终本地bash tools/ci-check.sh已退出0：修复后pnpm check、真实数据库、core5迁移22表重放/seed不变、身份8组/调度7组/M2 8组/M3 12组、两套workflow数据验证、生命周期9组与管理11组全部通过，两服务schema diff为空。管理第10组验证政策撤权后403且政策不变，第11组验证互停管理员并发。last-admin守卫隔离破坏曾预期409实际200而失败，逐字节恢复后10组绿，最终CI入口11组通过。此处为本地结果，GitHub Actions平台仍未执行。 详情见 [管理验证](verification/2026-10-26-admin-management.md)。TASK-009历史结果及首次M2差异保留在 [签到验证](verification/2026-10-26-booking-lifecycle.md)，不改写旧证据。

释放执行人永久禁用或撤权时仍会持续 RELEASE_PENDING + syncError，恢复资格后按默认 5 分钟低频补偿；没有实现无需恢复执行授权的自动兜底。不能把同步中的撤回写成已释放，也不能替换 actor 绕过权限。

## 本机环境与配置边界

已配置工具链为 WSL Ubuntu、Node 24.22.0、pnpm 10.33.4、Docker Desktop 的 WSL 集成；业务依赖在项目 node_modules，未改 Python 环境。PostgreSQL 镜像固定版本/摘要，本地服务器 17.11，端口仅 `127.0.0.1:15432`。core/workflow 用两个应用账户和数据库，不允许跨库连接或高权限，历史实际验证见 [数据库记录](verification/2026-10-15-database.md)。

本地四个.env和.local/demo-accounts.json为私密Git忽略配置，当前用户不重初始化，不在状态文档输出值。core现为5条已应用迁移、22表；workflow为3条迁移、14表（均含服务元数据，不计Prisma迁移记录）。本轮追加20261026000100_d_admin_management，仅新增实体revision与审计reason，不增表，不改历史迁移；schema/data最终结论见本轮验证记录。

## 当前启动方法

在 WSL 项目根目录：

```bash
nvm use
pnpm dev
```

`pnpm dev` 先生成契约/构建公共包，再由 `tools/dev-local.mjs` 启动前端和两个后端。它检查已有本地 development/test 配置、loopback 服务和数据库，仅在进程中给两后端提供彼此独立的随机 M2/M3 服务令牌及本地 core origin，不写 .env、不保存密钥。已有两端令牌不一致时拒绝启动。单独启动后端或生产部署必须正式配置对应服务身份；生产禁止使用本地启动器。

访问/admin、/login、/directory、/bookings、/booking-operations、/notifications、/applications、/work-orders。密码只在本机私密文件中由本人查看；用户会话仅在浏览器内存，刷新后重新登录。M2演示为学生申请后院系/教室管理员顺序审批；M3为学生报修、manager-a派给department-a维修、manager-a验收后本人评价。原主要流程已于10月22日粗验，本轮新增页面尚未人工体验。签到默认[-15min,+15min)，提醒-15/+10、+15未签取消；旧预约免罚，仅新预约启用违约。管理码、来源/统计和通知分别在/booking-operations、/notifications，详见 [TASK-009](implementation/task-009-booking-lifecycle.md)。

服务 `/health/live` 与 `/health/ready` 区分存活与数据库基础就绪，均不证明所有业务完成。M2/M3未正确配置HTTP origin/独立服务身份时业务失败关闭，健康检查仍只说明基础设施。

## 验证入口与历史

```bash
pnpm check
pnpm test:database
pnpm test:identity
pnpm test:scheduling
pnpm test:booking-lifecycle
pnpm test:admin-management
pnpm test:workflow
pnpm test:workorders
pnpm test:identity:data
pnpm test:workflow:data
pnpm test:workorders:data
```

上述为入口清单，本轮实际执行结果见 [10月26日验证](verification/2026-10-26-booking-lifecycle.md)，不能据清单推定未来版本已通过。数据库测试只清理自己的随机样本或隔离测试 schema，不清共享库/卷。`pnpm check` 本身不包含全部数据库业务测试，后续 CI 必须显式调用。

- [2026-10-15 身份记录](verification/2026-10-15-identity.md)：当时 D 8 个操作、48 个占位，权限/会话/数据库和故意破坏实验。
- [2026-10-16 调度记录](verification/2026-10-16-scheduling.md)：当时 57 个操作、17 实现/40 占位，core 调度/SDK/来源并发与锁破坏实验；core 三条 SQL 在隔离空 schema 重放 19 表、幂等 seed。
- [2026-10-20 工作流记录](verification/2026-10-20-workflow.md)：当时58操作、25/33，M2初版结果。
- [2026-10-21 维修记录](verification/2026-10-21-workorders.md)：当时M3实际结果与证明边界。不能将历史通过项自动视为本轮回归结论。

原初版74822b9及TASK-009的5d1a3f7已推送，当前管理分支未提交/推送。CI源码已准备、官方Action固定SHA，尚未平台实际运行或配置合并门禁，见 [CI说明](ci.md)。用户无外部渠道，暂先本地与自动检查；外部真实投递仍待，不能视为需求豁免。云部署、完整发布审批/回退、申诉、正式身份运维和跨服务审计汇聚继续待办。
