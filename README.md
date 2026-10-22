# 校园资源服务平台

六人课程项目：M1 座位预约、M2 整室申请审批、M3 物业报修、D 公共能力。

## 初版与当前状态

2026-10-22：用户已完成主要流程粗验，决定冻结可运行初版 v0.1.0 并开始团队接入，已授权必要文档修正与上传准备。这不是全部任务书验收或生产发布。详见 [初版说明](docs/releases/v0.1.0.md)；本文编制时尚未完成提交/推送，上传结果以后续实际Git记录为准。

当前契约 62 个操作：41 个实现、21 个占位。D 身份/目录与委托上下文 12 个、M1 个人预约及 M2/M3 来源接口 11 个、M2 申请审批/政策/outbox 7 个、M3 工单/维修/验收/评价/SLA 政策 11 个。M3 12 组真实双数据库、双服务 HTTP 测试及 14 项 SDK HTTP 测试已通过；本轮完整检查/回归以 [维修验证记录](docs/verification/2026-10-21-workorders.md) 为准。

前端已有预约、整室申请、物业工单页面。用户已粗验主要流程，系统性的页面、失败/权限/时间边界验收及成员独立复现仍需继续。维修会阻止新分配，保留既有个人/M2 预约并提示影响；多工单仅释放自身来源。SLA 默认响应24h/维修48h/验收24h，保存版本快照和去重的接收人升级事件，尚未接入 D 真实通知渠道。

M1 签到/提醒/违约/再预约/统计、D 管理写接口/真实外部通知、CI 和云部署仍未完成。释放执行人永久禁用/撤权仍可导致 RELEASE_PENDING + syncError，须恢复资格后补偿；不能用接口计数当需求完成率。

2026-10-20/21采用推荐默认推进本地初版；2026-10-22已授权准备初版并上传、开始团队接入，替代此前暂不交接/推送的安排。默认政策与粗验不表示全组批准或全部需求通过。M2 历史证据保留在 [10月20日工作流验证](docs/verification/2026-10-20-workflow.md)。

Node 24.22.0 与 pnpm 10.33.4 已在架构负责人 WSL 中安装。既有基线曾完成依赖/生成/类型/构建、临时服务、本地 PostgreSQL 17.11 迁移/种子及账号隔离验证；本轮回归实际执行结果以 [状态与验证索引](docs/bootstrap-status.md) 为准，不用历史结果代替修改后的检查。
Git初次提交/上传正在准备，由实际操作结果确认；没有云部署或实际CI通过记录。接口和业务政策仍需成员评审。

## 先读这些文件

1. [根 AI 规则](AGENTS.md)
2. [需求与验收](docs/requirements.md)、[六人任务](docs/tasks.md)
3. [架构](docs/architecture.md)、[接口约定](docs/api-contract.md)
4. [本地开发步骤](docs/development.md)、[交接与未完成项](docs/handoff.md)

修改模块前，还须读取该模块的 AGENTS.md；其他 AI 工具不一定自动加载它们。

## 工程结构

```text
apps/web/                       Vue 门户及四模块页面目录
apps/resource-core/             D、M1；唯一资源调度入口
apps/workflow/                  M2、M3；通过 HTTP 调用 resource-core
packages/contracts/            OpenAPI 源、生成类型与内部 HTTP 客户端
infra/local/                   本机 PostgreSQL 配置，不是生产部署
tools/                         结构检查、本地配置初始化、CI 检查入口
docs/                          需求、架构、任务、交接及验证记录
```

本地已为两服务创建独立数据库与账号，实际跨库连接被拒绝；禁止通过跨库读写替代 HTTP 集成。业务 DTO 从 OpenAPI 生成，不共享数据库实体。

## 不需要下载即可执行的检查

在 Ubuntu 项目根目录使用 Node 24：

```bash
nvm use
node tools/check-structure.mjs
node --test packages/contracts/test/*.test.ts
```

第二条测试启动并关闭仅绑定本机随机端口的临时 HTTP 服务，验证真实请求、冲突、超时和凭据保护；它不是全系统数据库集成验收。

## 安装与运行

以下初始化仅供新成员全新工作副本，先阅读 [新克隆启动指南](docs/development.md)。当前架构负责人已完成初始化，不要重跑配置初始化或重新生成密码。新成员在自己的环境独立生成.env与演示密码，不能复制负责人的私密文件。源码和 node_modules 统一放在 WSL，同一副本不混用 Windows 安装结果；不需要 Python、pip、Java 或系统级 PostgreSQL。

