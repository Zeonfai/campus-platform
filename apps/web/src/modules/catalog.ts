export const modules = {
  m1: {
    name: '自习座位',
    service: 'resource-core',
    description: '查询、预约、签到和使用记录',
    tasks: [
      '按时间、院系和插座查询',
      '预约与取消、并发资源校验',
      '每日教室码签到',
      '提醒、违约、历史和统计',
    ],
  },
  m2: {
    name: '整室申请',
    service: 'workflow',
    description: '整教室申请、多级审批和资源同步',
    tasks: ['申请资格与本人记录', '多级审批与意见', 'HTTP 占用与授权释放', '超时撤销、重试和对账'],
  },
  m3: {
    name: '物业报修',
    service: 'workflow',
    description: '报修、派单、维修和验收',
    tasks: ['故障上报与授权派单', '确认封锁后开始维修', '升级、验收与评价', '按工单来源恢复可用性'],
  },
  d: {
    name: '公共管理',
    service: 'resource-core',
    description: '身份权限、空间主数据、通知和审计',
    tasks: [
      '登录与会话、可配置权限',
      '院系、教室、座位和开放规则',
      '通知与外部提醒渠道',
      '数据范围及审计查询',
    ],
  },
} as const;

export type ModuleKey = keyof typeof modules;
