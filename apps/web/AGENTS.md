# Web AI 上下文

先读根规则、docs/api-contract.md 和本模块后端 AGENTS.md。公共布局和路由由架构负责人协调；业务页面放入 src/modules/m1、m2、m3、d。
不将密码、服务令牌、数据库地址放入 VITE_* 或源码。浏览器只访问公开 API，禁止接入 /internal/ 调度入口。
不使用 localStorage 长期保存认证令牌；会话策略在 D 实现前评审。不能用假登录、固定成功或空数组冒充业务完成。
