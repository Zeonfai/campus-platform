# 自动检查方案与运行边界

2026-10-26保存说明：用户已明确授权推送feat/admin-management，供10月27日体验后通过PR合并main；提交/推送和平台检查以GitHub实际记录为准。尚未人工验收，不自动合并。验收与剩余事项见 [当前检查点](checkpoints/2026-10-26-review.md)。

配置日期：2026-10-26。本轮仅在本地准备.github/workflows/ci.yml和检查入口，尚未推送或在GitHub Actions执行；不能将本机通过写成平台CI已通过，也未配置云部署、镜像发布或主分支保护。

## 触发与执行顺序

工作流名Project checks，检查项Build and real database tests。main及feat/**分支的push，以及以这些分支为目标的Pull Request触发。每个ref同时保留最新一次运行；旧运行取消后由always步骤清理自己创建的容器。

GitHub托管ubuntu-24.04隔离runner先设置Node24.22.0和pnpm10.33.4，再用锁文件安装依赖。项目安装显式忽略依赖生命周期脚本，未使用approve-builds或一键放行；Prisma和契约生成由审阅后的项目脚本显式执行。

然后由现有init-local-env.mjs生成四份全新的私密配置，生成数据库客户端，通过infra/local/compose.yaml的固定PostgreSQL镜像摘要启动独立Compose项目，再迁移、基础seed和合成演示seed，最后执行bash tools/ci-check.sh。固定项目名由运行ID和attempt构成，127.0.0.1:15432仅属于该隔离VM；不复用成员.env、密码、数据库或Docker卷。

检查入口先执行pnpm check（结构、lint、类型、14项SDK真实HTTP、构建和基础烟测），随后串行执行：

- test:database
- test:identity:data、test:identity
- test:scheduling
- test:workflow、test:workorders
- test:workflow:data、test:workorders:data
- test:booking-lifecycle、test:admin-management

不能在这些测试运行时同时启动dev/watch或另一次构建，以免覆盖dist；数据库和HTTP核心逻辑不被mock。任一命令失败即停止后续检查，CI仍执行自己的容器清理。

## 本地入口

已有环境、依赖、数据库迁移与演示种子均准备好之后，运行bash tools/ci-check.sh。脚本缺少锁文件、四份.env、演示凭据或node_modules时直接报错，不生成/覆盖配置、不安装依赖、不下载镜像，也不启停数据库。

数据重放测试内部会验证迁移/seed幂等，因此本地数据库应已按开发指南迁移到当前版本；测试只清理自己创建的样本、数据库或schema。检查入口不会docker down，更不会删除用户数据卷。CI的always清理单独放在工作流内，只对其随机运行项目执行down，不带-v。

## 固定来源与最小权限

核验于2026-10-26，采用官方仓库发布页所指向的完整commit SHA：

| Action             | 已核验发布                                                          | 固定提交及来源                                                                                                                    |
| ------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| actions/checkout   | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)   | [3d3c42e5aac5ba805825da76410c181273ba90b1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)   |
| actions/setup-node | [v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) | [949feb2413d6458794dcd2491c4babbbce0c15c1](https://github.com/actions/setup-node/commit/949feb2413d6458794dcd2491c4babbbce0c15c1) |

两个固定提交的action.yml均核验为node24运行时，setup-node明确支持pnpm缓存。这里只使用官方Action；setup-node第一次关闭自动缓存，安装pnpm后仅push任务显式缓存pnpm的内容寻址store，Pull Request不读写此缓存。缓存不包含node_modules、.env、演示密码或数据库数据。

工作流只授予contents:read，checkout不持久化仓库凭据，不用pull_request_target，不注入成员或生产secrets。配置生成和演示seed后会将随机密码加入日志遮罩；不上传.env、凭据或原始日志作为artifact。测试输出仍须持续保持脱敏。

## 仍需真实验证

本轮静态语法检查不代表Actions平台运行成功。后续将配置随审阅后的代码推送并创建PR，检查平台实际运行结果、网络下载、Docker健康、完整测试及清理；通过后再由仓库负责人决定是否把该检查设为合并门禁。失败不能自动发布或合并，生产部署始终另行审批。
