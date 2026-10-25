# 接口约定草案

状态更新至2026-10-26：62操作中50实现、12占位（D16、M1 16、M2 7、M3 11）。本轮新增接口见TASK-009方案，旧日期章节保留当时事实。新增变更尚未人工体验、提交或推送；验证边界见文末，不将接口存在视为全需求验收。

## 源与归属

packages/contracts/openapi.json 是业务 DTO 源；x-service 指明运行服务，tags 指明模块，x-permission 是预期权限码。生成类型不手工编辑。
公开入口 /api/v1；资源内部命令 /internal/v1 仅服务调用，浏览器不能访问。Swagger 在本地 /docs 展示本服务部分；生产默认禁止开启。

## 身份与权限

用户访问令牌与服务凭据分离。内部请求中的 actorId 不自带可信权限，必须验证服务身份、可信用户委托、有效权限及数据范围；不信任浏览器自填 actorId/sourceModule。
D 已实现数据库会话及动态角色/范围检查；用户 bearer 是随机 opaque 令牌，数据库仅保存摘要，绝对有效期 1 小时，浏览器只在内存保存。D 的受保护操作须声明 RequirePermission，缺少声明直接拒绝。未实现模块的 501 不表示鉴权已经通过。替换某个业务占位时必须同时接入真实认证/授权和参数 DTO 校验，不能单独改成功返回。
每次请求读取当前用户、角色、权限和管理范围；禁用时请求拒绝，退出摘要撤销幂等。未来禁用/改密写接口同事务撤销全部会话。不同权限的范围不混用；ALL 角色的无关权限不能扩大另一权限的院系范围。服务凭据不进入前端、源码、URL 或日志。

## 请求、响应与错误

成功直接返回对应资源或分页对象；列表统一 items、nextCursor，limit 默认 20、最多 100。所有业务写操作除登录外要求 Idempotency-Key；幂等作用域、保留期限和并发执行语义在实现前评审。
失败统一 { error: { code, message, traceId } }。400 参数，401 未认证，403 越权，404 不存在，409 冲突/旧版本/幂等内容不一致，422 非法状态，429 限流，501 未实现，503 依赖或同步不可确认。
错误响应不返回数据库原始错误、密码、令牌或签到码；当前教室签到码仅由有对应管理范围的受保护展示接口返回，并设置no-store。请求 ID 作为关联标识，不替代认证。内部原操作者及操作事实必须保留审计。

## 时间、资源与幂等

时间为含时区 RFC3339，存储使用 timestamptz，展示按 Asia/Shanghai。区间左闭右开；M1 预约按整点小时且默认不超过 4 小时，可由政策调整。
内部命令包含 operationId UUID、递增 revision、actorId、reason；建立命令另含 roomId 与时段。相同命令重放返回原结果；相同操作 ID、不同内容拒绝；旧版本不能复活已释放占用。
ResourceEffect 的 sourceModule/sourceId、operationId、revision、state、updatedAt 必须与命令一致；返回成功前必须完成数据库提交。释放仅解除该来源，保留版本墓碑。
workflow 在同一事务保存业务意图和 outbox，提交后才调用 ResourceCoreClient。客户端一次只发一个请求，没有内置重试。超时属于结果未知，应查询来源结果或以原身份重试，不能创建新的 operationId 掩盖前次结果。

## 尚待明确与补齐

M1签到/提醒/违约/来源统计与D站内通知、政策接口已有本轮实现；统计口径、窗口和免罚默认已记录。仍缺D管理12接口、外部投递、审计查询/汇聚与违约申诉，审批/维修和新签到方案继续待团队评审与体验。提醒与超时由持久扫描处理，不以假HTTP成功替代。
接口草案不覆盖所有任务书最终细节；需求基线保留全部条目。M2 默认政策已由用户于 2026-10-20 授权按推荐方案本地实现；其他未决政策保留，不作为全组已批准政策。

历史身份切片契约细化：User bearerFormat 从草案 JWT 改为 opaque 会话；Role 增加 scope，Room 增加 restrictedToDepartment；对应类型重新生成。目录游标为最后一条 ID（最大 100 字符），limit 1～100；本轮角色/权限目录仅允许该权限具有 ALL 范围。退出要求合法 UUID Idempotency-Key，按令牌摘要撤销，重复撤销/未知但格式合法令牌返回 204，缺少令牌 401。完整会话和目录策略见 implementation/task-005-identity.md。

