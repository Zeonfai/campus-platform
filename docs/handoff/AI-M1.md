# 给 M1 负责人的 AI 任务卡

2026-10-22用户已粗验主要流程、授权初版接入；仍需你的独立复现和详细验收。

先读根 AGENTS、模块 AGENTS、requirements 中 M1-001～012、architecture §5/7、api-contract、implementation/task-006-resource-kernel.md 和 verification/2026-10-16-scheduling.md。

已有：SchedulingService 是唯一分配写入口。reserve/cancel/list/get/available与M2/M3各三个来源内部接口已实现，本人列表/详情已有maintenanceAffected维修影响提示；页面 apps/web/src/modules/m1/BookingPage.vue；真实测试test-scheduling.mjs与test-workorders.mjs。维修只阻止新分配、保留旧个人/M2和其他工单，各释放自身；不重写调度或把提示当外部通知。最新边界见10月21日验证。D 的 ResourceDirectoryService 提供主数据、规则、审计公开方法，不能绕过它修改 D 表。

已获架构负责人确认的初版：仅未来整点、默认单次最多 4 小时、只读/取消本人、开始前取消、无额外个人同时预约数量上限；有明确开放规则才可预约，演示 08:00–22:00。不把这些记录成全组政策。

下一任务 M1-T02：设计并实现签到和持久提醒/违约扫描。提前签到窗口、跨午夜和申诉等细节先写可审查推荐方案/配置和失败验收，由架构负责人协调；已规定的 -15min、+10min、+15min 不能改成可选项。日报教室签到码只有授权展示端能获取，普通学生查询不能取得当前码。签到和 +15min 超时竞争同一状态，违约只记一次，系统重启补执行；扫描任务不可只在内存 setTimeout。

允许修改本模块和页面/测试；新增表以追加迁移评审，已执行迁移不改写。所有分配/释放调用 SchedulingService 的相同 `room:` 事务锁，不能另建私有锁或单独“把座位设为可用”。新增写操作持久幂等，不把网络调用放进事务。

验收：可控时钟覆盖边界、签到与超时并发、扫描重放/重启、仅本人、错误/旧/其他教室码、提醒真实去重；按影响运行check、identity/scheduling/M2/M3回归；顺序执行dist测试，不同时开dev/watch。至少故意破坏一个关键分支，保留失败证据。新增页面明确已实现/未实现状态，不伪造通知成功。再次预约与统计仍要留在任务追踪中。
