import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { Controller, Get, Param, Query, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { ActivityService } from './activity.service';
import { ActivityType } from './entities/activity.entity';

@Controller('users')
export class ActivityController {
  constructor(private readonly activityService: ActivityService) {}

  @Get(':address/activity')
  async getUserActivity(
    @Param('address') address: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('type') type?: ActivityType,
  ) {
    return this.activityService.getUserActivity(address, page, limit, type);
  }
}

/**
 * Global, aggregated activity stream endpoint.
 *
 * `GET /activity`              → paginated global feed
 * `GET /activity?aggregated=1` → consecutive same-actor events clustered into
 *                                a single card within a 60s window.
 */
@Controller('activity')
export class ActivityFeedController {
  constructor(private readonly activityService: ActivityService) {}

  @Get()
  async getFeed(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('aggregated') aggregated?: string,
  ) {
    const result = await this.activityService.getGlobalActivity(page, limit);
    if (aggregated === '1' || aggregated === 'true') {
      return {
        ...result,
        data: this.activityService.aggregateActivities(result.data),
      };
    }
    return result;
  }
}

