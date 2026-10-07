// app.module.ts
import { Body, Controller, Module, Post, UseInterceptors } from '@nestjs/common';
import {
  Idempotent, IdempotencyInterceptor, IdempotencyModule, MemoryStorage,
} from '@nestarc/idempotency';

@Controller('payments')
@UseInterceptors(IdempotencyInterceptor)
class PaymentsController {
  @Post()
  @Idempotent()
  createPayment(@Body() dto: { commandId: string; amount: number }) {
    // Demo only: no money is moved. Validate DTOs in your application.
    return { commandId: dto.commandId, amount: dto.amount, accepted: true };
  }
}

@Module({
  imports: [IdempotencyModule.forRoot({ storage: new MemoryStorage(), ttl: 86400 })],
  controllers: [PaymentsController],
})
export class AppModule {}
