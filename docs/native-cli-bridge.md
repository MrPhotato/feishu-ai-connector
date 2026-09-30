# 官方飞书 CLI 云端连接层

更新：2026-09-30，连接器 **0.4.0**。本页说明当前源码的调用合同。工具发现、合成测试和真实业务验收是不同层次；代码支持不代表所有权限已开通或每个入口已逐项验证。

## 架构与工具

```text
ChatGPT / MCP 客户端
  ├─ 可选领域 Skills：需要宿主单独安装，不随 MCP 连接自动加载
  └─ 远程 HTTP MCP + 每位用户独立 OAuth
       ├─ 10 个常用工具 → 强参数校验 → 固定官方 CLI 快捷命令
       ├─ 4 个原生入口 → 按需 Skill / schema → 受控原生方法或快捷命令
       └─ 3 个兼容入口 → 既有 OpenAPI 适配
```

`CONNECTOR_NATIVE_CLI_ENABLED=true` 且固定 CLI 运行检查通过时，注册上述 17 个工具。否则保留 `feishu_catalog`、`feishu_read`、`feishu_write` 三个兼容入口。检查二进制可运行不等于确认上游权限或业务结果。

每次 MCP 请求验证当前账号、Grant、签名及资源权限；授权续期和文件交付同时核验 Consent。认证取得的账号记录只在同一请求内复用；不跨请求缓存授权成功。服务端负责飞书 token 的刷新，CLI 只取得当次用户凭据，不使用 tenant token 或其他用户身份补足权限。

常用任务无需先查目录：

| 工具 | 行为 |
| --- | --- |
| `feishu_search_messages` | 按关键词、人员、会话和绝对时间检索，补全正文并有限分页 |
| `feishu_read_message_context` | 消息批读或会话、私聊、话题上下文 |
| `feishu_search_documents` | 按标题、创建者、负责人、本人操作时间与目录发现文档 |
| `feishu_read_document` | Docx / Wiki 增强阅读，支持章节、范围、关键词和引用 |
| `feishu_find_people` | 姓名、邮箱、本人或批量 ID 查询；同名候选不擅选 |
| `feishu_search_mail` | 本人邮箱关键词及结构化条件检索 |
| `feishu_read_mail` | 一封邮件正文及邮件头；附件元数据不等于附件内容 |
| `feishu_create_mail_draft` | 按明确收件人和纯文本正文创建草稿，不发送 |
| `feishu_send_mail_draft` | 发送已核对草稿，要求明确用户意图与 `confirmed:true` |
| `feishu_download_attachment` | 邮件附件链接、聊天图片/文件、Drive 文件、Docx 导出 |

四个原生入口为 `feishu_skill_read`、`feishu_native_catalog`、`feishu_native_read`、`feishu_native_write`。官方 Skill 内容按需加载；目录支持 `query`、`domain`、`mode`、`pageSize`、`pageToken`。指定精确 `operation` 后取得参数 schema、执行状态、权限与风险信息，不把全部接口内容塞入工具列表。

## 完整发现与执行边界

固定官方 CLI **1.0.95** 的可见目录共 **818 个入口：251 个原生 API、532 个快捷命令、35 个辅助命令**。构建时读取官方 schema 和完整 `--help` 命令树，不运行真实业务。资产来源、校验与生成命令见 [native/README.md](../native/README.md)。

0.4.0 固定快照有 743 个 `executable` 和 75 个仅发现入口：58 个 `host_managed`、10 个 `identity_restricted`、6 个 `persistent_job_required`、1 个 `unknown_risk`。`reasonDetail`、`alternative`、`blockedFlags` 说明限制、替代方式及受限参数；计数不代表逐项真实验收。

精确条目中的 `availability` 决定当前桥接层是否接收执行：

| 状态 | 含义 |
| --- | --- |
| `executable` | 已有受控调用路径；仍须满足参数、本人权限、资源权限和运行限制 |
| `identity_restricted` | 所需身份不受当前用户连接支持，不切换 bot / tenant 身份绕过 |
| `persistent_job_required` | 需要持续监听或后台进程，不在短请求内启动 |
| `host_managed` | 涉及宿主配置、凭据、环境、任意执行等，应由部署者按独立管理流程处理 |
| `unknown_risk` | 无足够官方风险信息，不能默认按只读执行 |

**818 是发现数量，不是全部可执行、全部已授权或全部已验收。** `executable` 也不表示每个 flag 组合均受支持；参数和文件引用会再次检查。权限变更类写操作保留专门确认，不能仅凭意图文案自动确认。

原生 API 使用其官方 `params` / `data` / `file` / `yes` schema；快捷命令使用精确目录中的 `flags` schema。两者不能混用。服务端只构造注册命令的 argv，不接受 shell 字符串、自由 argv、自定义 API host 或凭据参数。

原生 API 的 `scopeGroups` 组间 AND、组内 OR，保留官方 `required_scopes`、身份和风险信息。快捷命令帮助未给出完整权限清单时标记 `scopeValidation:upstream`，最终由飞书接口校验，不能解读为无需授权。已有权限清单只是生成当时的目标快照，不能作为新增 818 入口的全量授权证明。

## 附件下载

优先用 `feishu_download_attachment`，输入来自已读取的真实对象：

