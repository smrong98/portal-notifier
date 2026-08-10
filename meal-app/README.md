# Meal Notifier

기존 개인용 Portal Worker가 파싱한 식단만 받아 공개하는 독립 Cloudflare Worker/PWA입니다. 포탈 계정, 쿠키, 게시판, 원본 PDF URL은 이 앱에 저장하지 않습니다.

## 구성

- Static Assets: `public/` PWA
- KV `MEALS`: 정제된 최근 식단 3주
- D1 `DB`: 기기별 Push 구독과 알림 설정
- Queue `PUSH_QUEUE`: 사용자별 Web Push 분산 발송
- Cron: 5분마다 발송 대상 조회
- Service Binding `MealPublisher`: 기존 비공개 Worker 전용 식단 게시 RPC

기존 `portal-notifier` Worker는 한국시간 매주 토요일 오전 9시에 식단 PDF를 다시 읽고,
Service Binding으로 이 앱에 게시합니다. 새 사용자의 기본 알림 시간은 조식 07:00,
중식 11:00, 석식 16:30입니다.
설정의 `주말에도 알림 받기`를 끄면 토요일과 일요일에는 알림 발송 대상에서 제외됩니다.
토요일에 다음 주 식단이 게시되어도 주말이 지나기 전에는 현재 날짜보다 앞선 가장 최근 주차를 사용합니다.

## 로컬 준비

```powershell
cd meal-app
npm install
Copy-Item .dev.vars.example .dev.vars
npm run vapid
```

생성된 VAPID 값을 `.dev.vars`에 넣은 다음 로컬 D1 마이그레이션과 개발 서버를 실행합니다.

```powershell
npm run db:migrate:local
npm run dev
```

로컬 Queue와 Cron은 Wrangler가 시뮬레이션합니다. 예약 핸들러는 개발 서버의 `/__scheduled` 경로로 시험할 수 있습니다.

## 최초 배포 순서

`wrangler.jsonc`는 KV, D1, Queue의 자동 프로비저닝을 사용합니다.

1. `npm run deploy`로 `meal-notifier` Worker와 리소스를 생성합니다.
2. `npm run db:migrate:remote`로 D1 스키마를 적용합니다.
3. 아래 세 Secret을 대화형으로 등록합니다.

```powershell
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

4. 다시 `npm run deploy`를 실행합니다.
5. 기존 `worker/`를 배포해 `MEAL_APP` Service Binding을 연결합니다.
6. 기존 개인 앱에서 식단 새로고침을 한 번 실행해 첫 식단을 게시합니다.

Secret 값은 명령 인수, 소스 코드, `wrangler.jsonc`에 넣지 않습니다. `VAPID_SUBJECT`는 `mailto:you@example.com` 형식입니다.

## 검증

```powershell
npm test
npm run check
```

무료 플랜에서는 Queue 메시지를 사용자별로 발행하는 안정적인 기본 구조를 사용합니다. 활성 사용자가 수백 명 이상으로 늘어나면 여러 구독 ID를 한 메시지로 묶는 방식으로 확장할 수 있습니다.
