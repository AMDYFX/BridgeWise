/**
 * File: src/operations/mainnet/chain-outage-playbooks.defaults.ts
 *
 * Built-in playbooks for the mainnet chains BridgeWise operates (#1378).
 * These are starting points: operators may override or extend them through
 * `registerPlaybook` in a deployment-specific configuration layer.
 */

import { ChainOutagePlaybook } from './chain-outage-playbook.types';

export const DEFAULT_CHAIN_OUTAGE_PLAYBOOKS: ChainOutagePlaybook[] = [
  {
    id: 'stellar-mainnet-rpc-unavailable',
    chain: 'stellar-mainnet',
    outageType: 'rpc_unavailable',
    severity: 'sev1',
    summary:
      'Stellar RPC/Horizon is unavailable or returning unverifiable ledger state. Contain all Stellar-sourced transfers before retrying.',
    steps: [
      {
        id: 'confirm-outage-scope',
        order: 1,
        title:
          'Confirm the outage scope from at least two independent RPC providers',
        ownerRole: 'oncall-engineer',
        slaSeconds: 300,
        required: true,
      },
      {
        id: 'pause-stellar-routes',
        order: 2,
        title: 'Pause all routes sourced from Stellar mainnet',
        ownerRole: 'oncall-engineer',
        slaSeconds: 180,
        required: true,
        action: 'pause_routes',
      },
      {
        id: 'halt-stellar-canaries',
        order: 3,
        title: 'Halt active Stellar canary transfers and feature rollouts',
        ownerRole: 'release-manager',
        slaSeconds: 180,
        required: true,
        action: 'halt_canary_transfers',
      },
      {
        id: 'failover-rpc',
        order: 4,
        title: 'Fail over to the standby RPC pool and verify ledger continuity',
        ownerRole: 'platform-engineer',
        slaSeconds: 900,
        required: true,
      },
      {
        id: 'notify-partners',
        order: 5,
        title: 'Notify downstream bridge partners of the Stellar pause',
        ownerRole: 'incident-commander',
        slaSeconds: 1200,
        required: false,
        action: 'notify_oncall',
      },
    ],
    escalation: {
      primaryRole: 'oncall-engineer',
      secondaryRole: 'bridge-ops-lead',
      notifyAfterSeconds: 600,
    },
    recovery: {
      signals: ['rpc_healthy', 'ledger_continuity_verified', 'routes_reopened'],
      observationWindowSeconds: 900,
    },
  },
  {
    id: 'ethereum-mainnet-finality-stall',
    chain: 'ethereum-mainnet',
    outageType: 'finality_stall',
    severity: 'sev1',
    summary:
      'Ethereum finality has stalled. Stop new destination settlements and prevent duplicate releases while finality is uncertain.',
    steps: [
      {
        id: 'verify-finality-gap',
        order: 1,
        title:
          'Verify the finalized-block gap across independent beacon providers',
        ownerRole: 'oncall-engineer',
        slaSeconds: 300,
        required: true,
      },
      {
        id: 'pause-ethereum-settlements',
        order: 2,
        title: 'Pause Ethereum destination settlements',
        ownerRole: 'oncall-engineer',
        slaSeconds: 180,
        required: true,
        action: 'pause_routes',
      },
      {
        id: 'freeze-release-queue',
        order: 3,
        title: 'Freeze the release queue to avoid duplicate execution',
        ownerRole: 'platform-engineer',
        slaSeconds: 300,
        required: true,
      },
      {
        id: 'monitor-validator-recovery',
        order: 4,
        title: 'Monitor validator participation until finality resumes',
        ownerRole: 'incident-commander',
        slaSeconds: 1800,
        required: true,
      },
    ],
    escalation: {
      primaryRole: 'oncall-engineer',
      secondaryRole: 'bridge-ops-lead',
      notifyAfterSeconds: 300,
    },
    recovery: {
      signals: [
        'finality_resumed',
        'release_queue_reconciled',
        'settlements_reopened',
      ],
      observationWindowSeconds: 1800,
    },
  },
  {
    id: 'arbitrum-mainnet-congestion',
    chain: 'arbitrum-mainnet',
    outageType: 'congestion',
    severity: 'sev2',
    summary:
      'Arbitrum sequencer congestion is inflating settlement latency. Shed load and hold low-priority routes while the sequencer catches up.',
    steps: [
      {
        id: 'measure-sequencer-lag',
        order: 1,
        title: 'Measure sequencer lag and pending transaction age',
        ownerRole: 'oncall-engineer',
        slaSeconds: 600,
        required: true,
      },
      {
        id: 'shed-low-priority-routes',
        order: 2,
        title: 'Pause low-priority Arbitrum routes',
        ownerRole: 'oncall-engineer',
        slaSeconds: 300,
        required: true,
        action: 'pause_routes',
      },
      {
        id: 'hold-canary-rollout',
        order: 3,
        title: 'Hold canary percentage increases until lag returns to baseline',
        ownerRole: 'release-manager',
        slaSeconds: 300,
        required: true,
        action: 'halt_canary_transfers',
      },
      {
        id: 'restore-routes',
        order: 4,
        title: 'Restore paused routes after sustained latency recovery',
        ownerRole: 'oncall-engineer',
        slaSeconds: 1800,
        required: false,
      },
    ],
    escalation: {
      primaryRole: 'oncall-engineer',
      secondaryRole: 'bridge-ops-lead',
      notifyAfterSeconds: 900,
    },
    recovery: {
      signals: ['sequencer_lag_normal', 'settlement_latency_normal'],
      observationWindowSeconds: 600,
    },
  },
];
