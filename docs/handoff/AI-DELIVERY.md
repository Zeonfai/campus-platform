# 给交付负责人的 AI 任务卡

先读根与 infra AGENTS、README、development、tasks、bootstrap-status、两份最新验证证据，以及 tools/ci-check.sh 和实际 package scripts。

2026-10-22主要流程已粗验、初版上传准备/团队接入获授权。根任务处理GitHub与远程，实际提交/推送以Git记录为准，不提前写成功。真实CI、云部署、生产审批回退仍未完成，上传授权不等于资源采购授权。

第一任务 REL-T01：在自己的已授权环境从 README 复现，记录问题；确定托管平台后把已有 portable check 入口与真实数据库测试接入 CI。check是结构/lint/类型/14项SDK HTTP/构建/临时运行，不包含数据库验收；CI须加入identity/scheduling/M2/M3、迁移种子和隔离；新成员依development.md独立生成.env/密码，已有环境不重初始化。失败阻断合并和交付，不能跳过失败来演示成功。

第二任务：测试环境按整个项目统一部署，两服务独立 DB/账号、前端同源公开代理、内部接口不公开到浏览器。服务凭据与用户 bearer 分开，secret 不进仓库、制品或 VITE_*。当前 M2/M3 本机持久服务凭据未配置，云部署前需制定注入/轮换与可信代理 IP 策略。

环境锁覆盖迁移、全组服务发布和全系统测试，禁止多轮互撞。制品与提交/tag/镜像摘要关联；测试主干自动部署、生产同制品人工批准。回退先验证数据库兼容窗口，不能用恢复备份当成无损回退。

先提供可审阅脚本/Compose/流水线方案，再申请真实资源或外部设置。环境安装、下载和启停继承环境所有者授权范围；不改他人 WSL/代理/Python。现场要能解释一例跨服务写回、并发冲突、故障恢复、空环境初始化及 schema 演进，当前空 schema SQL 重放不替代云上空数据库部署演练。

2026-10-20补充：已有test:workflow与test:workflow:data，真实CI数据库门禁应纳入这两项及既有identity/scheduling/data/database，不能仅pnpm check。各验证须串行且不要同时启动dev/watch（会重建dist）。本地dev的随机服务身份仅进程存在；CI/云使用环境独立凭据及正式注入，不把本地dev启动器用于生产。该句是10月20日历史；10月22日已进入上传准备，云/实际CI仍待落实，不编造证据。

2026-10-21：再加入test:workorders/test:workorders:data及M3进程独立服务凭据。workflows两库授权边界未变，core3/wf3追加迁移；workflow全迁移空schema现14应用表（含服务元数据）。流水线实际集成尚未执行，不将本地通过误写为CI部署通过。
