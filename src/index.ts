import dayjs, { Dayjs } from 'dayjs';
import { firestore, getPrice, logger } from './tools';

const rideCol = firestore.collection('ride');
const userCol = firestore.collection('users');

const maxHour = Number(process.env.MAX_HOUR || 3);
const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));

interface User {
  uid: string;
  username: string;
  phone: string;
  currentRide: string | null;
  birthday: Dayjs;
  billingKeys: string[];
}

interface Ride {
  rideId: string;
  userId: string;
  branch: string;
  cost: number;
  coupon: string;
  kickboardName: string;
  kickboardId: string;
  payment?: string;
  startedAt: Dayjs;
  endedAt: Dayjs | null;
}

async function main() {
  logger.info('시스템을 시작합니다.');
  const rides = await getRides();
  let i = 0;
  for (const ride of rides) {
    logger.info(
      '==========================================================================='
    );

    const now = dayjs();
    const user = await getUser(ride.userId);
    const diff = now.diff(ride.startedAt, 'minutes');
    const price = await getPrice(ride.branch, diff);
    const startedAt = ride.startedAt.format('YYYY년 MM월 DD일 HH시 mm분');
    const usedAt = `${startedAt} ~ (${diff}분, ${price.toLocaleString()}원)`;

    if (!user) {
      logger.warn('사용자를 찾을 수 없습니다.');
      logger.warn(usedAt);
      continue;
    }

    const birthday = user.birthday.format('YYYY년 MM월 DD일');
    logger.info(
      `${i++} >> ${user.username}님 ${user.phone} ${birthday} - ${usedAt}`
    );
    // await deleteRide(ride, user);
    // await terminateRide(ride, user);
    if (user.currentRide !== ride.rideId) {
      await deleteRide(ride, user);
    }
  }
}

async function getUser(uid: string): Promise<User | undefined> {
  const userDoc = await userCol.doc(uid).get();
  const userData = userDoc.data();
  if (!userData) return;

  return {
    uid: userDoc.id,
    username: userData.name,
    phone: userData.phone,
    currentRide: userData.curr_ride ? userData.curr_ride.id : null,
    birthday: dayjs(userData.birth._seconds * 1000),
    billingKeys: userData.billkey,
  };
}

// async function endRide(ride: Ride, user: User, endedAt: Dayjs): Promise<void> {

// }

async function getRideById(rideId: string): Promise<Ride | null> {
  const ride = await rideCol.doc(rideId).get();
  const data = ride.data();
  if (!data) return null;

  return {
    rideId: ride.id,
    userId: data.uid,
    branch: data.branch,
    cost: data.cost,
    coupon: data.coupon,
    kickboardName: data.kick,
    kickboardId: data.kickName,
    payment: data.payment,
    startedAt: dayjs(data.start_time._seconds * 1000),
    endedAt: data.end_time ? dayjs(data.end_time._seconds * 1000) : null,
  };
}

// async function terminateRide(ride: Ride, user: User): Promise<void> {
//   console.log(user, ride);
//   if (user.currentRide === ride.rideId) {
//     logger.info(`탑승 중인 라이드입니다. 강제로 종료합니다.`);
//     // await userCol.doc(user.uid).update({ curr_ride: null, currcoupon: null });
//   }

//   const ref = `ride/${ride.rideId}`;
//   const userRides = await userCol
//     .doc(user.uid)
//     .collection('ride')
//     .where('ref', '==', ref)
//     .get();

//   let userRideId;
//   userRides.forEach((ride) => (userRideId = ride.id));
//   if (userRideId) {
//     logger.info(`이미 결제된 라이드입니다.`);
//     // await userCol.doc(user.uid).collection('ride').doc(userRideId).delete();
//   }

//   // await rideCol.doc(ride.rideId).delete();
// }

async function deleteRide(ride: Ride, user: User): Promise<void> {
  if (user.currentRide === ride.rideId) {
    logger.info(`탑승 중인 라이드입니다. 강제로 종료합니다.`);
    await userCol.doc(user.uid).update({ curr_ride: null, currcoupon: null });
  }

  const ref = `ride/${ride.rideId}`;
  const userRides = await userCol
    .doc(user.uid)
    .collection('ride')
    .where('ref', '==', ref)
    .get();

  let userRideId;
  userRides.forEach((ride) => (userRideId = ride.id));
  if (userRideId) {
    logger.info(`이미 결제된 라이드입니다.`);
    await userCol.doc(user.uid).collection('ride').doc(userRideId).delete();
  }

  await rideCol.doc(ride.rideId).delete();
}

async function getRides(): Promise<Ride[]> {
  const rides: Ride[] = [];
  const subtractDayjs = dayjs().subtract(1, 'month');
  // const subtractDayjs = dayjs('2021-01-01');
  const inuseRides = await rideCol
    .where('start_time', '<', subtractDayjs.toDate())
    .where('end_time', '==', null)
    .orderBy('start_time', 'asc')
    .get();

  logger.info(`반납 안한 라이드, ${inuseRides.size}개 발견하였습니다.`);
  inuseRides.forEach((ride) => {
    const data = ride.data();
    rides.push({
      rideId: ride.id,
      userId: data.uid,
      branch: data.branch,
      cost: data.cost,
      coupon: data.coupon,
      startedAt: dayjs(data.start_time._seconds * 1000),
      endedAt: data.end_time ? dayjs(data.end_time._seconds * 1000) : null,
      kickboardName: data.kick,
      kickboardId: data.kickName,
      payment: data.payment,
    });
  });

  return rides;
}

main();
