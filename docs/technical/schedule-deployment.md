# 家庭日程部署与验收

> **2026-11-26 最新调整：** 分享图片已改为纯图片：通过 listByDate 和 getFamily 读取当前家庭数据，在客户端绘制保存。该流程不再创建 token、不调用 generateShareCode，不依赖小程序码认证权限。本轮仅修改小程序页面，重新编译/预览即可，无需为本次改动重新部署云函数。下文的小程序码认证说明仅适用于未来恢复带码图片。

2026-11-25。代码已生成，本地自动化验证不替代微信云端及真机测试。

## 部署顺序

1. 新建空集合 co_schedule、co_schedule_event、co_schedule_share、co_schedule_request、co_schedule_notify，权限均为仅管理端可读写。保留已有 co_family/co_member。不要导入示例数据。
2. 配置索引（同方向均升序，明确标注 desc 的除外）：
   - co_schedule：familyId + date + deletedAt + timeStart + _id；familyId + deletedAt + updatedAt(desc) + _id(desc)。
   - co_schedule_event：familyId + scheduleId + createdAt(desc) + _id(desc)。
   - co_schedule_share：tokenHash 唯一；familyId 普通。
   - co_schedule_request：familyId + actorOpenid + requestId 唯一；familyId 普通。请求文档另使用确定性 _id 保证幂等。
   - co_schedule_notify：status + nextAttemptAt；status + startedAt；familyId + scheduleId + status + nextAttemptAt；scheduleId + eventVersion；familyId 普通。
   - 上述集合均按 familyId 支持解散清理查询；co_family 增加 status 普通索引。
3. 上传部署 login、familyService、scheduleService（云端安装依赖），同步两个 config.json 的定时触发器与开放接口权限。现有 wx-server-sdk 依赖沿用工程版本策略，正式发布应固定已验证版本。
4. scheduleService 环境变量：SCHEDULE_TEMPLATE_ID 为真实订阅模板；SCHEDULE_TEMPLATE_FIELDS 为 JSON，例如 {"title":"thing1","time":"time2","place":"thing3"}，字段必须与申请的模板一致，示例不是通用模板。SCHEDULE_MESSAGE_STATE 默认 formal，可为体验环境配置 trial。
5. 编译并发布新增四个日程页面。二维码采用正式页面路径与32字符 scene；发布前调用可能失败，界面明确提示重试。校验实际 SDK 方法、参数及权限。
6. 使用两个家庭、两个微信账号完成下表。确认后台任务能恢复发送失败及解散清理，再发布给家人使用。

## 运行说明

- 未配置通知模板时日程仍保存，界面提示部分家人未收到通知。每个接收人须在日程页点“为自己开启变更通知”。客户端授权结果不作为服务器发送成功证据。
- 通知任务发送未知或中断超过5分钟置 unknown，不盲目重发。明确的暂时性平台错误按1/5/30分钟重试。后台任务仅做补偿，不发送每日提醒。
- 家庭解散先关闭访问，分批删除数据；数据多时返回 processing，由 familyCleanup 每分钟继续。集合必须先创建，缺失集合会使清理报错并等待下一次重试。
- 分享链接撤销通过家庭 shareEpoch；成员移除后所有旧链接失效。只读页不持久缓存数据；已发送图片无法撤回。
- 幂等记录当前随家庭保留，未配置自动过期，防止旧请求在过期后再次创建。日程软删除数据与事件保留到家庭解散。
- 日程新增/编辑调用 security.msgSecCheck，只有明确 pass 才保存；检查不可用时保留草稿并提示重试。必须部署对应开放接口权限并真机验证。既有家庭资料 checkText 仍为原项目占位，不属于本轮日程检查。

## 验收记录模板

| 场景 | 当前状态 | 真机/云端证据 |
|---|---|---|
| 新增、编辑、完成、取消、恢复、软删除 | 待真机 | 待填写 |
| 多账号共享、越权拒绝、权限变化 | 本地模拟通过，待云端 | 待填写 |
| 超时同请求重试、并发版本冲突 | 本地模拟通过，待云端事务验证 | 待填写 |
| 切换日期的旧分享响应被丢弃 | 本地通过，待真机 | 待填写 |
| 访客只读、token失效、二维码进入 | 本地模拟部分通过，待真机 | 待填写 |
| 分享图片完整文本、分页及相册拒绝授权 | 待真机 | 待填写 |
| 通知缺配置不影响保存 | 本地模拟通过 | 待填写 |
| 通知授权、真实发送、失败重试 | 待云端 | 待填写 |
| 大量记录解散、任务中断后恢复 | 待云端 | 待填写 |
| 小屏、键盘、字号、长文本、底栏安全区 | 待真机 | 待填写 |

官方接口文档访问在本次环境未成功，不能视为已核验最新平台约束。部署时核对微信官方订阅消息、内容安全和小程序码文档。

本地依赖检查发现既有 cloudfunctions/familyService/node_modules/protobufjs/dist/light/protobuf.js 文件不完整（Unexpected end of input）。此文件不是本轮修改。不要使用该本地依赖作为运行或部署依据；在微信开发者工具选择云端安装依赖。

## 小程序码错误 85412（2026-11-26 已核实）

微信官方 getUnlimitedQRCode 文档标明：85412 / personal entity not verified，个人小程序须通过主体认证后才可生成并使用小程序码。遇到此码需管理员在微信小程序后台完成主体认证；不应反复修改页面路径或重新部署。代码已单独显示准确提示，主体认证本身不能由代码修复。

官方来源：https://developers.weixin.qq.com/miniprogram/dev/server/API/qrcode-link/qr-code/api_getunlimitedqrcode.html
