# M3 可运行初版方案（2026-10-21）

覆盖 M3-001～008、INT-001～004。用户已授权按推荐默认继续开发，不代表全组已评审、人工验收或云部署。允许路径：workflow M3 模块、服务级 schema/追加迁移、create-only seed、M3 环境校验；契约、core、前端与根负责人协调。

报修以教室为单位，category/description 必填，不收附件。创建者须当前有效 create 和目标教室范围。状态 NEW → ASSIGNED → BLOCK_PENDING → IN_REPAIR → AWAITING_ACCEPTANCE → RELEASE_PENDING → CLOSED；取消只允许 NEW/ASSIGNED，且本人须有 cancel SELF/教室范围，其他人须有取消管理范围。封锁发出后不提供普通取消，防止绕过维修安全。明确建立失败显示 SYNC_FAILED，保留错误和封锁意图，不把未知结果标成成功。当前指派且恢复有效维修资格者可通过 start 发更高版本新意图重试，原失败命令与审计保留；BLOCK_PENDING 的未知结果只重试原命令，禁止重新开始。

派单/转派只允许 NEW/ASSIGNED，由目标教室范围内 dispatch 执行，目标必须当前有效 repair 范围。转派完整保存 assignment 与 audit。只有当前指派人且有效 repair 才可开始/完工；开始记录实际维修人并持久封锁时间/operationId，HTTP 确认当前来源 ACTIVE 后才显示 IN_REPAIR。进入维修后不普通转派；验收者必须有 accept 管理范围且不是实际维修人。验收不通过回 IN_REPAIR，封锁保留；通过仅保存释放意图，确认当前 RELEASED 后才 CLOSED。报告人且有 rate 可在 CLOSED 后评分 1～5 一次。

默认版本政策响应 24h、维修 48h、验收 24h。新工单引用不可变政策版本；响应期限自创建起、直到封锁确认，维修期限自封锁确认起，验收期限自完工起。验收失败进入新维修轮次并重设维修期限。升级 stage+round 唯一，持久记录 deadline、接收人、角色与教室；进入终态不误升级。升级事件可在详情查看；尚未连接 D 外部渠道，不宣称已通知外部人员。

采用独立 m3_ 表，禁止跨库/直接查询 core。用户 bearer 不落库。业务写入、幂等回执、审计/outbox 同一事务；相同 UUID key 相同内容返回历史响应，修改内容 409；详情表示当前状态。写入均核对 expectedRevision。核心封锁/释放通过 HTTP 在事务外执行，租约领取 + leaseToken/业务版本 fence 提交。封锁固定 command/time，失败分类退避；结果未知以原命令重试并查询当前来源。释放必须查询当前 RELEASED，未知持续低频补偿，明确失败另记更高版本恢复意图，永久撤权保留 RELEASE_PENDING+syncError。

M1 维修封锁阻止新分配但不删除既有个人/M2 记录，多工单叠加。只解除本工单来源。界面提示已存在使用安排需要人工联系，初版不擅自取消预约。

验收：真实 PostgreSQL 与双服务 HTTP，覆盖报告/派单/封锁/完工/拒绝验收/通过释放/评分；越权/跨院系/无效维修目标/自验/并发/幂等/旧版本；封锁重试、租约过期重启、来源对账、重叠封锁、SLA 阈值与去重。根负责人整合测试并记录实际结果，未运行不写通过。

## 范围一致性与已知边界

公共开放性只扩展报修与使用资格，不扩大派单、维修、验收、管理取消的管理范围。M3 管理动作的 DEPARTMENT 须当前用户院系非空且与目标教室 departmentId 匹配；MANAGED_ROOMS 使用当前身份 managedRoomIds；ALL 只来源于当前对应动作权限。本人取消/评分的 SELF 只适用于本人记录。core 与 workflow 保持该语义，不能借公共教室规则扩权。

工单保存目标教室 departmentId 作为工作流事实。当前 D 无教室院系/限制写接口；未来增加此类变更前须定义既有工单快照的重授权/同步策略，不能称已自动同步。资源实际封锁/释放仍由 core 对当前教室和当前操作者再次验证。
