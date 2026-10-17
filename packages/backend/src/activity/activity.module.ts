import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Activity } from './entities/activity.entity';
import { ActivityService } from './activity.service';
import {
  ActivityController,
  ActivityFeedController,
} from './activity.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Activity])],
  controllers: [ActivityController, ActivityFeedController],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
