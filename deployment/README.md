# 部署配置

本连接器使用通用代码和独立实例配置。部署管理员完成一次配置后，可向应用可用范围内的用户提供统一入口，由各用户分别授权自己的飞书账号。以下步骤供部署维护者使用，普通用户无需维护这些文件。

部署维护者使用妙搭服务端环境变量 `CONNECTOR_DEPLOYMENT_CONFIG`（完整六字段 JSON）保存权威配置。本地 `instance.local.json` 只是编辑、生成插件和调试用的副本，不进入 Git。需要选择另一份本地配置时设置 `CONNECTOR_DEPLOYMENT_FILE`；默认配置缺失会报错，不会连接其他人的服务。

已配置的实例可以运行 `node scripts/pull-deployment-config.mjs --app-id <妙搭应用ID>`，只取回这份非秘密 JSON。首次初始化或旧环境尚无此变量时，复制 `instance.example.json` 为 `instance.local.json` 并核实六个字段，不从不完整的旧字段猜测缺失信息。

六个字段必须齐全，不接受额外字段：

| 字段 | 内容 |
| --- | --- |
| `miaodaAppId` | 此部署的妙搭应用 ID |
| `publicUrl` | 完整 HTTPS 应用地址，路径必须是 `/app/<miaodaAppId>` |
| `feishuAppId` | 此部署使用的飞书开放平台应用 ID |
| `defaultTimezone` | 有效时区名称，例如 `Asia/Singapore` |
| `displayName` | 生成插件包的显示名 |
| `author` | 生成插件包的作者显示名字符串 |

不得在此文件放入 App Secret、API Key、OAuth token、签名密钥或加密密钥。密钥仍由原有服务端安全配置流程管理。`node scripts/configure-cloud-auth.mjs --check` 只检查已有云端身份和必需键是否存在；不输出值，也不写入。去掉 `--check` 后才会写入非秘密配置 JSON，并仅为缺失的密钥执行原初始化流程。身份不匹配时在写入前停止，不能把它用于原地切换账号或轮换密钥。

## 可选的 ChatGPT 客户端认证

0.4.5 增加可选服务端密钥 `CONNECTOR_CHATGPT_CLIENT_SECRET`。配置有效密钥后，服务端额外注册 `chatgpt_confidential` 客户端，使用 `client_secret_post`；每次授权码交换和刷新都验证密钥。密钥应由至少 32 字节独立密码学随机数据生成，以不带填充的标准 base64url 编码保存（43–128 个字符），不得复用飞书 App Secret 或其他服务密钥。

此密钥只保存在妙搭服务端环境变量及 ChatGPT 的私有 OAuth 客户端配置中，不能放进六字段配置 JSON、插件包、前端、日志或 Git。`.env.example` 仅说明该键，不提供空值；不启用时应完全省略此键，空值或格式错误会使授权服务配置无效。现有初始化脚本不会自动创建或同步这个可选密钥。

部署新代码并配置该密钥后，还需将 ChatGPT 的 OAuth Client ID 设置为 `chatgpt_confidential`，填入同一密钥，再由使用者重新连接。MCP 地址和回调地址不变。原有 `chatgpt` 连接不会自动迁移，仍使用 30 秒重复请求窗口、60 秒冷却期及令牌轮换策略。

新的客户端可以重复使用原刷新令牌，但每次刷新请求必须通过客户端密钥验证；刷新令牌从最初签发起最多 30 天有效，刷新不会顺延。用户撤销、飞书授权到期或权限变化仍可能提前中断连接。代码部署、客户端配置和真实重新连接应分别验证，不能仅以本地测试通过宣称已完成迁移。

## 生成插件

在仓库根目录运行：

```sh
node scripts/generate-deployment-plugin.mjs
```

生成包位于 `deployment/generated/plugins/feishu/`，包含配置后的 MCP 地址、作者和四个 Skills。生成目录不进入 Git。`plugins/feishu/` 是通用源模板，MCP 列表为空，直接使用它不会连接任何企业实例；仅生成后的包有真实连接地址。

生成包不包含部署配置文件或任何密钥。生成成功不代表已安装到 ChatGPT；安装与分发仍取决于所用客户端和工作区支持的流程。

## 检查

```sh
node scripts/test-deployment-config.mjs
```

此测试只用合成配置和模拟请求，不访问云端。远程探针从同一配置加载目标；运行远程存储探针会调用平台并创建短期合成测试数据，不能当作离线检查执行。设置云端身份及运行远程探针均不是生成插件的副作用。

两类客户端的刷新策略、安全边界、迁移步骤与专项验证见 [OAuth 刷新策略](oauth-refresh.md)。