## 2026-10-16 调度与工作流接入

个人预约、查询本人/取消、可用性及 M2 内部占用/释放/查询已实现，细节见 implementation/task-006-resource-kernel.md。公开 M1 写入键按用户跨 M1 操作划分、成功结果持久留存；幂等重放返回当时的响应快照，GET 返回当前记录。内部操作保存明确业务失败及成功，源版本 1～2147483647，RELEASED 为单次来源生命周期的终态；历史回执不能覆盖调用方更新的本地版本。

新增 GET /internal/v1/identity/context：服务 bearer + X-User-Authorization 原用户 bearer，返回 PrivateUserContext(user/roleIds/grants/managedRoomIds)，每次实时校验、不缓存。M2/M3 配置各自服务身份，M2 资源写入只接受 M2 身份；缺失时 503 关闭。SDK getUserContext/getOccupancy 不自动重试、不跟随重定向、有响应大小和超时限制。M3 资源命令仍是占位。workflow 仍须自己验证申请所有权、当前步骤及审批人，不能把“身份校验通过”当成业务授权通过。

## 2026-10-20 M2 业务接口

M2 七项公开操作已实现，新增 D 教室资格上下文，共58操作/25实现/33占位。申请政策为有版本的快照；PUT政策输入expectedRevision（新建0），输出新revision，不改既有版本。policy.steps.roleId各不相同，scope为DEPARTMENT/MANAGED_ROOMS/ALL；部门步骤按申请人提交时院系、教室步骤按当前管理范围判断，另要求审批人当前实际角色和对应审批权限，禁止本人/同人多步。申请只接受未来整点、同一上海日、最多24小时，最终开放规则与冲突由M1重检。

状态PENDING/SYNCING/APPROVED/REJECTED/WITHDRAWN/EXPIRED/RELEASE_PENDING/SYNC_FAILED。申请响应包含purpose、departmentId、deadlineAt、政策版本、步骤记录、当前revision及脱敏syncError。决定和撤回均提交expectedRevision。本人使用前可撤回；同步中/已批准或结果不确定的来源必须确认释放再终态。明确资源冲突显示SYNC_FAILED/RESOURCE_CONFLICT，不自动批准或默默重新申请。列表view=mine|approvals、status、limit/cursor；政策列表同样严格分页。所有M2写操作均按用户+UUID键全局幂等，重放返回历史快照，后续GET取现状。

GET /internal/v1/identity/rooms/{roomId}只供M2服务与原用户双身份调用，仅取m2.applications.create本身的数据范围，不能借用审批ALL权限获取申请资格。用户bearer不落库；事务内不发HTTP。outbox使用30秒租约，固定operationId，结果写入先锁定outbox行并检查租约及申请版本。占用确认后再次读取当前来源再批准；释放失败保留待处理并低频补偿，明确失败回执不改写，必要时追加更高版本的释放意图。

限制：原执行人永久禁用或权限永久撤销时，释放可能持续待处理，syncError保留事实；当前需D恢复资格后补偿，尚无另一个特权身份绕过权限的系统释放接口。代码不将此异常伪报为已撤回。

## 2026-10-21 M3 维修初版

M3报修/查询/派单转派/开始/完工/验收/取消/评分与维修政策共11项，M1维修来源建立/查询/释放3项，D新增M3报修教室及维修人资格2项；当前62操作/41实现/21占位。维修政策有版本，默认responseMinutes1440/repairMinutes2880/acceptanceMinutes1440，1..43200，历史快照不重写。

报修输入roomId/category/description/可选policyId；查询view=mine|managed|assigned及status/游标。所有写请求UUID幂等键，除创建外带expectedRevision；评分使用score/comment/expectedRevision，输出rating。详情events最近100条，列表events空数组以控制响应，数据库完整审计保留。SLA升级(stage,round)唯一并持久保存收件人及时间，属于管理端记录，尚无真实外部投递。

