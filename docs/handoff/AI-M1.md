# 给 M1 负责人的 AI 任务卡

2026-10-25：M1现有16个接口均已有实现代码；本轮新增签到生命周期与管理页面已通过pnpm check、扩展后生命周期9组、数据库/身份/调度、M2独立复跑8组与M3回归12组，错码守卫破坏红/恢复绿；首次M2差异未复现，事实保留，不宣称根因已修。详见 [本轮验证](../verification/2026-10-26-booking-lifecycle.md)。人工体验待完成，未提交/推送。原初版已于10月22日粗验主要流程并推送74822b9，不能用原版人验替代本轮。

先读根与模块AGENTS、requirements中M1-001～012、architecture §5/7、api-contract，以及implementation/task-009-booking-lifecycle.md（TASK-009）。历史test-scheduling/test-workorders结果仅作已有边界证据。

SchedulingService仍是唯一资源分配入口。reserve/cancel/list/get/available、M2/M3各三个来源接口，以及checkIn/repeatBooking/getRoomCheckInCode/listResourceReasons/bookingStatistics已有代码。页面为BookingPage.vue与OperationsPage.vue；D通知页为NotificationsPage.vue。个人/M2既有记录保留，多工单各释放自身，不能把提示或站内消息当外部投递。

本轮简单默认：未来整点预约、默认最多4小时、仅本人历史与取消、开始前取消；签到[-15min,+15min)，每日每教室码仅授权管理显示端可取。默认-15/+10分钟站内提醒、+15未签自动取消并记录一次违约，不自动封禁；提前提醒0表示关闭。旧预约不追溯处罚，资源停用或签到窗口内受维修影响免罚，使用首次releasedAt且重复释放不延后。新预约冻结政策快照；再次预约重查原座位新时段；统计代理预约时长，不声称真实在座。具体边界以本轮方案为准，不写成全组共识。

M1-T02现阶段已完成本轮自动验证，重点是组织页面体验，再按反馈调整需求；不能重新从零实现签到或将已有代码计作新贡献。后续申诉、公平策略、外部通知接入与运营完善仍单列待办。

允许修改本模块、页面和测试；公共契约/Prisma/权限协调后改，迁移只追加。所有分配、签到、超时与资源变更竞争相同room事务锁；写入保留用户作用域幂等和历史收据，网络不进数据库事务。后台持久扫描轮转处理，失败不抹去事实；不能用页面计时器替代。

验收覆盖本人/越权、当前/旧/跨室码、窗口边界、错误码持久限流、签到与超时竞态、重启补扫/消息去重、免罚与统计口径、再预约冲突及来源分页。按影响顺序运行check和identity/scheduling/M2/M3回归，不与dev/watch同时写dist；保留关键分支破坏失败证据，实际结果另记。
