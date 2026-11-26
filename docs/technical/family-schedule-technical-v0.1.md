# 家庭日程技术方案 v0.1

日期：2026-11-25。状态：实施方案，未实现、未联调。需求基准：[PRD v0.3](../prd/family-schedule-prd-v0.3.md)，冲突以其第 10 节为准。本文补足当前仓库缺失的日程技术方案，不代表已取得被其他文件引用的“技术设计 v2.1”。

## 1. 边界与调用链

沿用原生小程序、云函数、co_family/co_member。新增 scheduleService；普通读写从微信上下文获取 OPENID，再校验 familyId、家庭 active 状态与 active 成员关系。客户端不得决定身份、权限、时间戳。仅 getSharedByToken 允许无家庭成员关系访问；微信运行环境身份不等同于业务注册。

新增四个页面 schedule、edit、readonly、share，路径沿用 PRD。只读页不经过要求加入家庭的身份引导；无效 token 留在失效页。前端所有数据访问走云函数。

## 2. 数据模型

co_schedule 采用 PRD 字段，新增 note（≤200 字）、updatedBy、version（从 1 递增）、deletedAt（默认 null）、deletedBy。childName ≤20 字。日期固定 YYYY-MM-DD、时间 HH:mm，Asia/Shanghai；createdAt/updatedAt 等均为服务端毫秒时间。ownerOpenid 必须是本家庭有效成员；离开后的旧值只用于历史显示，返回 ownerUnavailable=true。

co_schedule_event：familyId、scheduleId、actorOpenid、action、fromStatus、toStatus、changedFields、createdAt、version。每次成功写入同步追加，用于详情“变更记录”；按时间倒序分页。无需把完整旧备注或地点复制进日志。

co_schedule_share：保留绑定 familyId/date/createdBy/expiresAt，存 tokenHash 而非明文 token，新增 shareEpoch。服务端安全随机生成 24 字节，base64url 编码为 32 字符；返回原始值用于分享，以 SHA-256 摘要查询。不得在日志或埋点记录原始 token。过期检查在每次请求执行，不依赖后台删除是否及时。

co_family 新增 status（active/dissolving）与 shareEpoch（默认 0）。缺失字段按 active/0 兼容。成员移除事务同时递增 shareEpoch；旧 token 永久失效，不因成员重新加入恢复。

co_schedule_request：familyId、actorOpenid、requestId、payloadHash、result、createdAt，用于写入幂等；同一 requestId 不同内容返回 IDEMPOTENCY_CONFLICT。记录至少保存 7 天，客户端未知结果重试必须复用原 requestId。

co_schedule_notify：familyId、scheduleId、eventVersion、recipientOpenid、kind、status、attempts、nextAttemptAt、lastError、createdAt。仅保存发送所需信息，查询到家庭失效或接收人已离开即终止发送。

建议索引：schedule(familyId,date,deletedAt,timeStart,_id)；event(familyId,scheduleId,createdAt,_id)；share(tokenHash 唯一)；request(familyId,actorOpenid,requestId 唯一)；notify(scheduleId,eventVersion,recipientOpenid,kind 唯一)与(status,nextAttemptAt)。索引配置与查询能力在部署环境验证。

所有新集合仅管理端可读写。只读接口采用字段白名单：家庭名、绑定日期、事项、孩子姓名、时间、地点、负责人显示名、状态、更新时间；不返回 openid、成员表、邀请码、备注、内部日志或其他日期。

## 3. 接口契约

统一成功返回业务对象，失败返回 {error:{code,message}}，兼容现有 utils/api.js。

| action | 输入（除 token 接口外均含 familyId） | 输出 |
|---|---|---|
| listByDate | date、cursor?、limit（默认20，上限50） | items、nextCursor、serverTime |
| getDetail | scheduleId | item、permissions |
| listEvents | scheduleId、cursor? | events、nextCursor |
| listRecentPlaces | 无 | 最多十个去重地点 |
| create | requestId、日期/时间/事项等允许字段 | item、notificationStatus |
| update | scheduleId、expectedVersion、requestId、允许字段 patch | item、notificationStatus |
| setStatus | scheduleId、expectedVersion、requestId、targetStatus、reason? | item、notificationStatus |
| delete | scheduleId、expectedVersion、requestId | deletedId、version、notificationStatus |
| createShareToken | date | token、expiresAt、path |
| getSharedByToken | token、cursor? | 展示字段、nextCursor、expiresAt、serverTime |
| generateShareCode | token | 临时可用的小程序码资源 |

