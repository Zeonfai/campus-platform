# 新工作副本本地启动指南

更新：2026-10-22，适用于可运行初版 v0.1.0。用户已完成主要流程粗验并授权准备初版/团队接入；这不是全部任务书验收或生产发布。版本范围见 [初版说明](releases/v0.1.0.md)。

## 1. 区分新克隆与已有环境

**新成员**在自己的设备/WSL中克隆仓库、安装项目依赖、独立生成本地配置和演示密码，不复制架构负责人的.env、node_modules、数据库卷或密码文件。

**当前架构负责人已有环境**不要重跑 `tools/init-local-env.mjs`，不要重新生成密码或删除数据卷。已有配置/迁移/演示账号继续使用；平时按第6节启动。新代码确有迁移或种子变更时先读变更说明，再执行对应增量步骤。

同一Docker实例中，本地Compose使用固定项目名 `campus-platform-local` 和固定命名卷；不要在另一工作副本生成新密码后直接复用旧库。多人各自设备的Docker/WSL环境彼此独立。

## 2. 工具与源码位置

Windows成员采用Docker Desktop + WSL2集成，在Ubuntu终端操作本项目。Docker Desktop应已启动并允许对应Ubuntu发行版访问；不要在同一发行版额外安装第二套Docker Engine。Linux成员可使用自己已配置的Docker/Compose环境。

使用Node.js **24.22.0**、pnpm **10.33.4**，以仓库 `.nvmrc`、package.json和锁文件为准。缺少全局工具由环境所有者先准备；本项目不依赖Python/pip/Java或系统PostgreSQL，也不负责修改他人的系统、代理或Python环境。

建议将源码克隆到WSL的Linux文件系统，例如 `~/projects/campus-platform`。使用仓库页面实际提供的地址克隆并进入仓库根目录；不要把Windows安装的node_modules混用到WSL。已使用nvm的终端执行：

```bash
nvm use
node --version
pnpm --version
docker version
docker compose version
```

应能读取Docker服务端信息。网络/代理问题先诊断，不为启动项目擅自切换全局代理或重装WSL。

