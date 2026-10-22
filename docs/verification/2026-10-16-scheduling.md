# 资源调度验证记录

日期：2026-10-16。待人工评审，无提交/MR、无 CI 或发布结论。

## 实际验证

- pnpm check：结构 57 个操作、17 个实现/40 个占位，零警告 lint、全部类型与构建、8 项真实 HTTP 客户端行为测试、两服务临时运行检查通过。
- pnpm test:scheduling：7 组真实 PostgreSQL/HTTP 验证，包含时区/整点/时长/开放规则、停用、院系/权限、插座、本人记录、公开写幂等、6 路抢座、相邻区间、数据库排斥约束 SQLSTATE 23P01、持有教室锁等待、5 轮个人与整室并发、操作指纹/旧版本/释放先到、来源查询 SDK、实时委托身份及双凭据校验、持久失败和重启后状态。
- pnpm test:identity:data：core 3 条版本化 SQL 在新建空 schema 重放（19 张表）；迁移、基础及演示 seed 重复执行，已有数据/密码文件摘要不变。测试只删除自己新建的临时 schema。
- pnpm test:database：实际账号隔离、迁移文件 checksum、就绪检查通过。
- 本地新增 `20261016000100_m1_scheduling`，已执行历史迁移保持不变。新增 btree_gist 使用镜像内置的 PostgreSQL 扩展，没有下载系统包。

## 共享教室锁的故意破坏证据

先运行真实 HTTP 锁探针通过：测试连接持有教室 advisory lock 时，预约必须等待；释放后才成功。随后只在已构建文件中将 `room:` 锁命名空间临时改错，再执行同一探针，预约提前返回导致预期失败。finally 恢复原始构建字节，恢复后的探针再次通过。没有修改源码、全局配置或应用数据；样本与进程自动清理。

破坏后退出码：1

```text
node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: Reservation must wait for the exact shared room lock

true !== false

    at sharedRoomLockProbe (file:///home/zeonfai/projects/campus-platform/tools/test-scheduling.mjs:251:12)
    at async file:///home/zeonfai/projects/campus-platform/tools/test-scheduling.mjs:275:5 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: true,
  expected: false,
  operator: 'strictEqual',
  diff: 'simple'
}

Node.js v24.22.0
```

## 证明边界

这证明核心服务的真实预约/调度及服务 HTTP 客户端，不冒充 workflow 已完成的审批/outbox 链路。维修来源由测试夹具预置，用于证明 M2 释放不会覆盖它；M3 HTTP 业务仍为 501。提醒/签到/违约/统计、D 管理写接口、通知、云端、CI 和浏览器人工交互验收仍待完成。持久 M2/M3 服务凭据没有写入本地 .env；测试使用仅随进程存在的随机凭据。

最终复核追加：并发 5 路可用性查询返回 200，候选读取已复用原事务连接，避免连接池耗尽；应用、Prisma 配置与两服务种子脚本全部纳入严格类型检查。最终 check、test:scheduling、test:identity、test:identity:data、test:database 均通过。
