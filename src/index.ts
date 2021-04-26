import dayjs, { Dayjs } from 'dayjs';
import { firestore, getPrice, iamport, logger, send, Webhook } from './tools';

const rideCol = firestore.collection('ride');
const userCol = firestore.collection('users');
const kickCol = firestore.collection('kick');

const maxHours = Number(process.env.MAX_HOUR || 3);
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
  endedAt: Dayjs;
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

    if (user.currentRide !== ride.rideId) {
      logger.info('중복 처리된 데이터입니다. 삭제 처리합니다.');
      await deleteRide(ride, user);
      continue;
    }

    // await terminateRide(ride, user);
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

async function terminateRide(ride: Ride, user: User): Promise<void> {
  const failed = '결제에 실패했습니다. 앱에서 재결제가 필요합니다.';
  const minutes = ride.endedAt.diff(ride.startedAt, 'minutes');
  const price = await getPrice(ride.branch, minutes);
  const payment = await tryPayment(user, ride, price);
  const diff = ride.endedAt.diff(ride.startedAt, 'minutes');
  const startedAt = ride.startedAt.format('YYYY년 MM월 DD일 HH시 mm분');
  const endedAt = ride.endedAt.format('HH시 mm분');
  const usedAt = `${startedAt} ~ ${endedAt}(${diff}분)`;
  const userDoc = userCol.doc(user.uid);
  const cardName = payment ? payment.cardName : failed;
  const priceStr = `${price.toLocaleString()}원`;
  const props = { user, ride, usedAt, maxHours, priceStr, cardName };

  // add stop kickboard
  await Promise.all([
    kickCol.doc(ride.kickboardId).update({
      can_ride: true,
    }),
    userDoc.update({
      curr_ride: null,
      currcoupon: null,
    }),
    rideCol.doc(ride.rideId).update({
      cost: payment ? price : 0,
      payment: payment && payment.merchantUid,
      end_time: ride.endedAt.toDate(),
    }),
    userDoc.collection('ride').add({
      branch: ride.branch,
      end_time: ride.endedAt.toDate(),
      ref: `ride/${ride.rideId}`,
      start_time: ride.startedAt.toDate(),
      unpaied: !payment,
    }),
    send(
      user.phone,
      'TE_2511',
      `킥보드(${ride.kickboardName})가 자동으로 이용 종료되었습니다.`,
      props
    ),
    Webhook.send(
      `✅ ${user.username}님이 3시간 이상 이용하여 자동으로 종료되었습니다. ${cardName} / ${usedAt} / ${user.phone} / ${ride.branch} / ${priceStr}`
    ),
  ]);
}

async function tryPayment(
  user: User,
  ride: Ride,
  price: number
): Promise<{ merchantUid: string; cardName: string } | null> {
  try {
    const merchantUid = `${Date.now()}`;
    for (const billingKey of user.billingKeys) {
      const res = await iamport.subscribe.again({
        customer_uid: billingKey,
        merchant_uid: merchantUid,
        amount: price,
        name: ride.branch,
        buyer_name: user.username,
        buyer_tel: user.phone,
      });

      if (res.status === 'paid') {
        logger.info(`결제에 성공하였습니다. ${billingKey}`);
        return {
          merchantUid,
          cardName: `${res.card_number} (${res.card_name})`,
        };
      }

      logger.info(`결제 실패, ${res.fail_reason}`);
      await sleep(3000);
    }
  } catch (err) {
    logger.error('결제 오류가 발생하였습니다. ' + err.name);
    logger.error(err.stack);
  }

  return null;
}

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
    endedAt: data.end_time ? dayjs(data.end_time._seconds * 1000) : dayjs(),
  };
}

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
  const subtractDayjs = dayjs().subtract(3, 'hours');
  const inuseRides = await rideCol
    .where('start_time', '<', subtractDayjs.toDate())
    // .where('uid', '==', 'Lf6lP5Pv1rTPViWUJwKvmMGPwHj2')
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
      endedAt: data.end_time ? dayjs(data.end_time._seconds * 1000) : dayjs(),
      kickboardName: data.kick,
      kickboardId: data.kickName,
      payment: data.payment,
    });
  });

  return rides;
}

main();
