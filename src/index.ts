import dayjs from 'dayjs';
import { InternalClient, logger, MongoDB, runLegacy } from '.';
import { StatusModel, KickboardModel } from '.';

export * from './legacy';
export * from './models';
export * from './tools';

const maxMinute = Number(process.env.MAX_MINUTE) || 15;

async function main() {
  logger.info('시스템을 시작합니다.');
  if (process.env.NODE_ENV === 'prod') await runLegacy();

  await MongoDB.init();
  const rides = await getRiding();
  for (const { kickboardCode, rideId, realname, phone } of rides) {
    const readyToTerminate = await hasNoMovement(kickboardCode);
    if (!readyToTerminate) continue;
    await terminateRide(rideId);
    logger.info(
      `${realname}(${phone})님이 이용하신 라이드(${rideId})가 ${maxMinute}분을 초과하여 자동으로 종료하였습니다.`
    );
  }

  logger.info(
    `${maxMinute}분 이상 이동이 없는 라이드를 자동으로 종료하였습니다.`
  );

  process.exit(1);
}

async function getRiding() {
  const endedAt = dayjs().subtract(maxMinute, 'minutes').toDate();
  const { data } = await InternalClient.getRide().instance.get('rides', {
    params: { take: 100, showTerminated: false, endedAt },
  });

  return data.rides;
}

async function terminateRide(rideId: string): Promise<void> {
  await InternalClient.getRide().instance.delete(`rides/${rideId}`, {
    params: { terminatedType: 'UNUSED' },
  });
}

async function hasNoMovement(kickboardCode: string): Promise<boolean> {
  const endedAt = dayjs().subtract(maxMinute, 'minutes').toDate();
  const kickboard = await KickboardModel.findOne({ kickboardCode });
  if (!kickboard) {
    logger.warn(`${kickboardCode}의 킥보드 정보를 불러올 수 없습니다.`);
    return false;
  }

  const res = await StatusModel.aggregate([
    {
      $match: {
        kickboardId: kickboard.kickboardId,
        createdAt: { $gt: endedAt },
      },
    },
    {
      $group: {
        _id: {
          $add: [
            {
              $subtract: [
                { $subtract: ['$createdAt', new Date(0)] },
                {
                  $mod: [
                    { $subtract: ['$createdAt', new Date(0)] },
                    1000 * 60 * 15,
                  ],
                },
              ],
            },
            new Date(0),
          ],
        },
        isEnabled: { $avg: { $cond: ['$isEnabled', 0, 1] } },
        latitude: { $stdDevSamp: '$gps.latitude' },
        longitude: { $stdDevSamp: '$gps.longitude' },
        speed: { $avg: '$speed' },
      },
    },
    { $sort: { createdAt: -1 } },
    { $limit: 1 },
  ]);

  console.log(res[0]);
  return (
    res.length > 0 &&
    res[0].isEnabled === 0 &&
    // res[0].latitude === 0 &&
    // res[0].longitude === 0 &&
    res[0].speed === 0
  );
}

main();
