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
文本参数采用独立 `--flag=value`，不拼 shell；阻止自由 argv、`api`、auth/config/profile/update、
apps/application/event 等管理入口，以及任意文件路径、@file、上传下载和自定义输出路径。
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
当前静态快照为 **240 项 user 业务 JSON 方法**（97 read、143 write，其中 34 high-risk-write），
来自本版本 strict-user 目录 251 项，保留每个方法完整 `inputSchema/outputSchema/_meta`，附加：

- `command`：规范的 3 段 argv；`schemaPath`：点分路径；`service`：业务域。
- `mode`：仅官方 risk=read 归 read，其余保守归 write。明确的只读搜索可由单独快捷工具正确标注。
- `scopeGroups`：组间 AND、组内 OR。官方 `required_scopes` 非空时取全部 AND；为空才用 `scopes` 候选 OR。
- `requiresExplicitConfirmation`：high-risk-write。该类 schema 的顶层 `yes` 是 CLI 确认门禁，
  不是业务 API 字段；不得因为模型写了 userIntent 就自动追加 `--yes`。

原始 `_meta.scopes/required_scopes/access_tokens/risk/danger/doc_url` 不改写。
JSON 方法的 `params` / `data` 必须按原 schema 验证后 JSON.stringify 成单一 flag 值；
不接收用户自定义 flags，顶层 `yes` 由独立确认合同处理。
当前排除清单随快照提供：2 个二进制上传、7 个无显式 user 身份方法、2 个下载 URL 方法。
最后两项虽不一定写本地文件，本版仍保守排除，不能声称它们在 CLI 不可用。

该快照只覆盖 CLI 的 **原生 API 方法目录**，不包含全部高层 `+shortcut`；例如 Docx/Base
增强快捷指令需要各自结构化适配。不能把“240 方法可发现”称为“所有飞书能力已授权或验收”。

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