状态NEW→ASSIGNED→BLOCK_PENDING→IN_REPAIR→AWAITING_ACCEPTANCE→RELEASE_PENDING→CLOSED；验收失败回IN_REPAIR，原来源保持ACTIVE。只有被指派且当前具有该教室维修权限者开始/完工；验收要求当前accept范围且不是实际维修人。转派限未发出封锁的NEW/ASSIGNED，保留指派历史；取消限未发出封锁阶段并检查本人/管理取消资格；关闭后本人有m3.rate才可一次1..5评分。明确封锁失败SYNC_FAILED可由当前有效维修者通过start追加更高意图，未知结果仍BLOCK_PENDING原命令补偿。不能用取消绕过独立验收。

M3管理动作的DEPARTMENT严格匹配教室归属，公共开放只扩展报修/使用资格，不扩展repair/dispatch/accept等权限；D/core和workflow一致。GET内部work-order-rooms与repairers双凭据不跟随redirect，校验返回room/user，管理收件人最多500，超出明确503，避免默默截断。M3独立凭据与M2不可相同，未配置失败关闭。

维修时间使用带时区实际时刻，可非整点；M1按同一个room锁写入，无固定结束，允许叠加既有个人/M2和其他维修，不自动取消它们。释放只本工单，源版本/操作指纹/历史回执与墓碑一致。本人预约GET/list返回maintenanceAffected，用于显示当前维修影响，预约状态保留。

永久撤权导致补偿待处理、D主数据变更后的既有工单重授权、完整通知和浏览器人工验收仍是后续工作；不把pending显示成已关闭。验证见verification/2026-10-21-workorders.md。

## 2026-10-26 TASK-009：签到生命周期与D支持

本轮新增9个已有契约操作，未增加操作总数：M1的checkIn、repeatBooking、getRoomCheckInCode、listResourceReasons、bookingStatistics；D的getBookingPolicy、setBookingPolicy、listNotifications、markNotificationRead。当前62/50/12，完整初版决策见 [TASK-009方案](implementation/task-009-booking-lifecycle.md)。

签到输入code，成功200；本人预约在冻结的窗口内提交当前教室当天码，默认窗口[-15min,+15min)。错误码按预约持久限流，每分钟5次；截止或非法状态422、错误码400、临时限流429。成功使用M1用户作用域UUID幂等键，重放是历史响应；不能用旧响应覆盖后续状态。每日码展示要求m1.checkin-code.display和该动作的管理范围，按北京时间日期；普通学生不可取码。

再次预约输入只有新startsAt/endsAt，服务端沿用本人的历史座位并重新执行预约权限、开放与冲突检查。返回Booking新增政策版本、签到窗口、checkedInAt、violationAt、取消原因等字段。旧预约不追溯记违约；停用或签到窗口受维修影响时免罚，首次releasedAt在资源锁后取得，重复释放不延长维修影响。

预约政策PUT要求ALL范围d.settings.write、当前revision和UUID幂等键，旧revision返回409；创建新版本仅影响之后的新预约。默认maxHours=4，签到提前15分钟，提前提醒15分钟、开始后提醒10分钟、超时15分钟；提前提醒0表示关闭，二次提醒必须早于取消。本人通知GET分页；已读POST为本人数据、UUID幂等键、成功204，不能指定任意收件人。

来源和统计GET必填含时区整点startsAt/endsAt，最大31天，管理范围按各自权限严格过滤，公共教室不扩大院系管理权。来源游标为模块:来源ID，M1部分须为UUID；按D/M1/M2/M3分组和数据库各自顺序续页，统一游标长度上限200。来源可包含已取消/释放事实，状态明确；统计按教室分页，可roomId筛选，bookedHours/checkedInHours为所选区间交集的个人座位预约小时，后者是已签到预约时长代理，不代表真实在座，另返回状态计数。

默认持久扫描发站内提醒并原子提交超时状态、一次违约和通知。站内通知不等于外部投递，D-006外部渠道仍未交付。M2/M3保持HTTP集成与独立数据库；M3升级事件未自动接成外部消息。

截至10月26日，本轮pnpm check、扩展后生命周期9组、身份8组、调度7组、M2独立重跑8组、M3回归12组、真实数据库检查、两库空表重放/种子不变及Prisma schema diff均通过。错码守卫隔离破坏时测试由预期400变为200而失败，逐字节恢复后9组重过；M2首次401/400差异保留事实，独立复跑未复现，不宣称根因已修。详见 [本轮验证](verification/2026-10-26-booking-lifecycle.md)。新增变更仍未人工体验、提交或推送；完整执行证据与后续修复由本轮验证记录确认。