## 3. 安装项目依赖

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm ignored-builds
```

依赖位于本工作副本的node_modules及pnpm本机缓存，不安装成全局Vue/NestJS。锁文件冻结，不能为了安装成功直接升级版本或删除锁文件。工作区默认不放行安装脚本；查看ignored-builds结果，不能一键全部批准。后续生成/构建脚本会显式生成Prisma和接口代码。

## 4. 仅新副本：生成私密配置并准备数据库

确认本副本四个目标.env均不存在，再执行：

```bash
node tools/init-local-env.mjs
pnpm db:config
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:seed:demo
```

各步骤作用如下：

| 步骤 | 作用 |
| --- | --- |
| init-local-env | 仅创建infra/local、core、workflow、web四份Git忽略的.env；生成独立数据库密码，文件权限0600；只要已有任一目标就拒绝覆盖，不启动服务 |
| db:config | 校验Compose配置，不打印展开后的密码 |
| db:up | 使用固定PostgreSQL镜像/摘要启动数据库并等待健康；首次缺镜像会下载到本机Docker |
| db:generate | 根据两服务schema生成各自Prisma客户端 |
| db:migrate | 对core/workflow顺序执行版本化增量迁移；当前各3条，不修改历史脚本 |
| db:seed | 幂等创建基础服务/预约配置和M2/M3政策等，不导入正式业务数据 |
| db:seed:demo | 仅本地development/test生成五个合成演示账号、教室/座位及演示授权；随机密码写 `.local/demo-accounts.json` |

数据库仅映射 `127.0.0.1:15432`，内部建立 `campus_core/core_app` 与 `campus_workflow/workflow_app`，两账户不得跨库。卷由Docker持有，不是源码文件。基础seed与demo分离，生产不执行demo。

**不要把.env或 `.local/demo-accounts.json` 发到群里或加入Git。** 每名成员在自己本机编辑器查看自己的密码。demo seed使用create-only策略，不重置已有密码、不恢复手动撤销的授权；密码文件丢失而库内已有账号时会拒绝生成不匹配的新文件，应由环境所有者决定恢复/明确重置。

## 5. 新副本首次复现验证

先保持开发watch进程关闭，运行：

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

`pnpm check`包括结构、lint、严格类型、14项SDK HTTP测试、全构建和基础服务烟测；数据库业务测试须另外执行。各脚本顺序运行，**不要同时启动pnpm dev/watch**，否则重建dist可能干扰测试中的真实服务重启。测试创建随机样本/隔离schema并定向清理，不清共享库或数据卷。

该清单是成员复现步骤，不代表已替新成员执行。已有自动验证与破坏实验证据见 [10月21日记录](verification/2026-10-21-workorders.md)，主要流程粗验与初版冻结范围见 [v0.1.0说明](releases/v0.1.0.md)。

## 6. 平时启动、停止和页面入口

数据库停止时先执行 `pnpm db:up`，随后：

```bash
nvm use
pnpm dev
```

本地启动器先生成契约/构建公共包，再启动web/core/workflow。它读取已有本地.env、检查development/test和loopback限制，为M2/M3分别使用不同的仅进程有效随机服务身份，并将本地core origin传给两后端；**不修改.env、不保存或输出服务令牌**。如果已有正式配置，必须两端一致且M2/M3不同，否则启动失败。生产/单独启动服务需要明确配置正式凭据，不能使用本地启动器替代生产秘密管理。

| 入口 | 地址/作用 |
| --- | --- |
| Web | http://localhost:5173/login |
| 主数据 | `/directory`，按权限范围读取目录 |
| 个人预约 | `/bookings`，未来整点，演示08:00～22:00，默认单次最多4小时 |
| 整室申请 | `/applications`，申请/按顺序审批/查看同步结果/撤回 |
| 物业工单 | `/work-orders`，报修/派单/维修/验收/评价 |
| core API文档 | http://localhost:3001/docs |
| workflow API文档 | http://localhost:3002/docs |

终端Ctrl+C结束本次开发进程。数据库可继续保留运行；需要停止时执行 `pnpm db:down`，它保留命名卷。下次 `pnpm db:up`复用原数据和凭据，不重新初始化。不要通过删卷或删库处理普通启动错误。

## 7. 五个演示账号与复现流程

用户名固定、密码每个副本随机且私密：

| 用户名 | 用途 |
| --- | --- |
| demo-student-a / demo-student-b | 各自院系的个人预约、整室申请与报修样本 |
| demo-department-a | M2第一级院系审批；M3维修人员样本 |
| demo-manager-a | 管理demo-room-a；M2第二级审批；M3派单/验收 |
| demo-admin | 全域技术样本及政策管理权限，不代表正式生产账号 |

个人预约：student-a在空闲未来整点搜索demo-room-a座位，预约、查看本人记录并在开始前取消。插座可按NONE/FIXED/RAIL筛选。

整室申请：student-a申请demo-room-a，退出后用department-a完成第一级，再用manager-a完成第二级。确认“已批准”后该时段M1不可新预约；申请人在开始前撤回，确认“已撤回”后才表示本来源释放。禁止自审和一人完成两步。用户令牌仅在浏览器内存，刷新后重新登录。

维修：student-a报修demo-room-a，manager-a派给department-a，后者开始并完工，再由manager-a验收，报告人关闭后一次评价。封锁确认后新分配被阻止；既有个人/M2记录保留，本人预约显示维修影响提示。两张维修只结束一张仍封锁；公共教室可报修不扩大院系派单/维修/验收权。

用户已于2026-10-22完成主要流程粗验；这不替代每位成员的独立复现，也不涵盖所有失败、并发和边界场景。当前仍有21个占位接口，不要将签到/通知等未完成功能记录成可用。

## 8. 常见失败定位

| 现象 | 先检查 |
| --- | --- |
| 初始化提示已有.env | 对已有环境是保护行为；不要删配置重跑，先确认自己是否真是全新副本 |
| Docker命令无法连接 | Docker Desktop/服务端是否启动、WSL集成是否启用；不在本项目里安装第二套engine |
| 15432/5173/3001/3002被占 | 是否已有本项目进程或同Docker实例另一副本；确认进程归属后由环境所有者处理 |
| 密码认证失败/跨库拒绝 | .env与已有卷是否属于同一次初始化；终端是否从其他项目继承DATABASE_URL；只核对来源，不输出秘密 |
| ready为503 | 先确认数据库健康、迁移和基础seed完成；live正常不表示数据库或业务就绪 |
| M2/M3业务503 | 是否通过pnpm dev启动，内部HTTP origin/服务身份是否一致；浏览器令牌不能代替服务凭据 |
| 403/404或按钮缺失 | 当前用户的真实角色、对应动作范围和步骤/指派关系；不能修改前端绕过后端授权 |
| RELEASE_PENDING/SYNC_FAILED | 查看脱敏同步错误和当前来源；网络恢复可补偿，永久撤权/禁用须恢复合法执行资格，不手工写成功 |
| 安装超时 | 保留原错误并诊断网络/源访问；不要删锁、批量升级、关闭TLS校验或改他人代理 |

提问题时给出当前提交/分支、所处步骤、脱敏错误/traceId、可复现输入；不贴密码/令牌/.env。真实课程限制与后续职责见 [接手入口](handoff/START-HERE.md) 和 [需求基线](requirements.md)。
