import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TransferTraceService } from './transfer-trace.service';
import { TransferTrace } from './transfer-trace.types';

class CreateTraceDto {
  transferId!: string;
  sourceAccount!: string;
  destinationAccount!: string;
  asset!: string;
  amount!: string;
  sourceChain!: string;
  destinationChain!: string;
}

class AddEventDto {
  eventType!: 'initiated' | 'source_confirmed' | 'bridge_submit' | 'destination_received' | 'completed' | 'failed';
  chain!: string;
  transactionHash?: string;
  blockNumber?: number;
  metadata?: Record<string, unknown>;
}

@ApiTags('Transfer Trace')
@Controller('monitoring/transfer-trace')
export class TransferTraceController {
  constructor(private readonly transferTraceService: TransferTraceService) {}

  /**
   * Creates a new transfer trace.
   * POST /monitoring/transfer-trace
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new transfer trace' })
  @ApiResponse({ status: 201, description: 'Transfer trace created' })
  create(@Body() dto: CreateTraceDto): TransferTrace {
    if (!dto.transferId || !dto.sourceAccount || !dto.destinationAccount || !dto.asset || !dto.amount || !dto.sourceChain || !dto.destinationChain) {
      throw new BadRequestException('All fields are required');
    }
    return this.transferTraceService.createTrace(
      dto.transferId,
      dto.sourceAccount,
      dto.destinationAccount,
      dto.asset,
      dto.amount,
      dto.sourceChain,
      dto.destinationChain,
    );
  }

  /**
   * Adds an event to an existing transfer trace.
   * POST /monitoring/transfer-trace/:transferId/events
   */
  @Post(':transferId/events')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add an event to a transfer trace' })
  @ApiResponse({ status: 200, description: 'Event added' })
  @ApiResponse({ status: 404, description: 'Transfer trace not found' })
  addEvent(
    @Param('transferId') transferId: string,
    @Body() dto: AddEventDto,
  ): TransferTrace {
    if (!dto.eventType || !dto.chain) {
      throw new BadRequestException('eventType and chain are required');
    }
    const trace = this.transferTraceService.addEvent(
      transferId,
      dto.eventType,
      dto.chain,
      dto.transactionHash,
      dto.blockNumber,
      dto.metadata,
    );
    if (!trace) {
      throw new NotFoundException(`Transfer trace ${transferId} not found`);
    }
    return trace;
  }

  /**
   * Gets a transfer trace by ID.
   * GET /monitoring/transfer-trace/:transferId
   */
  @Get(':transferId')
  @ApiOperation({ summary: 'Get a transfer trace by ID' })
  @ApiResponse({ status: 200, description: 'Transfer trace found' })
  @ApiResponse({ status: 404, description: 'Transfer trace not found' })
  getOne(@Param('transferId') transferId: string): TransferTrace {
    const trace = this.transferTraceService.getTrace(transferId);
    if (!trace) {
      throw new NotFoundException(`Transfer trace ${transferId} not found`);
    }
    return trace;
  }

  /**
   * Gets all transfer traces.
   * GET /monitoring/transfer-trace
   */
  @Get()
  @ApiOperation({ summary: 'Get all transfer traces' })
  @ApiResponse({ status: 200, description: 'All transfer traces' })
  getAll(): TransferTrace[] {
    return this.transferTraceService.getAllTraces();
  }

  /**
   * Queries transfer traces with optional filters.
   * GET /monitoring/transfer-trace/query
   */
  @Get('query')
  @ApiOperation({ summary: 'Query transfer traces' })
  @ApiQuery({ name: 'sourceAccount', required: false })
  @ApiQuery({ name: 'destinationAccount', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'startTime', required: false })
  @ApiQuery({ name: 'endTime', required: false })
  @ApiResponse({ status: 200, description: 'Transfer traces' })
  query(
    @Query('sourceAccount') sourceAccount?: string,
    @Query('destinationAccount') destinationAccount?: string,
    @Query('status') status?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): TransferTrace[] {
    const query: any = {};
    if (sourceAccount) query.sourceAccount = sourceAccount;
    if (destinationAccount) query.destinationAccount = destinationAccount;
    if (status) query.status = status;
    if (startTime) query.startTime = new Date(startTime);
    if (endTime) query.endTime = new Date(endTime);

    return this.transferTraceService.queryTraces(query);
  }

  /**
   * Deletes a transfer trace.
   * DELETE /monitoring/transfer-trace/:transferId
   */
  @Delete(':transferId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a transfer trace' })
  @ApiResponse({ status: 200, description: 'Transfer trace deleted' })
  delete(@Param('transferId') transferId: string): { deleted: boolean } {
    const deleted = this.transferTraceService.deleteTrace(transferId);
    return { deleted };
  }
}
