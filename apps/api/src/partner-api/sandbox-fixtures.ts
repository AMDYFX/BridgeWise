export interface SandboxPartner {
  id: string;
  name: string;
  tier: 'free' | 'standard' | 'enterprise';
  scopes: string[];
  sandbox: true;
}

export interface SandboxExecution {
  id: string;
  partnerId: string;
  state: 'created' | 'quoted' | 'reserved' | 'submitted' | 'confirmed' | 'failed' | 'cancelled';
  fromChain: string;
  toChain: string;
  asset: string;
  /** Integer string in the asset's smallest unit. */
  amount: string;
  sandbox: true;
}

export interface SandboxWebhookEvent {
  id: string;
  partnerId: string;
  type: string;
  executionId: string;
  sequence: number;
  schemaVersion: string;
  sandbox: true;
}

export interface SandboxFixtures {
  partners: SandboxPartner[];
  executions: SandboxExecution[];
  webhookEvents: SandboxWebhookEvent[];
}

const STATES: SandboxExecution['state'][] = ['created', 'quoted', 'reserved', 'submitted', 'confirmed', 'failed', 'cancelled'];

/**
 * Static, deterministic sandbox data: no real keys, addresses or funds, identical on every call, with one
 * execution in every lifecycle state per partner so integrations can exercise each path.
 */
export function buildSandboxFixtures(): SandboxFixtures {
  const partners: SandboxPartner[] = [
    { id: 'sbx_partner_free', name: 'Sandbox Free Partner', tier: 'free', scopes: ['quotes:read', 'sandbox:use'], sandbox: true },
    { id: 'sbx_partner_pro', name: 'Sandbox Standard Partner', tier: 'standard', scopes: ['quotes:read', 'executions:*', 'webhooks:manage', 'sandbox:use'], sandbox: true },
  ];

  const executions = partners.flatMap((partner) =>
    STATES.map<SandboxExecution>((state, i) => ({
      id: `sbx_exec_${partner.id.replace('sbx_partner_', '')}_${state}`,
      partnerId: partner.id,
      state,
      fromChain: 'ethereum-sepolia',
      toChain: 'stellar-testnet',
      asset: 'USDC',
      amount: String((i + 1) * 1_000_000),
      sandbox: true,
    })),
  );

  const webhookEvents = executions.map<SandboxWebhookEvent>((execution, i) => ({
    id: `sbx_evt_${String(i + 1).padStart(4, '0')}`,
    partnerId: execution.partnerId,
    type: `execution.${execution.state}`,
    executionId: execution.id,
    sequence: 1,
    schemaVersion: '2025-01-15',
    sandbox: true,
  }));

  return { partners, executions, webhookEvents };
}
