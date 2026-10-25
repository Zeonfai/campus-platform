# 校园资源服务平台

2026-10-26保存说明：用户已明确授权推送feat/admin-management，供10月27日体验后通过PR合并main；提交/推送和平台检查以GitHub实际记录为准。尚未人工验收，不自动合并。验收与剩余事项见 [当前检查点](docs/checkpoints/2026-10-26-review.md)。

六人课程项目：M1 座位预约、M2 整室申请审批、M3 物业报修、D 公共能力。

## 初版与当前状态

2026-10-22原主要流程已粗验，首次提交74822b9已推送 [GitHub仓库](https://github.com/Zeonfai/campus-platform)并邀请协作。TASK-009签到生命周期随后已按用户明确授权提交5d1a3f7、推送feat/booking-lifecycle；这不表示已合并main或完成全部人工验收。

2026-10-26继续TASK-010公共管理初版：当前63个操作全部已有实现（D29、M1 16、M2 7、M3 11），新增读取开放规则接口。/admin接入院系登记/改名、角色权限、已有用户启停/授权、房间座位登记/修改/停用、全周开放规则和core审计。常规资料注册指院系/房间/座位；不提供公开用户注册或改密码。当前feat/admin-management未人工体验、提交或推送，接口数量不是任务书完成率。

管理写受精确权限范围、授予上限、版本与持久幂等保护，禁止本人改本人授权；全局安全锁和锁后操作者重读保护并发撤权及最后管理员。房间创建后固定院系/专属属性，启停与开放规则竞争M1教室锁、保留既有记录。开放规则按整周替换、周一1至周日7、支持24:00；读取使用同一数据库快照。页面409后草稿失效，必须重新载入，不能把旧输入自动配新版本。详见 [TASK-010方案](docs/implementation/task-010-admin-management.md)。

最终本地bash tools/ci-check.sh已退出0：修复后pnpm check、真实数据库、core5迁移22表重放/seed不变、身份8组/调度7组/M2 8组/M3 12组、两套workflow数据验证、生命周期9组与管理11组全部通过，两服务schema diff为空。管理第10组验证政策撤权后403且政策不变，第11组验证互停管理员并发。last-admin守卫隔离破坏曾预期409实际200而失败，逐字节恢复后10组绿，最终CI入口11组通过。此处为本地结果，GitHub Actions平台仍未执行。 详情汇总至 [管理验证](docs/verification/2026-10-26-admin-management.md)；上轮 [签到验证](docs/verification/2026-10-26-booking-lifecycle.md)与更早记录保留当时事实，不替代本轮结果。

原签到规则保留：默认[-15min,+15min)签到，-15/+10站内提醒、+15未签取消；旧预约不追溯处罚，新预约才启用违约，故障影响免罚，暂不自动封禁。新预约冻结政策，首次releasedAt不因重复释放延长。入口/bookings、/booking-operations、/notifications；管理入口/admin。

用户暂未提供外部提醒渠道，先完成本地与自动检查；邮件/微信等真实外部投递仍未交付，不能写成任务书豁免。CI源码和 [运行说明](docs/ci.md)已准备，官方Action固定SHA，仅本地准备，尚无GitHub Actions实际运行或合并门禁通过记录。云部署、生产审批/回退、申诉、正式身份运维和跨服务审计汇聚继续待办。

core为5条已应用迁移、22张表；workflow为3条、14张表，不计Prisma迁移表。两服务分库账号与真实HTTP边界保持。工具链Node24.22.0/pnpm10.33.4，当前用户不重初始化.env或密码，不改Python环境。更多状态见 [启动索引](docs/bootstrap-status.md)。

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

数据库端口只绑定127.0.0.1:15432；先确认Docker容器已恢复且数据库就绪，再进入项目目录执行：

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

团队从 [接手入口](docs/handoff/START-HERE.md) 和各自AI任务卡独立复现、认领后续切片；原初版已于10月22日推送，当前TASK-010新增功能已通过本地完整检查，仍待人工体验；不虚构人员认领。调度历史设计见 [资源内核方案](docs/implementation/task-006-resource-kernel.md)，M2 当前规则见 [工作流方案](docs/implementation/task-006-m2-workflow.md)。服务凭据没有持久写入 .env；`pnpm dev` 和相关测试提供进程身份，其他方式缺失凭据时业务 503 关闭。M3 当前规则见 [维修方案](docs/implementation/task-007-m3-workorders.md)，外部推送与专业化交付仍需继续完成。