```bash
pnpm install --frozen-lockfile
pnpm ignored-builds
node tools/init-local-env.mjs
pnpm db:config
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
# 仅本机合成演示；正式部署不要运行
pnpm db:seed:demo
pnpm dev
```

安装脚本默认不自动放行。依据实际 ignored-builds 结果审查，不能一键允许全部。pnpm-lock.yaml 已生成，须随工程人工检查并纳入版本管理；新工作副本及 CI 使用 frozen-lockfile。

前端 http://localhost:5173；core http://localhost:3001/docs；workflow http://localhost:3002/docs。
每个服务有 /health/live 和 /health/ready。ready 检查真实数据库连接与服务标识种子；不表示业务已实现；数据库账号隔离另由真实连接测试验证。

更多前置条件、运行命令、失败排查和数据库边界见 [开发说明](docs/development.md)。

## 协作

业务负责人交付页面、接口实现、迁移和行为测试。人工验收后提交任务分支，另一成员评审后合并。冲突由人处理。未完成需求继续保留在追踪中，不用提交次数或空壳接口代替实际贡献。

## 当前这台机器的启动与停止

数据库已运行，端口只绑定 127.0.0.1:15432。进入项目目录后执行：

```bash
nvm use
pnpm dev
```

启动器 `tools/dev-local.mjs` 会给本地两后端提供仅进程有效且彼此独立的 M2/M3 随机服务令牌及 loopback core 地址，不修改 .env、不保存密钥；若已有配置不一致则拒绝启动。它只用于本地 development/test；生产或单独启动服务必须正式配置并管理凭据。这是前端与两个后端的开发进程，终端 Ctrl+C 可结束。打开 http://localhost:5173/login；用编辑器在本机查看 `.local/demo-accounts.json` 中的随机账号密码，选择 demo-student-a、demo-manager-a 或 demo-admin 对比范围。令牌只在浏览器内存中，刷新后重新登录。目录展示登记信息；登录后从侧栏“预约自习座位”或 `/bookings` 查询未来整点时段、筛选插座、预约和取消。演示教室每日 08:00–22:00，单次默认最多 4 小时。

M2 页面入口是侧栏“整室申请”或 `/applications`。在空闲的未来时段用 demo-student-a 提交 demo-room-a 申请；退出后分别用 demo-department-a、demo-manager-a 按顺序审批，再切回申请人查询批准并撤回。密码均只在本机私密文件中查看。两次审批不能由申请人或同一人完成；只有状态“已批准”才表示资源已确认，只有“已撤回”才表示释放已确认。此流程供新成员独立复现；用户的主要流程粗验不代替全部审批边界和失败场景验收。

M3 入口为 `/work-orders`：demo-student-a 报修 demo-room-a，demo-manager-a 派给 demo-department-a，后者开始/完工，再由 demo-manager-a 验收，报告人关闭后评价。先运行已授权本地 demo seed 补齐 create-only 权限；未具备权限时不要手工改库。此步骤供新成员复现与后续系统验收；主要流程粗验不意味着所有维修边界已验收。公共教室允许报修不代表院系管理员可跨院系派单/维修/验收；已有预约受维修影响需人工联系，不自动取消。

复核数据库及临时后端检查（命令清单不表示本轮全部已运行，以验证记录为准）：

```bash
pnpm db:verify
pnpm test:database
pnpm test:identity
pnpm test:scheduling
pnpm test:workflow
pnpm test:workorders
pnpm test:identity:data
pnpm test:workflow:data
pnpm test:workorders:data
```

暂时不用数据库时可执行 pnpm db:down；容器和项目网络停止/移除，但命名数据卷保留。下次 pnpm db:up 可继续使用数据。数据库数据保存在 Docker 卷 campus-platform-local_postgres-data，而不是源码目录。

本轮实现范围、会话/权限设计及未完成项见 [身份切片方案](docs/implementation/task-005-identity.md)；真实验证与故意破坏测试见 [身份验证记录](docs/verification/2026-10-15-identity.md)。

团队从 [接手入口](docs/handoff/START-HERE.md) 和各自AI任务卡独立复现、认领后续切片；正在准备初版接入，不宣称已经完成上传或人员认领。调度历史设计见 [资源内核方案](docs/implementation/task-006-resource-kernel.md)，M2 当前规则见 [工作流方案](docs/implementation/task-006-m2-workflow.md)。服务凭据没有持久写入 .env；`pnpm dev` 和相关测试提供进程身份，其他方式缺失凭据时业务 503 关闭。M3 当前规则见 [维修方案](docs/implementation/task-007-m3-workorders.md)，外部推送与专业化交付仍需继续完成。
