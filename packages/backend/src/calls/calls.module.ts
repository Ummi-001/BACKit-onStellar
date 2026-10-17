import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';
import { CallsRepository } from './calls.repository';
import { Call } from './entities/call.entity';
import { CallReport } from './entities/call-report.entity';
import { IpfsService } from '../storage/ipfs.service';
import { BookmarksModule } from '../bookmarks/bookmarks.module';
import { FeedRankingService } from './feed-ranking.service';

@Module({
  imports: [TypeOrmModule.forFeature([Call, CallReport]), BookmarksModule],
  controllers: [CallsController],
  providers: [CallsService, CallsRepository, IpfsService, FeedRankingService],
  exports: [CallsService, CallsRepository, FeedRankingService],
})
export class CallsModule {}