所有 item ID 必须再次核对 familyId，不能只凭 ID 写入。分页游标绑定家庭、日期和排序键；只读游标不得改变 token 范围，每页重新验权。相同时间按 _id 稳定排序。图片在客户端 canvas 生成，云函数只负责安全生成二维码；替代原 PRD 中含混的 generateShareImage。

错误码：BAD_PARAM、NOT_MEMBER（现有兼容）、NO_PERMISSION（操作权限不足）、FAMILY_NOT_FOUND、FAMILY_DISSOLVING、NOT_FOUND、VERSION_CONFLICT、IDEMPOTENCY_CONFLICT、SHARE_INVALID、TEXT_RISK、SERVER_ERROR。成员失效清空家庭数据并刷新身份；单项操作无权仅提示并刷新权限，不能把它误判为被移出家庭。分享不存在、过期、撤销、家庭解散统一 SHARE_INVALID。

## 4. 写入、并发与权限

写入事务内重新读取家庭、调用者、负责人及目标日程，校验 PRD 权限矩阵和状态转换；写入日程、事件、幂等结果及通知任务后提交。删除为软删除，普通查询必须排除 deletedAt 非空记录。已删除日程拒绝后续编辑。

使用 expectedVersion 条件更新，版本不一致不覆盖，返回 VERSION_CONFLICT；界面保留草稿，提供查看最新内容后重新编辑。新增采用保存中状态，服务端成功后返回列表，不做首版乐观插入，避免失败回滚混乱。重复点击禁用按钮；超时标记“结果待确认”，保留 requestId，重试先返回已提交结果。

成员移除与所有日程写入必须以同一家庭记录作为事务冲突协调点（写入递增 mutationVersion），确保移除/解散与写入不会仅凭事务外旧权限交错成功。迁移需同步修改 familyService 的 removeMember/joinFamily/dissolveFamily，不能只改 scheduleService。

checkText 当前实现是放行占位，不能当作已完成检查。正式接入前核验官方内容安全接口和适用要求；失败或待审状态须有明确产品处理，不可伪称已检测通过。

## 5. 通知与分享

接收人规则严格按 PRD 第10节。通知任务与业务写入一并落库，业务成功不依赖发送成功。提交后尝试发送；短暂错误最多三次重试（约1、5、30分钟），拒绝授权或不可发送直接结束并记录原因。后台调度只处理失败任务，不发送每日定时提醒。

平台发送结果可能出现未知状态，应用侧按事件去重，但不承诺外部消息绝对只送一次；未知结果需单独记录，避免无条件重复推送。上线前核验模板字段长度、授权获取时机、可用额度/有效性以及模板 ID，使用两个真实账号验收。配置未完成时明确通知不可用。

token 在分享按钮准备阶段生成，成功后才启用微信转发入口；生成失败可重试。二维码以 token 进入 readonly，核验小程序码 scene 参数限制、发布版路径与 URL 编码。短期图片资源限制访问与保留周期；不创建公开持久相册。

只读分享允许持有链接者查看，因此移除成员时撤销全家庭旧链接，而不是只撤销该成员生成的链接。图片无法撤回，应标明生成时间和扫码查看最新。生成图片前重新拉取所有分页，保留状态和完整姓名地点；过多记录拆为多张编号图片，不缩小字号硬塞。

## 6. 缓存、清理与部署

缓存键为 familyId+date；每次请求带页面请求序号，响应仅在家庭、日期及序号均匹配时应用。切换家庭同步清空日程、详情、表单归属、地点历史与分享资源。只读 token 数据不持久缓存；普通页失去权限立即清空已有展示。

解散第一阶段事务将家庭置为 dissolving、递增 shareEpoch，所有接口立即拒绝访问和新增。第二阶段按批清理日程、事件、分享、通知、幂等及成员记录，记录清理游标与失败原因；可重试、可重复执行。最后删除家庭并报告完成。维护任务负责恢复中断清理。禁止一次性假设所有记录都能放入一个事务。

部署顺序：新集合与索引→兼容旧数据的家庭服务改动→日程云函数与配置→页面发布。上线前验证事务读写限制、批量查询与定时任务能力；本方案不假定未验证的平台额度。回退先关闭日程入口并暂停通知任务，保留数据与只读兼容，不能直接删集合。

测试覆盖 PRD 验收表及补充案例。日志只记录 requestId、action、错误码、耗时和必要内部 ID，不记录 token、姓名、详细地点或表单全文。当前所有真机、云端及部署检查均未执行。
