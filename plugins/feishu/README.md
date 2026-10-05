# 飞书 AI 连接器插件包

本目录是 **0.4.5 通用源模板**，包含四个定制领域 Skills；MCP 列表故意留空，不会连接任何现有企业实例。配置好部署后运行 `node scripts/generate-deployment-plugin.mjs`，安装生成的 `deployment/generated/plugins/feishu/` 副本，不能直接把本目录当成已配置的连接器。部署配置与生成步骤见 [部署说明](../../deployment/README.md)。

生成或连接 MCP 不会自动安装这四个 Skills；文件创建、编译和协议测试通过也不代表宿主已完成安装或激活。线上能力以实际工具发现和后端验收为准。

0.4.5 服务端可选启用 `chatgpt_confidential` OAuth 客户端。客户端密钥须在宿主的私有 OAuth 设置中单独配置，不进入此模板或生成包；旧连接需要重新授权才会迁移。刷新令牌最多 30 天有效，不随使用顺延，实际部署与连接状态需另行验证。详见 [OAuth 刷新策略](../../deployment/oauth-refresh.md)。

## 文件与加载

- `plugin.json`：当前可移植插件清单。
- `mcp.json`：源模板为空；生成包会写入本部署的 Streamable HTTP MCP 地址，不含 token 或 secret。
- `skills/`：消息、文档、邮箱和原生长尾能力的策略与证据核验。成功安装此包的兼容宿主才会按名称、描述和当前意图按需加载。
- `.codex-plugin/plugin.json`、`.mcp.json`：旧客户端兼容清单/配置。可移植宿主以 root manifest、`mcp.json` 和 `skills/` 为准。

当前连接层采用 **10 个常用工具 + 4 个原生工具**，另保留 3 个兼容入口，共 17 个 MCP 工具。常用工具直接提供强参数 schema，不要求先读 catalog。服务端承担链接与 ID 解析、正文补全、有限分页及权限校验。官方 CLI 内置 Skills 可通过 `feishu_skill_read` 按需读取；这是工具返回的官方指导内容，不等于把本目录的四个定制 Skills 安装进 ChatGPT。长尾操作先查单项 native schema，不向工具列表塞全部技能或接口全文。

10 个常用入口：`feishu_search_messages`、`feishu_read_message_context`、`feishu_search_documents`、`feishu_read_document`、`feishu_find_people`、`feishu_search_mail`、`feishu_read_mail`、`feishu_create_mail_draft`、`feishu_send_mail_draft`、`feishu_download_attachment`。它们只在启用固定 CLI 且运行检查通过、注入对应服务端执行器后注册。

原生能力组为 `feishu_skill_read`、`feishu_native_catalog`、`feishu_native_read`、`feishu_native_write`，同样只在注入真实执行器后注册。原生写入须按官方 schema 和风险信息再次检查，不能把任意命令当作原生能力。旧版 36 个操作继续通过兼容入口提供。

原生目录可发现 CLI 1.0.95 的 818 个入口（251 个 API、532 个快捷命令、35 个辅助命令）。这不是 818 项全部可执行或已验收的声明；先查精确条目的 `availability` 与参数 schema。宿主配置与凭据、持续进程、仅 bot 身份等仍受限制。

## 附件与客户端文件

- `feishu_download_attachment` 的 `source` 支持 `mail`、`message`、`drive`、`docx`；文件标识取自搜索或读取结果。取得链接不等于已阅读附件。
- 邮件返回飞书官方临时链接与 `downloaded:false`；失败 ID 会单独列出，不能把部分成功当成全部成功。
- 其他文件返回元数据、`resource_link` 和 15 分钟有效的下载链接。后端加密临时存储文件，每次下载检查原账号/Grant/Consent 及撤销状态；链接是有效期内持有者可用的 bearer 凭证，不应公开转发。
- 原生读写工具接受顶层 `files`：每项必填 `download_url`、`file_id`，可选 `mime_type`、`file_name`，由客户端文件引用提供。参数引用 `input/<file_name>`；无名称时依次为 `input/file-1.bin`。不要把宿主 `file_id` 当作飞书文件 token，也不要传本机绝对路径。
- 单文件 10 MiB、每次文件合计 20 MiB、最多 20 件，CLI 运行上限 25 秒。慢速导出可能未完成，不自动重复创建任务。发送和上传附件仍须明确用户指令。

完整参数和交付合同见 [连接层说明](../../docs/native-cli-bridge.md)。客户端是否直接预览或分析文件须实际验证，不能仅凭 `resource_link` 就宣称读过文件。

## 个人网页版与分发边界

仅在个人网页版 ChatGPT 添加 MCP URL 并完成 OAuth，会建立远程工具连接，**不会自动加载仓库的 `skills/` 目录**。截至 2026-09-18，已核查的官方文档没有提供个人网页版私有上传 ZIP 或导入 GitHub 完整插件包的安装入口；不能把本地 marketplace 安装步骤当成云端安装步骤。[官方技能分发边界](https://learn.chatgpt.com/docs/build-skills)

本目录含 `mcp.json` / `.mcp.json` 的完整包主要供兼容桌面宿主安装和测试。官方工作区导入规则会把声明原始 MCP 配置的包标为 **Desktop only**，即使服务器使用远程 HTTPS。[工作区插件管理](https://learn.chatgpt.com/docs/enterprise/plugin-management)

官方有据可查的云端分发路径是：

- **工作区私有分发**：由管理员进入 `Admin → Plugins → Add → Import marketplace`，从 GitHub 导入；云端连接使用 `.app.json` 引用已注册应用，并在清单声明 `apps`。必须使用真实应用 ID（例如 `asdk_app_...`），不能编造，也不能拿 `plugin_...` ID 代替。本目录尚未生成此分发变体。[工作区导入与应用引用](https://learn.chatgpt.com/docs/enterprise/plugin-management)
- **个人开发者公开分发**：完成 API Platform 个人身份验证，在 [插件提交入口](https://platform.openai.com/plugins) 选择 `Create plugin → With MCP`，在 Skills 页上传技能包，经过审核并公开发布后再从 ChatGPT Plugins 安装。此路线支持个人开发者，不以 ChatGPT 企业工作区为前提；它不是个人私有 ZIP 安装入口。本次未提交或发布。[官方提交流程](https://developers.openai.com/plugins/deploy/submission)

当前包包含 MCP 配置，不能直接作为 `Skills only` ZIP 提交；组合插件应走 `With MCP` 流程。[提交格式限制](https://developers.openai.com/plugins/deploy/submission-errors)

## 安装后验收

实际完成支持的插件安装后，在新会话中确认：插件元数据可见，领域 Skill 能被按需加载，具名工具存在，OAuth 绑定当前用户，工具结果具有真实来源与分页边界。当前不得把仅连接 MCP 的会话记为此 Skills 包已激活。

路由验收可使用 [任务用例](evals/task-routing.json)：明确常见任务不调用 catalog，消息检索一次业务调用、文档发现加阅读通常两次；歧义或继续读取除外。所有未读完结果必须说明限制，所有写入必须保留当前用户的明确意图。

## 格式依据

- [OpenAI 插件打包规范](https://developers.openai.com/plugins/build/plugins)
- [Skills 按需加载](https://developers.openai.com/plugins/concepts/skills)
- [插件与 MCP 职责](https://developers.openai.com/plugins/concepts/plugins)

本地验证：运行 `node scripts/test-feishu-task-tools.mjs`；插件兼容清单由 plugin-creator 的 `validate_plugin.py` 校验。协议测试使用注入式测试执行器，不访问真实飞书数据，不发送邮件。
