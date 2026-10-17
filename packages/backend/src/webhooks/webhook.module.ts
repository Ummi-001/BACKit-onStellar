import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WebhookSubscription, WebhookDeliveryLog } from './webhook.entity';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';
import { WebhookDispatchProcessor } from './webhook-dispatch.processor';
import { WebhookEventListener } from './webhook-event.listener';
import { QUEUE_WEBHOOK_DISPATCH } from './webhook-queue.constants';
import { WEBHOOK_MAX_ATTEMPTS } from './webhook.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    ConfigModule,
    HttpModule,
    AuthModule,
    TypeOrmModule.forFeature([WebhookSubscription, WebhookDeliveryLog]),
    BullModule.registerQueue({
      name: QUEUE_WEBHOOK_DISPATCH,
      defaultJobOptions: {
        attempts: WEBHOOK_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 60 * 60 * 24 },
        removeOnFail: false,
      },
    }),
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookDispatchProcessor, WebhookEventListener],
  exports: [WebhookService],
})
export class WebhooksModule {}
