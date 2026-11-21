# 云数据库初始化说明

> **工程已推倒重建（2026-11-21）**：旧点菜代码全部删除，从零按需求 V3.7「地基先行」重建。当前工程只有**身份地基**（2 云函数 + 2 页面），点菜/清单是第 2/3 步。
> **执行清单见项目根目录**：《第1步-身份地基执行清单.md》（当前）、《第2步-点菜接入地基执行清单.md》（后续）。本文件只讲数据库本身。
> **基准**：需求 V3.10 / 技术设计 v2.1。

## 第 1 步：地基两张表（当前）

云开发控制台 → 数据库 → 新建 2 个集合，**空集合、不导入样例**，读写全走云函数、前端不直连：

| 集合 | 用途 | 字段结构参考 | 初始数据 |
|---|---|---|---|
| `co_family` | 家庭实体（名称/邀请码/创建人） | `co_family.json` | ❌ 空，运行时建家庭生成 |
| `co_member` | 成员归属（一人多家庭，按 familyId 隔离） | `co_member.json` | ❌ 空，运行时生成 |

> `co_*.json` 仅用于查看字段结构，**不要导入**。

### V3.8 真头像（新增，无需建表）
- `co_member.avatarUrl` 为**可空字段**，运行时由云函数写入，**不用手动加字段**（云数据库无 schema，直接写）。
- 头像文件存**云存储** `avatars/` 目录：前端 `wx.cloud.uploadFile` 上传临时图拿到持久 `fileID`（临时链接会过期，必须转存），再由 `familyService.updateAvatar` 按 openid 写入该用户**全部家庭**的 `avatarUrl`。
- 云存储 `avatars/` 权限设「仅创建者可读写」或「所有用户可读、仅创建者可写」均可——`fileID` 在 `<image src>` 里由微信按登录态解析，自用规模无并发冲突。成员列表优先显示真头像，空值用固定色 emoji 兜底。

### V3.9 真昵称（新增，无需建表）
- `co_member.nickName` 为**可空字段**，运行时由云函数写入，**不用手动加字段**。
- 前端在家庭页「编辑我的资料」浮层里用 `<input type="nickname">`（微信官方能力：点输入框可一键填微信昵称、也能手动改）拿到昵称，`familyService.updateProfile` 先走 `checkText()` 内容安全预埋再按 openid 写入该用户**全部家庭**的 `nickName`（与头像一样跨家庭共用、写前校验长度 ≤20）。
- 昵称存**云数据库**（不像头像存云存储），无需配存储权限；成员列表显示真昵称，空值兜底"家人"，admin 移除成员时用它辨识是谁。

### V3.10 解散家庭（新增，无需建表）
- `familyService.dissolveFamily`：仅 admin、且家庭内除自己外**无其他 active 成员**时才允许（有则报 `OTHER_MEMBERS_EXIST`，须先移除）。
- 解散用**事务原子删除** `co_family` 文档 + 该家庭全部 `co_member` 记录（含 removed 历史），两集合都无残留。注意：微信云开发事务不支持 `where` 批量操作，代码先查出全部 `_id` 再逐条 `doc().remove()`。
- 解散后前端强制重登覆盖本地缓存：有其他家庭自动切到第一个，无家庭则回身份引导页。头像云存储 `avatars/` 文件不随解散删除（跨家庭共用，避免误删其他家庭仍在用的头像）。

### 索引（控制台 → 集合 → 索引 → 新建）

| 集合 | 索引字段 | 类型 | 说明 |
|---|---|---|---|
| `co_member` | `openid` + `familyId` | **复合唯一** | 一人多家庭、防同家庭重复加入（核心，别省） |
| `co_member` | `familyId` + `status` | 复合普通 | 成员列表查询 |
| `co_member` | `openid` + `status` | 复合普通 | 登录反查家庭列表 |
| `co_family` | `inviteCode` | 普通 | 加入时反查家庭 |

### 第 1 步云函数（2 个）

`cloudfunctions` → 逐个右键「上传并部署：云端安装依赖」：

| 云函数 | 作用 |
|---|---|
| `login` | 静默 openid → 家庭列表 + 当前家庭，兼容 `member` 字段；孤儿成员记录自动清理 |
| `familyService` | 建家庭/加入/成员管理/头像昵称/解散家庭（10 个 action），双参数归属校验，入口动作例外 |

> 头像昵称均为可空字段、运行时写入，无需预先建表或加字段。昵称写入走 `checkText()` 预埋（本期直通、提审接内容安全 API）。

## 第 2 步及以后（点菜重建时再建，现在不用建）

下面 8 张 `dish_*` 表是**第 2 步点菜重建**时用的，本步可不建。`dish_dishes` / `dish_staples` / `dish_ing_zone` / `dish_meta` 有可导入样例；`dish_members` / `dish_wishes` / `dish_menu` / `dish_buy_progress` 由云函数运行时写入，样例文件仅看字段（`REPLACE_WITH_*` / `home-default` 是占位符，**不要导入**）。

- `dish_menu` / `dish_wishes` / `dish_buy_progress` 已按需求带 `familyId`（第 2 步接入时填真实家庭 ID）。
- 索引建议：`dish_members` openid（唯一）；`dish_wishes` date+dishId；`dish_menu` date；`dish_buy_progress` date+itemKey。

## 权限

所有集合统一设为「仅管理端可读写」，读写全部走云函数，前端不直连数据库。