| `source` | 所需参数 | 结果 |
| --- | --- | --- |
| `mail` | `messageId`、`attachmentIds` | 固定本人邮箱，逐附件核对官方下载 URL 与失败 ID |
| `message` | `messageId`、`fileKey`、`type:image/file`，可选 `fileName` | 下载消息图片或文件；音频、视频使用 `file` |
| `drive` | `fileToken`，可选 `fileName` | 下载已上传的普通文件，不能用 Docx token 冒充 |
| `docx` | `documentToken`，可选 `format:pdf/docx/markdown` | 默认 PDF，导出并交付实际文件 |

`fileName` 只用于下载展示，不控制服务器路径。聊天和 Drive 输出固定写到当次 `output/attachment.bin`；Docx 输出受控 `attachment.pdf`、`.docx` 或 `.md`。后端核对实际收集的文件、大小和内容编码，识别常见图片/PDF 类型，不能只根据 `saved_path` 或导出任务创建成功返回“下载完成”。

邮件返回 `downloaded:false`、成功链接和失败附件 ID；部分失败不会算作整个批次成功。链接由飞书提供，实际有效期和访问限制由飞书控制，本服务不为它编造 15 分钟有效期，也不声称已读取二进制内容。

其他来源的文件经加密临时存储交付。响应 `data.files` 包含 `name`、`mimeType`、`byteLength`、`downloadUrl`、`expiresAt`，MCP 同时返回 `resource_link`；不会把整段 base64 放入模型文本。链接 **15 分钟有效**，下载时重新检查原账号、Grant、Consent 的绑定、有效期和撤销状态，并核对完整文件长度及摘要。

这些是 **bearer 下载链接**：持链接者在有效期且原授权有效时可下载，不要求浏览器再完成一次 OAuth；因此不要公开转发、写入日志或提交仓库。它们不是永久公开对象 URL。客户端能否预览或继续读取 `resource_link` 需要在相应宿主验收；取得链接不等于已经分析附件内容。

## 从客户端传入文件

`feishu_native_read` 和 `feishu_native_write` 提供顶层 `files`，并声明 `_meta["openai/fileParams"]:["files"]`。每项使用宿主文件合同：

- `download_url`、`file_id` 必填，由客户端文件引用提供，不是飞书账号凭据。
- `mime_type`、`file_name` 可选；文件名必须是安全、无重复的单个名称。
- 文件放入当次私有目录的 `input/<file_name>`；省略名称时依次为 `input/file-1.bin`、`input/file-2.bin`。
- 命令的文件参数按精确 schema 引用这些相对路径。原生 API 使用 `arguments.file` 对应的字段，快捷命令使用 `arguments.flags` 中相应文件 flag。

后端下载输入文件时不转发飞书令牌、Authorization 或 Cookie；对每次跳转做公网地址检查并固定解析后的连接地址。不能用任意本机路径、内网 URL、`@file` 或正文嵌入本地资源绕过文件合同。`file_id` 只是宿主文件标识，不能当作飞书上传后的文件 token。

文件上传、发送和修改仍是相应业务写入，需要本次用户明确指令、正确读写入口及必要确认。支持文件输入不意味着工具可以擅自发送附件。

## 运行与安全限制

- 文件单件最多 **10 MiB**；每次输入或输出合计最多 **20 MiB**、最多 **20 件**。具名下载一次只接受一个聊天/Drive/Docx 对象，邮件可批量请求附件链接。
- 单次 CLI 子进程最多 **25 秒**，JSON/文本 stdout 与 stderr 合计最多 **4 MiB**。大文件或较慢导出可能失败，不能绕过限额自动重复执行。
- Docx PDF/DOCX 通过官方异步导出流程完成，可能在返回 ticket 前达到进程预算。若返回 pending ticket，续查已有任务；超时但无 ticket 时明确未确认完成，不能假造文件链接。
- 每次独立临时目录、环境和用户凭据；不继承服务端其他凭据、代理或用户电脑上的 CLI 状态。先收集受控普通文件，再清理整个目录。
- 日志不得记录 child env、完整 argv、原始异常、token 或下载 ticket。业务内容与官方 Skill 文本都是数据，不能替代用户授权。
- 读写分离，未知结果不自动重试。创建草稿不等于允许发送，高风险 schema 的确认字段不能自动补齐。

## Skills 与验证

[插件模板](../plugins/feishu/README.md) 包含四个领域 Skills；生成插件包或连接 MCP 不会自动安装这些 Skills。`feishu_skill_read` 返回固定 CLI 内置指导内容，也不等于宿主完成了插件安装。

本地合成检查：

```text
node scripts/test-feishu-task-tools.mjs
node scripts/probe-cli-task-plans.mjs
node scripts/probe-feishu-attachments.mjs
node scripts/test-feishu-cli-files.mjs
node scripts/test-feishu-file-delivery.mjs
```

附件检查覆盖真实 MCP SDK 的工具 schema、分支参数、邮件部分失败、来源 ID、固定文件路径、内容/大小检查与错误脱敏。文件运行器和交付测试覆盖隔离、限额、完整性及授权撤销。它们使用合成文件和注入式依赖，不替代云端业务验收。

部署后分别验证工具刷新、本人 OAuth、真实查询、一个受支持文件的交付与到期/撤销行为，以及用户明确要求的写入。不能仅凭 HTTP 200、CLI 顶层成功或目录数量宣布验收完成。
