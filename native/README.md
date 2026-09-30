# 官方 CLI 构建资产与调用合同

固定使用官方 `@larksuite/cli` **1.0.95**，直接执行官方发布的原生二进制，不重写 CLI、无需 Go。
该版本的 `main.go` 已注册环境变量凭据扩展。此目录不包含真实授权数据。

连接器在 MCP 后端运行固定版本 CLI。目标托管环境需支持对应的原生可执行文件、网络访问和进程生命周期。
生产临时内容直接写系统临时目录，不得写只读部署目录。
本目录由构建工具读取；Nest 的运行时代码和部署资产由服务端模块维护。

## 固定版本分发

妙搭 Linux x64 构建使用仓库内 `vendor/lark-cli-1.0.95-linux-amd64.tar.gz`。
该文件是未经改动的官方 release 归档，仍校验 manifest 内 SHA256；构建无需访问 GitHub。
其他平台使用官方下载，或显式传 `--archive`。

```text
node native/prepare-cli.mjs --platform linux --arch x64 --archive native/vendor/lark-cli-1.0.95-linux-amd64.tar.gz --output server/modules/feishu-tools/assets/lark-cli
node native/prepare-cli.mjs --platform windows --arch x64 --output native/vendor/lark-cli.exe
```

`--output` 是**文件路径**。支持 linux/win32（windows 别名）、x64/arm64。
安装器只在构建期运行，官方 HTTPS release 归档下载后必须匹配
`release-manifest.json` 内固定 SHA256，再用系统 `tar` 只提取唯一可执行文件到 stdout。
`--archive <local-archive>` 可使用预先下载的归档，仍必须通过同一 SHA256 校验。
安装器不执行跨平台目标，不写入凭据。应用启动和请求路径均不得下载二进制。
部署时复制本目录的第三方许可通知；Linux 文件需保留 executable 位。

已完成的本机验证（2026-09-18）：

| 目标 | 结果 | 可执行文件 SHA256 |
|---|---|---|
| Windows x64 | 官方归档校验、提取、version/skills/schema 实际执行通过 | `403b56ab849b28b4072b46799bd898959dc55382c18d7f4e83cd65f49f570b3f` |
| Linux x64 | 官方归档校验、提取、ELF 文件格式检查通过；未在本机执行 Linux 程序 | `44356a4351f3175480a4ff0c3e19236d1ace2738aaad468c3cd1e792fa08cc33` |

下载后的验证产物在 git 忽略的 `native/test-output/`。arm64 归档有固定官方校验值，尚未实际下载验证。

## 每次调用的身份合同

运行器必须从已验证的 MCP 用户身份取得账号，用现有加密存储和刷新锁获取当前 UAT。
传入 CLI 的只有当次 `appId` 与 `accessToken`；不传 app secret、refresh token、租户 token 或磁盘配置。
`bridge-contract.ts` 是可审阅、可独立测试的环境构造参考实现。它不启动进程，不读取环境秘密。

每次创建全新私有临时目录；`cwd`、HOME/USERPROFILE、APPDATA、XDG_CONFIG_HOME、
`LARKSUITE_CLI_CONFIG_DIR` 均隔离到该目录。子进程环境从空对象构造，只允许必需 Windows
SystemRoot/WINDIR，不继承 PATH、代理、CLI profile、auth proxy、CA 重写或 Node 注入选项。

固定变量：

```text
LARKSUITE_CLI_APP_ID=<当次应用 ID>
LARKSUITE_CLI_USER_ACCESS_TOKEN=<当次 UAT，只存在内存与子进程环境>
LARKSUITE_CLI_BRAND=feishu
LARKSUITE_CLI_DEFAULT_AS=user
LARKSUITE_CLI_STRICT_MODE=user
LARKSUITE_CLI_CONFIG_DIR=<独立临时目录>/lark-config
```

官方 env provider 在缺少 token/appId 时阻断；选中该来源后 token 解析不回退到其他来源。
env provider 会请求 `user_info` 验证 UAT/取得用户身份，因此一次 CLI 调用可能多一次上游请求。
该 provider 的 `Token.Scopes` 为空，**不能依赖 CLI 的本地 scope 预检**。服务端必须先检查实际
UAT scopes；飞书仍会执行应用资格及资源权限检查。CLI 不拥有此连接的刷新职责。

