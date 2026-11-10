# 차박 하룻밤 — NestJS 서버 (명세 v1.0 구현)

에뮬레이터 시연용 백엔드. **서버가 증명하는 것은 계약·상태기계·경보 시나리오**이고, Pleos 제어 성공이나 실차 센서 감지를 증명하지 않는다.
모든 이벤트·세션·명령에 `executionMode` (MOCK | PLEOS_EMULATOR | REAL) 가 따라간다.

## 실행

```bash
cp .env.example .env          # 비밀값 교체
npm i
npx prisma migrate deploy     # PostgreSQL 필요 (DATABASE_URL)
npm run build && npm start    # :3000  (개발: npm run start:dev)
npm run demo:e2e              # 시연 경로 84개 검증 (서버 떠 있어야 함, ~30초)
```

`tsx`로 직접 실행하면 DI가 깨진다(데코레이터 메타데이터 미생성). 반드시 `nest build` 또는 `nest start`.

## 인증 — "api 키" 계약

| 주체 | 토큰 | scope | 얻는 방법 |
|---|---|---|---|
| 폰 앱 사용자 | JWT (15분) + refresh 회전 | `user` | `POST /v1/auth/sessions` |
| 차량 AAOS 앱 | `dvt_…` 불투명 장치 토큰 | `vehicle` | `POST /v1/devices/vehicle/enroll` (설치 비밀 `VEHICLE_ENROLL_SECRET`) — **1회만 반환, 서버는 해시만 저장** |
| 폰 BLE 센서 역할 | `dvt_…` | `sensor` | `POST /v1/vehicles/:id/sensor-tokens` (사용자 JWT로) |

모든 요청: `Authorization: Bearer <token>`. 라우트마다 허용 scope가 다르며 불일치는 403.
QR은 토큰이 아니다 — 페어링 챌린지(120초, 1회용)일 뿐이고, 차량 화면에서 사용자가 confirm 해야 링크가 ACTIVE 된다.

### 차량 앱(Kotlin) 부트스트랩 순서

```
1. POST /v1/devices/vehicle/enroll {enrollSecret, displayName, powertrain}
   → {deviceId, vehicleId, deviceToken}  // EncryptedSharedPreferences 에 저장
2. POST /v1/pairings  (Bearer dvt_)  → {challengeId, qrPayload, expiresAt}  // QR 표시
3. (폰) POST /v1/pairings/:id/claim {secret}
4. POST /v1/pairings/:id/confirm (Bearer dvt_)  // 차량 화면 "이 사람 맞습니까?"
5. POST /v1/vehicles/:vehicleId/capability-reports   // SDK check*Capabilities 결과 그대로
6. POST /v1/vehicles/:vehicleId/heartbeats  10초 주기  {executionMode, powerState}
7. POST /v1/vehicles/:vehicleId/telemetry-batches     // get*/register* 콜백 값. 결측은 null, 0 아님
8. WSS  /v1/ws?token=dvt_…&vehicleId=…&since=<ISO>   // COMMAND_DISPATCH, PLAN_UPDATED 수신
9. POST /v1/commands/:id/results {status: ACCEPTED→VERIFIED, observed}  // SDK 콜백=ACCEPTED, readback=VERIFIED
```

## 엔드포인트 (전부 `/v1`)

| 영역 | 경로 |
|---|---|
| 인증 | `POST auth/sessions`, `POST auth/refresh`, `POST devices/vehicle/enroll`, `POST devices/push-token` |
| 페어링 | `POST pairings`, `POST pairings/:id/claim`, `POST pairings/:id/confirm`, `DELETE vehicle-links/:id` |
| 계정 | `GET/POST consents`, `GET/PUT emergency-contacts`, `POST emergency-contacts/test-sms`, `POST vehicles/:id/sensor-tokens`, `DELETE account` |
| 차량 | `GET vehicles/:id/capabilities`, `POST …/capability-reports`, `POST …/telemetry-batches`, `POST …/heartbeats`, `GET …/state` |
| 예약 | `POST trips`, `GET/PATCH trips/:id`, `GET vehicles/:id/trips/upcoming`, `POST trips/:id/sync-acks` |
| 콘텐츠 | `GET places/search`, `GET places/:id/briefing`, `GET places/:id/alternatives`, `GET weather/night`, `GET sun`, `POST power-plans`, `POST/PATCH reviews` |
| 취침 | `POST sleep-sessions`, `GET …/:id`, `PATCH …/:id/plan`, `POST …/:id/preflight`, `POST …/:id/start`, `POST …/:id/stop`, `GET …/:id/summary`, `GET …/:id/alerts` |
| 명령 | `POST vehicles/:id/commands`, `GET commands/:id`, `POST commands/:id/results` |
| 경보 | `POST alerts`, `POST alerts/test`, `POST alerts/:id/acknowledgements`, `POST alerts/:id/contact-notifications`, `POST delivery-receipts` |
| 데모 | `GET/POST demo/scenarios` (NODE_ENV=production 에서 모듈 미등록) |
| 기타 | `GET health`, `WSS /v1/ws` |

부작용 POST(`trips`, `sleep-sessions`, `commands`, `contact-notifications`, `test-sms`)는 `Idempotency-Key` 헤더 필수. 같은 키·다른 본문은 409.

## 명세 대비 구현된 안전 규칙

- preflight: ICE/HEV/PHEV/UNKNOWN 차단, 도어·창문 미확인/미잠금 차단, SOC 미확인·30% 미만 차단, CO 미측정은 경고(차단 아님), hvac capability min/max 교집합.
- `state.derived.effectiveVentilation` 은 항상 `UNKNOWN` — 외기·팬 관측은 따로 노출.
- `co2Ppm`/`coPpm`/`oxygenPct` 별도 metric. CO₂에서 CO 추론 없음.
- 명령 allowlist: REAL은 비어 있음. PLEOS_EMULATOR는 공조만. MOCK은 권한 없이 상태기계 시연 가능.
- ACCESS_DETECTED 는 MOCK 에서만 수용(공개 센서 API 없음). 사용자 응답 타이머 30초; CO/CO₂ critical 은 0초.
- RECEIVED/DISPLAYED 영수증은 기술 ACK — 사용자 응답 타이머를 멈추지 않는다.
- SMS 는 사용자 명시 요청(`userActionId`) + 멱등 + alert당 5분 1회. 공급자 접수 ≠ 수신.
- 센서 15초 무수신 → `SENSOR_DISCONNECTED`, 값은 STALE. 세션 요약은 결측을 "기록 없음/부분 기록" 으로 표시.
- 세션 stop 시 미완료 명령 전부 CANCELLED, 만료 명령은 재연결 시 재생 안 함.

## 외부 공급자

전부 fixture. `.env` 의 `*_PROVIDER` 를 바꾸고 어댑터를 붙이기 전까지 장소·기상·후기는 DEMO 데이터이며 응답에 그렇게 표시된다.

## 하지 않은 것

- Pleos SDK 호출 (차량 앱 몫). 서버는 SDK를 모른다.
- FCM/SMS 실제 발송 (`log` 공급자).
- BLE. 폰 센서는 `sensor` 토큰으로 HTTP 업로드.
- 법무 검토된 약관·동의 문구.
