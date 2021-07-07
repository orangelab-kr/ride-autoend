import {
  Webhook,
  auth,
  firestore,
  getPrice,
  iamport,
  logger,
  send,
} from './tools';
import dayjs, { Dayjs } from 'dayjs';

import mqtt from 'mqtt';

const rideCol = firestore.collection('ride');
const userCol = firestore.collection('users');
const kickCol = firestore.collection('kick');
const mqttClient = mqtt.connect(String(process.env.MQTT_URL), {
  username: String(process.env.MQTT_USERNAME),
  password: String(process.env.MQTT_PASSWORD),
});

const helmetPrice = 15500;
const maxHours = Number(process.env.MAX_HOUR || 3);
const sleep = (timeout: number) =>
  new Promise((resolve) => setTimeout(resolve, timeout));
const waitForConnect = () =>
  new Promise<void>((resolve) => {
    mqttClient.on('connect', () => {
      mqttClient.subscribe('data/#');
      logger.info(`서버와 연결되었습니다.`);
      resolve();
    });
  });

enum HelmetStatus {
  READY = 0,
  USING = 1,
  RETURNED = 2,
  LOST_PAID = 3,
  LOST_UNPAID = 4,
  NOT_WORKING = 5,
}

interface User {
  uid: string;
  username: string;
  phone: string | null;
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
  helmet: HelmetStatus;
  startedAt: Dayjs;
  endedAt: Dayjs;
}

async function main() {
  try {
    logger.info('시스템을 시작합니다.');
    await waitForConnect();
    mqttClient.on('error', (err) => {
      throw err;
    });

    while (true) {
      logger.info('작업을 시작합니다.');
      await runSchedule();
      logger.info('5분 동안 대기합니다.');
      await sleep(5 * 60 * 1000);
    }
  } catch (err) {
    await Webhook.send(`❌ 오류가 발생하여 시스템을 재시작합니다.`);
    logger.error(err.message);
    logger.error(err.stack);
  }
}

async function runSchedule() {
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
      logger.warn(`사용자를 찾을 수 없습니다. ${JSON.stringify(user)}`);
      logger.warn(usedAt);
      continue;
    }

    if (!user.phone) {
      user.phone = await getPhoneByAuth(user);
      if (!user.phone) {
        logger.info(`이름 또는 전화번호가 올바르지 않습니다. 무시합니다.`);
        break;
      }
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

    await terminateRide(ride, user);
  }
}