严禁输出或记录 child env、完整 argv、stdout/stderr 的原始异常对象。
argv 只由注册的结构化操作构造，`spawn`/`execFile` 使用固定绝对二进制路径、`shell:false`。
文本参数采用独立 argv 或 `--flag=value`，不拼 shell；阻止自由 argv、任意 API URL、
凭据和宿主配置修改、持续监听进程，以及任意本地文件路径。目录中的受支持短任务按精确 schema 执行；
不能仅因属于某个业务域，就把该域全部命令视为已开放。
文件输入只允许本次 `files` 映射出的 `input/<name>`，输出只收集私有 `output/` 中通过检查的普通文件；
不得使用符号链接、硬链接、路径穿越或引用隔离目录之外的内容。非文件参数也不能通过 `@file` 绕过文件合同。
含 HTML 的官方写信快捷命令支持自动读取本地图片，因此还必须限制正文中的本地引用，并维持空的私有 cwd。
超时、输出上限和异常必须失败关闭；写入结果不确定时不能自动重试。父进程等待 child 退出后清理独立目录。

## 官方技能与低频业务 API

1.0.95 已内置 `skills list` 与 `skills read <skill>/<relative-path> --json`，包含
28 项 Skill 的 SKILL.md 和 references，与二进制版本一致；不包含 assets/scripts。
这只是向调用方提供真实工作指南，不代表模型会自动遵守，也不自动开放指南中的全部命令。
本版本 CLI 没有 `mcp` 服务命令，外层 MCP 由本应用提供。

`schema` 可列全部内置原生方法，亦可按服务/精确方法查询；输出顶层为
`name/description/inputSchema/outputSchema/_meta`。没有 HTTP method/path 字段，运行时应执行
固定 `name` 拆成的 `[service, resource, method]`，不能据描述拼接任意 URL。

```text
node native/generate-catalog.mjs --binary <absolute-official-binary> --output native/generated/api-catalog.json
```

生成器在空的独立配置目录、无 token 环境中验证版本，然后读取官方内置 schema。
目录生成器读取本版本 `schema` 和完整可见 `--help` 命令树，共 **818 个入口：251 个原生 API、532 个快捷命令、35 个辅助命令**。
它保留受限入口的发现信息，执行前必须检查 `availability`；完整发现不等于全部已适配、已授权或已验收。
0.4.0 固定快照为 **743 个 executable、75 个仅发现**：58 个 `host_managed`、10 个 `identity_restricted`、
6 个 `persistent_job_required`、1 个 `unknown_risk`。具体限制、替代方式及禁用参数分别见
`reasonDetail`、`alternative`、`blockedFlags`；这些状态不是对真实业务逐项验收的结论。
原生 API 保留官方 `inputSchema/outputSchema/_meta`，快捷命令保留官方帮助与允许的 flag 类型，并附加：

- `command`：注册的规范 argv 路径（原生 API 为 3 段）；`schemaPath`：点分路径；`service`：业务域。
- `mode`：仅官方 risk=read 归 read，其余保守归 write。明确的只读搜索可由单独快捷工具正确标注。
- `scopeGroups`：组间 AND、组内 OR。官方 `required_scopes` 非空时取全部 AND；为空才用 `scopes` 候选 OR。
- `kind`：`api` / `shortcut` / `utility`；`availability` 与 `reason` 描述当前执行边界。
- `scopeValidation`：`declared` 表示有官方 schema 权限声明；`upstream` 表示快捷帮助未提供完整 scope 清单，最终由飞书接口校验，不能据此声称无需权限。
- `requiresExplicitConfirmation`：high-risk-write。该类 schema 的顶层 `yes` 是 CLI 确认门禁，
  不是业务 API 字段；不得因为模型写了 userIntent 就自动追加 `--yes`。

