# 员工手机号查询

0.4.6 提供常用工具 `feishu_get_user_phone`，按当前用户身份读取获准访问的员工手机号。它是受控的人员查询流程，不提供任意 API 代理或通讯录批量导出；入口可发现不代表应用权限、用户授权和可见范围已经满足。

## 输入与人员确认

以下两种输入必须且只能选择一种：

| 参数 | 用法 |
| --- | --- |
| `query` | 员工姓名或邮箱，例如 `alex@example.com` |
| `userId` | 已经明确确认的本应用 `open_id`；不是邮箱、union_id 或企业 user_id |

姓名/邮箱查询先通过官方 CLI 的 `contact +search-user` 解析人员，确认唯一且搜索完整后读取详情。同名、多条候选或搜索不完整时，只返回候选供确认，不自动选第一人，也不逐一读取候选手机号；`has_more` 不能被当成全部结果已读完。搜索结果中的 ID 仍须与用户要查询的人匹配。[官方 CLI 1.0.95 搜索实现](https://github.com/larksuite/cli/blob/v1.0.95/shortcuts/contact/contact_search_user.go)

`open_id` 属于特定应用，不能复用另一个部署或本地 CLI 应用查询出来的 ID。使用 `userId` 可直接查询已确认人员，不需要再次按姓名搜索。

## 结果处理

| `status` | 含义与处理 |
| --- | --- |
| `phone_returned` | 接口返回非空手机号，原样展示；保留掩码，不补齐数字或推算国家码 |
| `phone_not_visible` | 接口明确返回 `mobile_visible=false`，不展示手机号，即使上游同时带有 `mobile` 字段 |
| `phone_not_returned` | 手机号字段缺失或为空；不据此推断缺权限、未填写、隐藏或不存在 |
| `needs_disambiguation` | 有多个候选或搜索不完整，只列候选供确认，不读取候选手机号 |
| `no_matching_user` | 本次完整搜索没有返回匹配项，不等于该员工不存在 |

未得到号码时不改用 bot 身份或其他应用绕过当前用户的权限和可见范围。只有明确的权限错误才按错误证据说明缺权限，不能从空字段反推。

手机号详情使用固定的获取单个用户接口 `GET /open-apis/contact/v3/users/:user_id`，按 `open_id` 和用户身份访问。接口权限与手机号字段权限分别生效；用户身份还受本人组织架构可见范围限制。[官方获取单个用户信息](https://open.feishu.cn/document/server-docs/contact-v3/user/get)

## 最小权限

可导入的独立目标清单见 [contact-phone-permissions.json](contact-phone-permissions.json)，其中 `tenant` 为空，`user` 包含：

| Scope | 用途 |
| --- | --- |
| `contact:user:search` | 姓名/邮箱解析人员 |
| `contact:contact.base:readonly` | 获取单个用户信息的基础接口权限 |
| `contact:user.phone:readonly` | 返回手机号字段 |

已有的 `contact:user.base:readonly` 是姓名等基本资料字段权限，不能替代 `contact:contact.base:readonly`。这份清单是新增能力的目标配置，既不是当前实例已获批权限证明，也不会自动改变现有 first-use/native 权限清单或用户令牌。[官方接口和字段权限说明](https://open.feishu.cn/document/server-docs/contact-v3/user/get)

## 启用步骤

1. 核对当前部署使用的飞书应用 `app_id`。本地 CLI、另一家企业或另一套部署的应用审批和用户授权不会自动适用于本部署。
2. 在该应用中开通所需用户权限，优先按平台支持的开发者调试流程验证；需要正式审核时，提交后等待管理员批准并确认权限生效。代码部署和企业权限审核是不同流程。
3. 确认应用权限生效后，保留实例原有 `CONNECTOR_FEISHU_SCOPES` 的全部 scope，追加本功能缺少的上述用户权限，并按部署流程发布，使更新后的服务端配置生效。不能用这三项覆盖原有 scope。
4. 每位使用者重新连接，完成本人 OAuth 授权。既有授权流程会检测 scope 变化；企业批准不能替代用户同意，本人授权不能替代应用开通。
5. 用该应用下已确认人员实测，分别核对正确号码、候选确认、未返回号码和不可见结果。将代码发布、权限生效及真实查询分开记录。

当前没有独立的“仅给某个工具增量授权”链接。只点重新连接不会自动申请尚未写入 `CONNECTOR_FEISHU_SCOPES` 的新权限，必须先完成应用权限生效、scope 追加及配置发布，再由用户授权。

在新权限尚未生效时，不要为了预先暴露工具就扩大全局 `CONNECTOR_FEISHU_SCOPES`，以免现有用户登录被未获准的 scope 阻断。工具升级不自动修改实例授权配置；本功能沿用既有 scope 变化检测与重连流程，不新增授权机制。

## 验证范围

`node scripts/test-contact-phone.mjs` 是本地合成测试入口，不读取真实员工号码；手工路由用例位于 [task-routing.json](../plugins/feishu/evals/task-routing.json)。本地测试通过、发现新工具或确认应用开通，都不能代替真实用户授权及目标人员查询结果。

不要将实际手机号、用户令牌或公司实例配置写入公开源码、测试样例或日志。
