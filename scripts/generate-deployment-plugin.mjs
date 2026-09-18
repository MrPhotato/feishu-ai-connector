import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDeploymentConfig, validateDeploymentConfig } from './lib/deployment-config.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const templateRoot = resolve(repositoryRoot, 'plugins/feishu');
const generatedRoot = resolve(repositoryRoot, 'deployment/generated');

export async function generateDeploymentPlugin(config, outputDirectory = resolve(generatedRoot, 'plugins/feishu')) {
  const deployment = validateDeploymentConfig(config);
  const output = resolve(outputDirectory);
  const within = relative(generatedRoot, output);
  if (!within || within.startsWith('..') || isAbsolute(within) || basename(output) !== 'feishu') {
    throw new Error('Plugin output must be a feishu directory under deployment/generated.');
  }
  const portable = JSON.parse(await readFile(resolve(templateRoot, 'plugin.json'), 'utf8'));
  const compatibility = JSON.parse(await readFile(resolve(templateRoot, '.codex-plugin/plugin.json'), 'utf8'));
  if (portable.name !== 'feishu' || compatibility.name !== 'feishu' || portable.version !== compatibility.version) {
    throw new Error('Plugin template identity or version is inconsistent.');
  }
  portable.author = { name: deployment.author };
  compatibility.author = { name: deployment.author };
  compatibility.interface.displayName = deployment.displayName;
  compatibility.interface.developerName = deployment.author;
  const endpoint = `${deployment.publicUrl}/mcp`;
  const manifests = {
    'plugin.json': portable,
    '.codex-plugin/plugin.json': compatibility,
    'mcp.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { feishu: { type: 'streamable-http', url: endpoint } } },
    '.mcp.json': { mcpServers: { feishu: { type: 'http', url: endpoint } } },
  };
  await mkdir(resolve(output, '.codex-plugin'), { recursive: true });
  // Copy only the public plugin template, never the repository or deployment profile.
  for (const entry of ['skills', 'evals']) {
    await cp(resolve(templateRoot, entry), resolve(output, entry), { recursive: true });
  }
  for (const [name, data] of Object.entries(manifests)) {
    await writeFile(resolve(output, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
  await writeFile(resolve(output, 'README.md'), `# ${deployment.displayName}\n\n`
    + `这是由通用模板生成的 ${portable.version} 部署安装包，包含四个领域 Skills 和已配置的远程 MCP 地址。\n\n`
    + '请仅在支持该插件格式的宿主中安装，并通过 OAuth 授权自己的飞书账号。包内不包含用户凭据。\n\n'
    + '生成包不代表已经安装或激活；个人网页版 ChatGPT 添加 MCP 连接不会自动加载此包的 Skills。\n', 'utf8');
  return { outputDirectory: output, name: portable.name, version: portable.version };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) throw new Error('Use CONNECTOR_DEPLOYMENT_FILE to select a deployment profile.');
    const result = await generateDeploymentPlugin(loadDeploymentConfig());
    console.log(JSON.stringify({ generated: true, ...result, installed: false }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Plugin generation failed.');
    process.exitCode = 1;
  }
}