async function isLastRide(ride: Ride): Promise<boolean> {
  const rides = await rideCol
    .where('kickName', '==', ride.kickboardId)
    .orderBy('start_time', 'desc')
    .limit(1)
    .get();

  let rideId;
  rides.forEach((res) => (rideId = res.id));
  return rideId ? ride.rideId === rideId : false;
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
  if (!user.phone) return;
  const failed = '결제에 실패했습니다. 앱에서 재결제가 필요합니다.';
  const minutes = ride.endedAt.diff(ride.startedAt, 'minutes');
  const ridePrice = await getPrice(ride.branch, minutes);
  const payment = await tryPayment(user, ride, ridePrice);
  const diff = ride.endedAt.diff(ride.startedAt, 'minutes');
  const startedAt = ride.startedAt.format('YYYY년 MM월 DD일 HH시 mm분');
  const endedAt = ride.endedAt.format('HH시 mm분');
  const usedAt = `${startedAt} ~ ${endedAt}(${diff}분)`;
  const userDoc = userCol.doc(user.uid);
  const cardName = payment ? payment.cardName : failed;
  const priceStr = `${ridePrice.toLocaleString()}원`;
  const props = { user, ride, usedAt, maxHours, priceStr, cardName };
  const isLast = await isLastRide(ride);
  user.username = user.username || '고객';
  if (isLast) await stopKickboard(ride);

  await Promise.all([
    userDoc.update({
      curr_ride: null,
      currcoupon: null,
    }),
    rideCol.doc(ride.rideId).update({
      cost: payment ? ridePrice : 0,
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

  if (ride.helmet === HelmetStatus.USING) {
    const priceStr = `${helmetPrice.toLocaleString()}원`;
    const helmetPayment = await tryPayment(user, ride, helmetPrice);
    if (!helmetPayment) {
      logger.info(
        `⛑ 🤬 ${user.username}님 킥보드(${ride.kickboardName}) 헬멧이 자동으로 분실 처리되었으며 결제에 실패하였습니다. ${cardName} / ${user.phone} / ${ride.branch}`
      );

      await Promise.all([
        Webhook.send(
          `⛑ 🤬 ${user.username}님 킥보드(${ride.kickboardName}) 헬멧이 자동으로 분실 처리되었으며 결제에 실패하였습니다. ${cardName} / ${user.phone} / ${ride.branch}`
        ),
        rideCol.doc(ride.rideId).update({
          helmet: HelmetStatus.LOST_UNPAID,
        }),
      ]);

      return;
    }

    logger.info(
      `⛑ 😓 ${user.username}님 킥보드(${ride.kickboardName}) 헬멧이 자동으로 분실 처리되었으며 결제에 성공하였습니다. ${cardName} / ${user.phone} / ${ride.branch}`
    );

    await Promise.all([
      Webhook.send(
        `⛑ 😓 ${user.username}님 킥보드(${ride.kickboardName}) 헬멧이 자동으로 분실 처리되었으며 결제에 성공하였습니다. ${cardName} / ${user.phone} / ${ride.branch}`
      ),
      send(
        user.phone,
        'TE_9778',
        `헬멧이 분실 처리되었습니다.`,
        {
          user,
          priceStr,
        },
        {
          button_1: JSON.stringify({
            button: [{ name: '고객센터 연결', linkType: 'MD' }],
          }),
        }
      ),
      rideCol.doc(ride.rideId).update({
        helmet: HelmetStatus.LOST_PAID,
      }),
    ]);
  }
}

async function getKickboardCodeById(
  kickboardId: string
): Promise<string | null> {
  const kickboard = await kickCol.doc(kickboardId).get();
  const data = kickboard.data();
  return data && data.code;
}

async function stopKickboard(ride: Ride): Promise<void> {
  await kickCol.doc(ride.kickboardId).update({ can_ride: true });
  mqttClient.publish(ride.kickboardId, JSON.stringify({ cmd: 'stop' }));
}

async function tryPayment(
  user: User,
  ride: Ride,
  price: number
): Promise<{ merchantUid: string; cardName: string } | null> {
  if (!user.billingKeys || !user.phone) return null;
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
      await sleep(5000);
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
    helmet: data.helmet,
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
  const inuseRides =
    process.env.NODE_ENV === 'prod'
      ? await rideCol
          .where('start_time', '<', subtractDayjs.toDate())
          .where('end_time', '==', null)
          .orderBy('start_time', 'asc')
          .get()
      : await rideCol
          .where('uid', '==', 'q3h0TuEmJZYuBWNWx722XKiOXSg1')
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
      helmet: data.helmet,
      startedAt: dayjs(data.start_time._seconds * 1000),
      endedAt: data.end_time ? dayjs(data.end_time._seconds * 1000) : dayjs(),
      kickboardName: data.kick,
      kickboardId: data.kickName,
      payment: data.payment,
    });
  });

  return rides;
}

async function getPhoneByAuth(user: User): Promise<string | null> {
  try {
    const authUser = await auth.getUser(user.uid);
    if (!authUser.phoneNumber) return null;
    await userCol.doc(user.uid).update({ phone: authUser.phoneNumber });
    logger.info(
      `${user.username}님의 전화번호를 인증 서버로부터 가져왔습니다.`
    );

    return authUser.phoneNumber;
  } catch (err) {
    logger.error(err.message);
    logger.info(err.stack);
    return null;
  }
}

main();
