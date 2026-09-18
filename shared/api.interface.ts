export interface ConnectorProbeResult {
  service: 'feishu-ai-connector';
  phase: 'transport-probe';
  version: '0.1.0';
  personalDataConnected: false;
}

export type CredentialProbeRole = 'system' | 'apiKey' | 'authenticated' | 'anonymous';
export type CredentialProbeOutcome = 'allowed' | 'denied' | 'error';
export type CredentialProbeCleanup = 'complete' | 'notNeeded' | 'error';

export interface CredentialProbeResult {
  phase: 'synthetic-storage-probe';
  roleCategory: CredentialProbeRole;
  read: CredentialProbeOutcome;
  insert: CredentialProbeOutcome;
  update: CredentialProbeOutcome;
  delete: CredentialProbeOutcome;
  cleanup: CredentialProbeCleanup;
  expectedIsolation: boolean;
}

export type ConnectorAuthStorageOperation = 'get' | 'put' | 'consume' | 'remove' | 'revokeGrant' | 'findUid' | 'acquireLease' | 'releaseLease';

export interface ConnectorAuthStorageRequest {
  operation: ConnectorAuthStorageOperation;
  model?: string;
  key?: string;
  payload?: Record<string, unknown>;
  expiresAt?: number;
  uid?: string;
  grantId?: string;
  ttlSeconds?: number;
  leaseToken?: string;
}

export interface ConnectorAuthStorageResponse {
  ok: true;
  record?: Record<string, unknown>;
  consumed?: boolean;
  leaseToken?: string;
}

export interface ConnectorAuthStorageEnvelope {
  sealed: string;
}

export type FeishuToolMode = 'read' | 'write';

export interface FeishuOperationCatalogEntry {
  id: string;
  title: string;
  description: string;
  mode: FeishuToolMode;
  scopeGroups: string[][];
  inputSchema: Record<string, unknown>;
}

export interface FeishuToolsCatalog {
  operations: FeishuOperationCatalogEntry[];
}

export interface FeishuToolError {
  code: string;
  message: string;
  scopeGroups?: string[][];
}

export interface FeishuToolResult {
  ok: boolean;
  data?: unknown;
  error?: FeishuToolError;
}

export interface ConnectorStatus {
  configured: boolean;
  mcpUrl: string;
  oauthClientId: 'chatgpt';
  message: string;
}
