export interface TransferTraceEvent {
  eventId: string;
  transferId: string;
  eventType: 'initiated' | 'source_confirmed' | 'bridge_submit' | 'destination_received' | 'completed' | 'failed';
  timestamp: Date;
  chain: string;
  transactionHash?: string;
  blockNumber?: number;
  metadata?: Record<string, unknown>;
}

export interface TransferTrace {
  transferId: string;
  sourceAccount: string;
  destinationAccount: string;
  asset: string;
  amount: string;
  sourceChain: string;
  destinationChain: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  events: TransferTraceEvent[];
  createdAt: Date;
  updatedAt: Date;
}

export interface TransferTraceQuery {
  transferId?: string;
  sourceAccount?: string;
  destinationAccount?: string;
  status?: string;
  startTime?: Date;
  endTime?: Date;
}