原始 `_meta.scopes/required_scopes/access_tokens/risk/danger/doc_url` 不改写。
JSON 方法的 `params` / `data` 必须按原 schema 验证后 JSON.stringify 成单一 flag 值；
不接收用户自定义 flags，顶层 `yes` 由独立确认合同处理。
当前目录纳入文件上传和附件下载 URL 方法，并发现高层 `+shortcut`。原生 API 的 `params/data/file/yes`
与快捷命令的 `flags` 是不同输入合同，必须使用精确条目返回的 schema；不得自行拼接未注册 flag。
宿主配置/凭据命令、持续进程、仅 bot 身份或未知风险等条目保留限制状态。参数未受支持、
文件超过限额或超时仍会失败，不能把目录标记 `executable` 等同于每个参数组合都已验收。

## 文件输入与交付

MCP 原生读写工具声明顶层 `files`，采用 OpenAI 文件输入字段 `download_url`、`file_id`、
可选 `mime_type`、`file_name`。URL 下载不携带飞书凭据；每次跳转都检查目标地址，拒绝内网地址，
并固定连接到已检查的 IP。客户端文件名映射到私有 `input/<name>`，无名称时使用 `file-1.bin` 等。
`file_id` 是宿主文件标识，不是飞书上传后的文件 token。

子进程完成后先收集、校验 `output/` 文件，再清理整个临时目录。单文件最多 10 MiB，
每次输入或输出合计最多 20 MiB、最多 20 件；运行上限仍为 25 秒，JSON/文本输出另有 4 MiB 上限。
不把二进制 base64 塞进 MCP 文本；业务层把已确认文件转换为元数据、短时下载链接与 `resource_link`。

`feishu_download_attachment` 为常见来源提供强类型适配：邮件固定本人邮箱，检查每个请求附件的成功/失败；
聊天和 Drive 使用固定输出路径；Docx 支持 PDF、DOCX、Markdown。Markdown 的 `.md` 后缀来自
官方 `drive_export_common.go`。Docx 异步导出可能超过进程预算，未完成时不返回虚假的成功。

二进制文件按块存入现有加密存储，清单在全部块写入后发布，15 分钟后失效。下载时重新检查
账号、Grant、Consent 绑定/有效期/撤销，并核对文件长度与摘要。下载 ticket 是 bearer 凭证：
持链接者在有效期且原授权有效时可下载，因此不得公开转发或写入日志。邮件官方链接的有效期和
权限由飞书控制，不能套用连接器的 15 分钟期限，也不能声称已下载其内容。

精确样例：

- `mail user_mailboxes search`：`params.user_mailbox_id` 必填，`data.query/filter` 搜索；
  scope `mail:user_mailbox.message:readonly`，user，官方 risk=write（业务语义只读）。
- `mail user_mailbox.drafts create`：`params.user_mailbox_id` + `data.raw`（完整 EML 的 base64url）；
  scope `mail:user_mailbox.message:modify`，user，risk=write。优先用 `mail +draft-create`
  复用官方正文、签名、EML 与草稿回链流程，它还需要 `mail:user_mailbox:readonly` 查询发件人。

## 无真实凭据检查

```text
node native/probe-native.mjs native/test-output/lark-cli.exe
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck native/bridge-contract.ts
node scripts/probe-feishu-attachments.mjs
node scripts/test-feishu-cli-files.mjs
node scripts/test-feishu-file-delivery.mjs
```

检查固定资产、错误 digest 拒绝、隔离环境（包括真实合成 child）、scope AND/OR、目录过滤、
高风险标记，以及可选官方二进制 version/skills/schema。没有业务 API 调用或真实 OAuth。

官方证据（固定 tag）：

- https://github.com/larksuite/cli/blob/v1.0.95/main.go
- https://github.com/larksuite/cli/blob/v1.0.95/extension/credential/env/env.go
- https://github.com/larksuite/cli/blob/v1.0.95/internal/credential/credential_provider.go
- https://github.com/larksuite/cli/blob/v1.0.95/internal/envvars/envvars.go
- https://github.com/larksuite/cli/blob/v1.0.95/internal/registry/helpers.go
- https://github.com/larksuite/cli/blob/v1.0.95/cmd/schema/schema.go
- https://github.com/larksuite/cli/blob/v1.0.95/shortcuts/mail/mail_draft_create.go
- https://github.com/larksuite/cli/blob/v1.0.95/shortcuts/mail/mail_triage.go
