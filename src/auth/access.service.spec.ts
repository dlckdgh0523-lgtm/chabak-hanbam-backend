import { AccessService } from './access.service';
import { PrismaService } from '../prisma/prisma.service';
import { carPrincipal, createPrismaMock, expectApiError, PrismaMock, sensorPrincipal, userPrincipal } from '../testing/helpers';

// 2.3.6 차량 접근 / 2.3.7 예약 접근
// [이 파일의 의도]
// 차량/예약/세션 접근 권한. 권한이 없을 때 403 이 아니라 404 를 주는 이유:
// 403 이면 "그 ID 는 존재한다"는 정보를 주게 되어, 남의 차량·예약 ID 를 추측해 볼 수 있다.
describe('AccessService', () => {
  let prisma: PrismaMock;
  let access: AccessService;

  beforeEach(() => {
    prisma = createPrismaMock();
    access = new AccessService(prisma as unknown as PrismaService);
  });

  describe('2.3.6 차량 접근 assertVehicle', () => {
    // 의도: 연결 상태가 ACTIVE 인 것만 인정한다. REVOKED(연결 해제)나 claim 단계 연결은 접근 근거가 아니다.
    it('1. 사용자는 ACTIVE 연결이 있는 차량만 접근 가능하다', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-1', userId: 'user-1', deviceId: 'car-1' });

      await expect(access.assertVehicle(userPrincipal('user-1'), 'vehicle-1')).resolves.toMatchObject({ id: 'link-1' });
      expect(prisma.vehicleLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-1', vehicleId: 'vehicle-1', status: 'ACTIVE' } }));
    });

    // 의도: QR 사진만 찍고 차량 승인(confirm)을 받지 못한 사람이 차량에 접근하면 안 된다.
    it('1. 사용자에게 ACTIVE 연결이 없으면 (claim 만 했거나 REVOKED) 404', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      await expectApiError(access.assertVehicle(userPrincipal(), 'vehicle-1'), 'NOT_FOUND', 404);
    });

    // 의도: 차량 앱은 페어링 전에도 기능 보고, heartbeat, QR 생성을 해야 하므로 "등록된 자기 차량"이면 접근 가능해야 한다.
    it('2. 자동차 장치는 페어링 여부와 상관없이 자기가 등록된 차량에 접근 가능하다', async () => {
      prisma.device.findUnique.mockResolvedValue({ enrolledVehicleId: 'vehicle-1' });

      await expect(access.assertVehicle(carPrincipal('car-1'), 'vehicle-1')).resolves.toMatchObject({ deviceId: 'car-1' });
      expect(prisma.vehicleLink.findFirst).not.toHaveBeenCalled();
    });

    // 의도: 차량 앱 토큰 하나로 다른 차량을 조회하거나 제어하지 못하게.
    it('2. 자동차 장치가 다른 차량에 접근하면 404', async () => {
      prisma.device.findUnique.mockResolvedValue({ enrolledVehicleId: 'vehicle-1' });
      await expectApiError(access.assertVehicle(carPrincipal('car-1'), 'vehicle-2'), 'NOT_FOUND', 404);
    });

    // 의도: 센서 폰은 발급받은 차량(ACTIVE 연결)에만 값을 올릴 수 있다.
    it('3. 센서-폰 장치는 ACTIVE 연결이 있는 차량만 접근 가능하다', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue({ id: 'link-s', userId: 'user-1', deviceId: 'sensor-1' });

      await access.assertVehicle(sensorPrincipal('sensor-1'), 'vehicle-1');
      expect(prisma.vehicleLink.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { deviceId: 'sensor-1', vehicleId: 'vehicle-1', status: 'ACTIVE' } }));
    });

    // 의도: 재발급이나 연결 해제로 REVOKED 된 센서가 계속 값을 올려 상태를 오염시키지 못하게.
    it('4. 센서-폰 장치에 ACTIVE 연결이 없으면 404', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      await expectApiError(access.assertVehicle(sensorPrincipal(), 'vehicle-1'), 'NOT_FOUND', 404);
    });
  });

  describe('2.3.7 예약 접근 assertTrip', () => {
    // 의도: 예약에는 위치와 일정(언제 어디서 자는지)이 들어 있다.
    it('1. 사용자는 본인이 만든 예약만 접근 가능하다', async () => {
      prisma.trip.findUnique.mockResolvedValue({ id: 'trip-1', userId: 'user-1', vehicleId: 'vehicle-1' });
      await expect(access.assertTrip(userPrincipal('user-1'), 'trip-1')).resolves.toMatchObject({ id: 'trip-1' });
    });

    // 의도: 남의 예약은 "없는 것"과 같은 응답이어야 존재 여부가 드러나지 않는다.
    it('1. 다른 사용자의 예약이면 404 (존재 여부를 숨긴다)', async () => {
      prisma.trip.findUnique.mockResolvedValue({ id: 'trip-1', userId: 'other', vehicleId: 'vehicle-1' });
      await expectApiError(access.assertTrip(userPrincipal('user-1'), 'trip-1'), 'NOT_FOUND', 404);
    });

    // 의도: 없는 예약과 남의 예약이 같은 응답인지 비교하기 위한 기준.
    it('없는 예약이면 404', async () => {
      prisma.trip.findUnique.mockResolvedValue(null);
      await expectApiError(access.assertTrip(userPrincipal(), 'nope'), 'NOT_FOUND', 404);
    });

    // 의도: 차량 앱은 자기 차량의 예약만 내려받는다.
    it('2. 자동차 장치는 해당 예약의 차량에 접근할 수 있을 때만 접근한다', async () => {
      prisma.trip.findUnique.mockResolvedValue({ id: 'trip-1', userId: 'user-1', vehicleId: 'vehicle-1' });
      prisma.device.findUnique.mockResolvedValue({ enrolledVehicleId: 'vehicle-1' });
      await expect(access.assertTrip(carPrincipal(), 'trip-1')).resolves.toMatchObject({ id: 'trip-1' });

      prisma.device.findUnique.mockResolvedValue({ enrolledVehicleId: 'vehicle-2' });
      await expectApiError(access.assertTrip(carPrincipal(), 'trip-1'), 'NOT_FOUND', 404);
    });
  });

  describe('세션 접근 assertSession', () => {
    // 의도: 세션 접근 권한 = 그 세션 차량에 대한 접근 권한. 세션 ID 만 알아도 남의 세션을 보는 일이 없어야 한다.
    it('세션이 없으면 404, 있으면 세션 차량 접근 검사를 한다', async () => {
      prisma.sleepSession.findUnique.mockResolvedValueOnce(null);
      await expectApiError(access.assertSession(userPrincipal(), 's-1'), 'NOT_FOUND', 404);

      prisma.sleepSession.findUnique.mockResolvedValueOnce({ id: 's-1', vehicleId: 'vehicle-1' });
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      await expectApiError(access.assertSession(userPrincipal(), 's-1'), 'NOT_FOUND', 404);
    });
  });

  describe('vehicleIdForCarDevice', () => {
    // 의도: QR 을 만들 때 차량 ID 가 필요한데, 페어링 전에는 연결(VehicleLink)이 없으므로 enroll 정보로 찾아야 한다.
    it('페어링 전에도 등록된 차량 ID 를 돌려준다', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      prisma.device.findUnique.mockResolvedValue({ enrolledVehicleId: 'vehicle-1' });
      await expect(access.vehicleIdForCarDevice('car-1')).resolves.toBe('vehicle-1');
    });

    // 의도: 등록 정보가 지워진 장치가 QR 을 만들 수 없게.
    it('연결도 등록 차량도 없으면 404', async () => {
      prisma.vehicleLink.findFirst.mockResolvedValue(null);
      prisma.device.findUnique.mockResolvedValue({ enrolledVehicleId: null });
      await expectApiError(access.vehicleIdForCarDevice('car-1'), 'NOT_FOUND', 404);
    });
  });
});
