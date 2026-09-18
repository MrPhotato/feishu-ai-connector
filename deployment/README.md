# 部署配置

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

## 生成插件

在仓库根目录运行：

```sh
node scripts/generate-deployment-plugin.mjs
```

生成包位于 `deployment/generated/plugins/feishu/`，包含配置后的 MCP 地址、作者和四个 Skills。生成目录不进入 Git。`plugins/feishu/` 是通用源模板，MCP 列表为空，直接使用它不会连接任何企业实例；仅生成后的包有真实连接地址。

生成包不包含部署配置文件或任何密钥。生成成功不代表已安装到 ChatGPT，也不改变个人网页版及工作区的分发限制。

## 检查

```sh
node scripts/test-deployment-config.mjs
```

此测试只用合成配置和模拟请求，不访问云端。远程探针从同一配置加载目标；运行远程存储探针会调用平台并创建短期合成测试数据，不能当作离线检查执行。设置云端身份及运行远程探针均不是生成插件的副作用。
