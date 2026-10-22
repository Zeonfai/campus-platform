# M3 后续AI任务卡

2026-10-22主要流程已粗验，已授权初版上传准备和团队接入；在现有维修主链上完善，不从零重写，实际上传以Git记录确认。先读根/M3/M1 AGENTS、requirements M3-001～008/INT、architecture §5～8、api-contract、implementation/task-007-m3-workorders.md、apps/workflow/M3-DESIGN.md、公共契约/SDK与verification/2026-10-21-workorders.md。

## 已有实现

M3已有11操作：报修/列表详情/派单/开始/完工/验收/取消/评价、维护政策读写。workflow新增7张m3_表，包含不可变SLA政策快照、派单历史、幂等回执、审计、持久outbox与升级事件；M1三个维修来源RPC、D两个报修教室/维修人委托上下文已打通。12组真实双服务与14项SDK HTTP测试已通过，不重复实现另一套。

前端`/work-orders`已接真实API，主要流程已粗验，系统性页面/权限/异常/边界验收仍需继续；政策编辑管理页、外部真实通知与生产运维尚待完善。默认SLA响应24h/维修48h/验收24h，政策版本冻结，stage+round去重持久保存接收人；详情中的升级事件不等于邮件/微信等已投递。

## 业务与安全不变量

NEW→ASSIGNED→BLOCK_PENDING→IN_REPAIR→AWAITING_ACCEPTANCE→RELEASE_PENDING→CLOSED。仅当前指派且有效维修人开始/完工；真实来源ACTIVE确认后才维修中。完工仍封锁，验收人有管理权限且不能是实际维修人；拒绝回维修，通过并确认RELEASED后才关闭。报告人有rate权限可关闭后一次1～5分评分。

取消仅NEW/ASSIGNED且封锁意图尚未发出；本人取消也须有效cancel SELF/教室范围，其他人须管理范围。不得借取消跳过验收。报修公共教室可以跨院系，但dispatch/repair/accept/管理取消的DEPARTMENT仅匹配非空教室归属；MANAGED_ROOMS/ALL来自当前动作权限，不能借其他权限扩权。core和workflow必须一致。

维修使用真实开始时间、无固定终点，不套个人整点/4小时限制。保留旧个人/M2记录，新分配封锁，多工单各自来源；验收一张不能覆盖其他。M1本人记录maintenanceAffected提示不是主动通知，当前需人工联系。

D上下文走服务与原用户双身份HTTP；workflow验证本人/指派/步骤等业务事实，禁止跨库/直接写M1。教室院系保存工作流事实，未来D归属写接口需另外设计重授权/同步，不能假定自动更新。

状态、审计、回执/outbox同事务，HTTP在外；固定operationId/封锁时间、revision，租约+leaseToken/业务版本fence。未知BLOCK_PENDING重试原意图，不能换ID重新开始。明确建立失败保留原失败，当前有效指派人可另行start建立更高版本新意图。释放未知持续RELEASE_PENDING，永久失权保留syncError，恢复资格再补偿；不能换actor绕权或假报CLOSED。

用户bearer不落库/outbox/日志。`pnpm dev`只注入独立进程M2/M3身份，不改.env，生产必须正式配置；环境变化按授权边界执行。

## 后续切片

- 真实浏览器验收报修/派单/维修/验收/评价、范围变更及同步失败显示，修复实际问题；构建通过不能代替人验。
- 增加SLA政策管理编辑页和必要引导，保留expectedRevision/历史快照。
- 与D接真实通知渠道、收件授权/去重/投递失败与告警；不重复写一套D通知逻辑。
- 完善释放待处理/资格失效和outbox积压的运维指引；安全兜底和未来主数据变化需明确责任与验收，不能弱化权限只为测试变绿。
- 新变更追加迁移和行为测试，运行`test:workorders`及相关身份/预约/M2回归，数据入口`test:workorders:data`。是否实际通过以记录为准。

验收仍用真实PostgreSQL与HTTP、自己随机样本定向清理。保留原历史记录与64条重建ID，不伪造全组批准、人验、Git或云交付。
