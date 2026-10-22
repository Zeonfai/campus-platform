# D 前端接入

当前 LoginPage.vue 提供真实登录；session.ts 为仅内存 Pinia 会话及公开 API 请求；DirectoryPage.vue 展示后端授权的教室/座位。令牌不写浏览器持久存储，密码提交后清空，不连接内部资源接口。

后续管理页面继续放在本目录。服务端 SessionGuard/权限/范围才是授权依据，按钮隐藏不能替代后端。身份方案和验收见 docs/implementation/task-005-identity.md、docs/verification/2026-10-15-identity.md。
