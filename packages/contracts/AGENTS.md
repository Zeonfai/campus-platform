# 公共契约 AI 上下文

业务 DTO 以 openapi.json 为源，通过 generate 生成 src/generated/api.ts，不手工修改生成文件。
protocol.ts 仅放稳定的通用协议；resource-client.ts 是服务调用客户端，不含业务调度规则、实体或仓储。
契约变化说明调用方、权限、失败码、幂等、版本和兼容性；相关模块负责人评审后再交接。
内部命令 actorId 仅是被委托操作者标识，服务端还必须校验可信委托来源、角色权限及数据范围。
