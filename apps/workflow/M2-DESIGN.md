# M2 本地初版（2026-10-20）

本轮用户授权按推荐政策推进，由架构负责人确定默认，不代表六人共同评审。
范围 M2-001～008、INT-001～004。只改 apps/workflow；契约、core、前端和统一测试由根任务协调。
需 create 权限和教室范围，未来整点，同一上海自然日不超过24小时，pending不预占。
default政策2880分钟总期限，截止=min(提交+48小时,开始)，部门角色 demo-role-department/DEPARTMENT → 管理角色 demo-role-managed/MANAGED_ROOMS。冻结版本/步骤；禁止自审、同人两步、越步。policy写要求 m2.policies.write ALL，expectedRevision 追加新版本。
PENDING→SYNCING→APPROVED。最终审批仅写资源意图，M1确认且本地版本仍匹配才批准。SYNC_FAILED记录脱敏错误码，不能宣称批准。
本人开始前撤回；未发占用直接WITHDRAWN，可能占用则RELEASE_PENDING更高版本释放确认后终态。未完成审批截止同理EXPIRED。
状态+outbox同事务，HTTP事务外；固定operationId重试；SKIP LOCKED租约多进程安全，applicationRevision和leaseToken双栅栏；旧回执不能复活新状态。指数退避上限并持久失败，重启继续。
身份每次双身份HTTP查询。用户令牌只在请求内存，不进日志/DB/outbox。审批同时检查冻结roleId/步骤范围/当前decide grant范围。所有数据属于workflow自有库。
缺RESOURCE_CORE_URL/M2_SERVICE_TOKEN时业务503，health仍为基础设施健康。追加迁移，不改旧迁移。
验收：真实DB+HTTP两级审批、越权/自审/同人、key/版本并发、冲突、超时撤回补偿、旧回执/重启/租约、policy冻结；根任务记录真实结果。

释放补偿更新：未知释放始终 RELEASE_PENDING，同 operationId 重试，24次以后5分钟低频。core持久化的业务失败保留FAILED命令/audit，同事务追加更高revision释放意图（5分钟后执行），权限恢复后自动收敛。来源查询确认RELEASED即可终态。finish锁outbox行再核leaseToken，防续领TOCTOU。M2_RELEASE_RETRY_DELAY_MS默认300000，仅测试可调低至100。占用命令仍有限重试，未确认不能批准。
