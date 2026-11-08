# Apple Music 컨트롤 — 스트림덱 플러그인

Mac 의 **Music 앱(Apple Music)** 을 Stream Deck 버튼으로 조작해요.

| 버튼 | 누르면 | 버튼에 보이는 것 |
|---|---|---|
| ⏮ **이전 곡** | 이전 곡 (곡 중간이면 처음으로 — Music 앱의 ⏮ 와 같아요) | |
| ⏯ **재생 / 일시정지** | 재생 ↔ 일시정지 | 재생 중이면 ❚❚ + **곡 제목**, 멈춰 있으면 ▶ + "일시정지" |
| ⏭ **다음 곡** | 다음 곡 | |

- Music 앱이 꺼져 있으면 버튼이 흐려지고 **"Music 열기 / 실행 중 아님"** 이 떠요. 그때 아무 버튼이나 누르면 Music 앱이 열려요.
- 버튼은 1.5초마다 Music 앱 상태를 확인해서 저절로 바뀌어요 (Music 앱이나 키보드로 재생해도 따라와요).
- 필요한 것: **Mac** + **Stream Deck 앱 6.5 이상**. 마스코트 앱과는 상관없이 따로 동작해요.

## 설치

1. [Releases 페이지](https://github.com/etude-live/Live-2d-pet/releases?q=applemusic)에서 맨 위 **`Apple Music 컨트롤 v…`** 를 열어요.
2. **Assets** 의 **`AppleMusic-Control-StreamDeck-….streamDeckPlugin`** 을 받아 **더블클릭** → **설치**.
3. Stream Deck 앱 오른쪽 목록의 **"Apple Music 컨트롤"** 에서 버튼 3개를 끌어다 놓아요.

## 처음 한 번: 권한 허용

처음 버튼을 쓸 때 Mac 이 이렇게 물어요:

> "Stream Deck" 이(가) "Music" 을(를) 제어하려고 합니다.

**확인(허용)** 을 누르세요. 거절했다면 버튼에 주황색 **"권한 필요"** 가 떠요. 이렇게 고쳐요:

1. **시스템 설정 → 개인정보 보호 및 보안 → 자동화**
2. **Stream Deck** 아래의 **Music** 을 켜기
3. 그래도 안 되면 Stream Deck 앱을 껐다 켜기

## 업데이트

Releases 에서 더 새 파일을 받아 더블클릭 → 설치. 놓아 둔 버튼은 그대로 남아요.

---

## 개발자용

- `src/music.ts`: AppleScript(osascript)로 Music 조작·상태 확인. 모든 스크립트가 `application "Music" is running` 을 먼저 봐서, 꺼져 있을 때 Music 을 켜 버리지 않아요.
- `src/buttons.ts`: 버튼 3개의 그림·제목·누름. `src/plugin.ts`: Stream Deck SDK(@elgato/streamdeck) 연결.
- 테스트: `npm test` (가짜 Music), `npm run build && npm run e2e` (빌드된 플러그인 ↔ 가짜 Stream Deck ↔ 가짜 osascript),
  `node scripts/check-applescript.mjs` (Mac 에서만: 스크립트를 진짜 Music 용어로 컴파일).
- 릴리스: `.github/workflows/applemusic-plugin.yml` (macOS 러너, 태그 `applemusic-N`, Latest 로 표시하지 않음).
