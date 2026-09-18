import { isAbsolute, join } from 'node:path';

interface NativeCredential {
  appId: string;
  accessToken: string;
  scopes: readonly string[];
}
interface NativeEnvironmentOptions {
  /** A fresh mode-0700 per-invocation directory under the OS temporary directory. */
  invocationRoot: string;
  /** Only a trusted OS directory is copied on Windows; never spread process.env. */
  windowsSystemRoot?: string;
}

/** Pure helper. The caller creates/removes directories and owns spawn lifetime. Never log its result. */
function nativeCredentialEnvironment(
  credential: NativeCredential,
  options: NativeEnvironmentOptions,
): Record<string, string> {
  if (!/^cli_[A-Za-z0-9]+$/u.test(credential.appId) || !credential.accessToken ||
      credential.accessToken.length > 16384 || /[\x00-\x20\x7f]/u.test(credential.accessToken) ||
      !isAbsolute(options.invocationRoot)) throw new Error('Invalid CLI credential context.');
  const root: string = options.invocationRoot;
  const result: Record<string, string> = {
    HOME: root, USERPROFILE: root,
    APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    TMPDIR: root, TMP: root, TEMP: root,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', TERM: 'dumb',
    LARKSUITE_CLI_CONFIG_DIR: join(root, 'lark-config'),
    LARKSUITE_CLI_APP_ID: credential.appId,
    LARKSUITE_CLI_USER_ACCESS_TOKEN: credential.accessToken,
    LARKSUITE_CLI_BRAND: 'feishu',
    LARKSUITE_CLI_DEFAULT_AS: 'user',
    LARKSUITE_CLI_STRICT_MODE: 'user',
  };
  if (options.windowsSystemRoot) {
    if (!isAbsolute(options.windowsSystemRoot) || /[\x00-\x1f]/u.test(options.windowsSystemRoot)) {
      throw new Error('Invalid CLI operating-system context.');
    }
    result.SystemRoot = options.windowsSystemRoot;
    result.WINDIR = options.windowsSystemRoot;
  }
  return result;
}

/** Groups are ANDed; scopes within one group are alternatives. Metadata must be server-owned. */
function missingNativeScopeGroups(
  scopes: readonly string[], requiredGroups: readonly (readonly string[])[],
): string[][] {
  const granted: Set<string> = new Set(scopes);
  return requiredGroups.filter((group: readonly string[]): boolean =>
    group.length === 0 || !group.some((scope: string): boolean => granted.has(scope)))
    .map((group: readonly string[]): string[] => [...group]);
}

export { nativeCredentialEnvironment, missingNativeScopeGroups };
export type { NativeCredential, NativeEnvironmentOptions };
