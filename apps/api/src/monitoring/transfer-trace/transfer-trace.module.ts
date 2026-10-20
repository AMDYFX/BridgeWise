import { Module } from '@nestjs/common';
import { TransferTraceController } from './transfer-trace.controller';
import { TransferTraceService } from './transfer-trace.service';

@Module({
  controllers: [TransferTraceController],
  providers: [TransferTraceService],
  exports: [TransferTraceService],
})
export class TransferTraceModule {}
