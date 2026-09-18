# 部署配置与维护

每个部署实例的配置以**妙搭应用环境变量**为准。`CONNECTOR_DEPLOYMENT_CONFIG` 保存六项非密钥配置；密钥分别保存在服务端环境变量中。本地 JSON 只是调试和生成插件时使用的副本，不是第二个权威来源。

本仓库提供通用实现和配置模板，不提供可直接使用的服务实例。新部署需要独立创建平台资源、设置访问策略并完成用户授权。

## 配置放在哪里

| 内容 | 维护位置 | 作用 |
| --- | --- | --- |
| OAuth、MCP、工具执行、存储安全逻辑 | 通用源码 | 各部署复用，不写入公司 URL、应用 ID 或个人身份 |
| 六项实例配置 | 妙搭 `CONNECTOR_DEPLOYMENT_CONFIG` | 当前应用的配置权威来源 |
| App Secret、API Key、加密与签名密钥 | 妙搭独立服务端环境变量 | 不进入 JSON、插件、前端或 Git |
| 用户令牌、会话、授权及幂等记录 | 当前妙搭应用的受保护数据库 | 按账号隔离并加密保存，不随源码或插件分发 |
| 本地配置副本 | `deployment/instance.local.json` | 从云端拉取，已被 Git 忽略；可用 `CONNECTOR_DEPLOYMENT_FILE` 选择其他文件 |
| 可安装插件包 | `deployment/generated/plugins/feishu/` | 从通用模板和实例配置生成，已被 Git 忽略；生成不等于安装或发布 |

`CONNECTOR_DEPLOYMENT_CONFIG` 必须是一个完整 JSON 对象，仅允许下列六个字符串字段：

| 字段 | 含义 |
| --- | --- |
| `miaodaAppId` | 本实例的妙搭应用 ID |
| `publicUrl` | 本实例完整 HTTPS 地址，路径为 `/app/<miaodaAppId>` |
| `feishuAppId` | 本实例使用的飞书开放平台应用 ID，与妙搭应用 ID 不同 |
| `defaultTimezone` | IANA 时区名称或 `UTC`，例如 `Asia/Singapore`；不使用 `+08:00` 这类偏移字符串 |
| `displayName` | 生成插件包的显示名称 |
| `author` | 生成插件包的作者显示名称 |

格式示例见 [instance.example.json](../deployment/instance.example.json)。示例值不能直接用于真实实例。

运行时优先读取 JSON；只有未设置 JSON 时，才兼容旧的 `CONNECTOR_PUBLIC_URL`、`FEISHU_APP_ID`、`CONNECTOR_DEFAULT_TIMEZONE`。无时区配置时默认 `UTC`；显式请求的日程时区优先。JSON 格式或字段无效时拒绝启动相关能力，不会悄悄回退到旧值。首次迁移保留原时区，以免改变现有业务语义。

下列密钥继续独立维护：`FEISHU_APP_SECRET`、`CONNECTOR_STORAGE_API_KEY`、`CONNECTOR_STORAGE_ENCRYPTION_KEY`、`CONNECTOR_SIGNING_JWKS`、`CONNECTOR_COOKIE_KEYS`。`CONNECTOR_FEISHU_SCOPES` 和 `CONNECTOR_NATIVE_CLI_ENABLED` 仍是独立功能配置；修改六项 JSON 不会替代飞书权限开通或用户授权。

## 维护现有实例

1. 在妙搭核对目标应用及线上环境。首次建立 JSON 时，将现有应用 ID、URL、飞书应用 ID、时区原样迁入，再填写显示名和作者。**不更换当前实例的密钥、数据库、URL 或飞书应用 ID。**
2. 在妙搭维护 JSON 后，将副本拉到本地。以下命令只读取云配置并写入本地忽略文件，不创建云配置：

   ```sh
   node scripts/pull-deployment-config.mjs --app-id <实际妙搭应用ID>
   ```

   云端尚无 JSON 时，拉取会停止。应先核对现有配置并初始化，不根据示例猜测公司配置。
3. 需要生成插件时，在仓库根目录运行：

   ```sh
   node scripts/generate-deployment-plugin.mjs
   ```

   使用生成目录中的包。`plugins/feishu/` 是通用模板，其 MCP 列表为空；生成包才会写入本实例的连接地址。生成器不会安装插件、发布服务或上传公司配置。
4. 运行配置变更后，按妙搭发布流程使新配置生效，再执行下方验证。OAuth Provider 会缓存运行配置，不能仅凭环境变量已保存就认定线上已切换。

如需用维护脚本初始化云配置，先准备与当前实例一致的本地副本，再检查：

```sh
node scripts/configure-cloud-auth.mjs --check
```

`--check` 只核对云端身份及配置。去掉 `--check` 会写入云配置并补齐缺失的服务密钥；它保留已有密钥，身份不匹配时停止。该命令不是切换实例或轮换密钥的入口，也不负责创建数据库表、平台策略或飞书应用。

## 新实例还需要准备什么

新实例应有自己的妙搭应用、数据库授权存储、飞书开放平台应用和服务密钥。不要复制旧实例的用户授权记录、数据库连接、API Key 或加密密钥；每位使用者通过新实例重新完成本人 OAuth 授权。

填写 JSON 前后还需完成以下平台工作：

- 在正确的妙搭环境初始化授权存储表、索引及行级访问策略；普通用户和匿名访问不得读写授权存储。已有表先核查，不重复执行建表脚本。新表方案见 [connector-auth-storage.sql](./connector-auth-storage.sql)，执行后通过平台工具重新生成数据库类型。
- 注册存储 OpenAPI 路由，为 `POST /openapi/connector-auth-storage/execute` 建立专用受限 API Key，验证网关与数据库隔离。
- 配置独立服务密钥及飞书应用密钥；在飞书开放平台登记 `${publicUrl}/auth/feishu/callback`，开通实际所需权限及可用范围，再由用户完成授权。
- 部署代码，核对 OAuth issuer、MCP audience 和存储网关都来自同一实例配置。更改 JSON 不会自动建立上述资源或授予权限。

## 无损验证与交付边界

先运行不访问云端、使用合成数据的本地检查：

```sh
node scripts/test-deployment-config.mjs
node scripts/test-connector-timezone.mjs
```

发布后先读取 `${publicUrl}/connector/status`，核对服务配置状态和 MCP 地址。`configured: true` 仅表示服务端配置满足检查条件，不表示用户已经授权，也不表示每项业务工具已经联调成功。传输探针从同一份本地副本加载目标，不接受另外传入的 URL，也不携带个人令牌：

```sh
node scripts/probe-remote.mjs
```

确认公开合成探针通过后，再验证现有本人连接的只读能力；不要用发送消息、发送邮件或改写业务文档作为配置检查。

远程存储探针会创建和清理短期合成数据，有的还会创建临时 API Key。它们不是只读检查，不应混入日常配置拉取或插件生成流程。

共享或发布源码时采用明确的文件清单：包含通用源码、无实例值的模板与部署说明；排除密钥、本地副本、生成包、旧项目资料与验证记录、现有 `.spark` 绑定及旧 Git 历史。提交贡献前同时检查文件和历史中的敏感信息，`.gitignore` 不会移除已经进入历史的内容。
