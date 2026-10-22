# 接口约定草案

状态：供模块负责人评审；41 个 D/M1/M2/M3 操作已实现，其他 21 个操作仍为占位（总数 62）。详见 TASK-005 身份切片方案。

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
不返回数据库原始错误、密码、令牌或签到码。请求 ID 作为关联标识，不替代认证。内部原操作者及操作事实必须保留审计。

## 时间、资源与幂等

时间为含时区 RFC3339，存储使用 timestamptz，展示按 Asia/Shanghai。区间左闭右开；M1 预约按整点小时且默认不超过 4 小时，可由政策调整。
内部命令包含 operationId UUID、递增 revision、actorId、reason；建立命令另含 roomId 与时段。相同命令重放返回原结果；相同操作 ID、不同内容拒绝；旧版本不能复活已释放占用。
ResourceEffect 的 sourceModule/sourceId、operationId、revision、state、updatedAt 必须与命令一致；返回成功前必须完成数据库提交。释放仅解除该来源，保留版本墓碑。
workflow 在同一事务保存业务意图和 outbox，提交后才调用 ResourceCoreClient。客户端一次只发一个请求，没有内置重试。超时属于结果未知，应查询来源结果或以原身份重试，不能创建新的 operationId 掩盖前次结果。

## 尚待明确与补齐

状态机、业务表、角色/数据范围、外部通知、审计汇聚、违约申诉、统计口径和审批/维修政策仍待实现或评审。提醒与超时是持久扫描/调度职责，不通过添加一个假 HTTP 成功接口冒充完成。
接口草案不覆盖所有任务书最终细节；需求基线保留全部条目。M2 默认政策已由用户于 2026-10-20 授权按推荐方案本地实现；其他未决政策保留，不作为全组已批准政策。

本轮契约细化：User bearerFormat 从草案 JWT 改为 opaque 会话；Role 增加 scope，Room 增加 restrictedToDepartment；对应类型重新生成。目录游标为最后一条 ID（最大 100 字符），limit 1～100；本轮角色/权限目录仅允许该权限具有 ALL 范围。退出要求合法 UUID Idempotency-Key，按令牌摘要撤销，重复撤销/未知但格式合法令牌返回 204，缺少令牌 401。完整会话和目录策略见 implementation/task-005-identity.md。

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
