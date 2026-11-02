# 스트림덱(외부 프로그램) 연동 규격

데스크톱 마스코트(이 앱)는 켜져 있는 동안 **로컬 WebSocket 서버**를 엽니다.
스트림덱 플러그인 같은 외부 프로그램은 여기에 붙어서 **명령을 보내고**, **상태(포모도로 남은 시간·캐릭터가 일하는 중인지 등)를 받아** 버튼에 표시할 수 있습니다.

- 서버 코드: `src/main/bridge.js` · 명령 처리: `src/main/main.js` 의 `handleCommand()`
- 테스트용 클라이언트: `scripts/bridge-send.js`

## 1. 접속

앱이 켜질 때마다 접속 정보 파일을 새로 씁니다 (포트·토큰이 매번 바뀜, 앱이 꺼지면 지워짐).

| OS | 경로 |
|---|---|
| macOS | `~/Library/Application Support/Live2D Desktop Mascot/bridge.json` |
| Windows | `%APPDATA%\Live2D Desktop Mascot\bridge.json` |
| Linux | `~/.config/Live2D Desktop Mascot/bridge.json` |

```json
{ "v": 1, "app": "live2d-desktop-mascot", "version": "1.5.0", "host": "127.0.0.1", "port": 53123, "token": "…", "pid": 1234, "startedAt": "…" }
```

접속 주소: `ws://127.0.0.1:<port>/?token=<token>`

- `127.0.0.1` 에만 열립니다. **`Origin` 헤더가 있으면(브라우저) 거절**되므로, 스트림덱 플러그인은 브라우저가 아닌 **Node.js 플러그인(Stream Deck SDK v2, `@elgato/streamdeck`)** 에서 접속하세요.
- 파일이 없으면 = 앱이 꺼져 있음. 플러그인은 몇 초마다 파일을 다시 읽어 재접속해야 합니다 (앱 재시작 시 포트·토큰이 바뀜).
- 접속하면 `welcome` 메시지가 옵니다.

## 2. 메시지 형식

모든 메시지는 JSON 텍스트, 공통 필드 `v: 1`, `type`, `payload`, `ts`.

### 보내기: 명령

```json
{ "v": 1, "type": "command", "payload": { "id": 7, "name": "pomodoro.toggle", "args": {} } }
```

`id` 는 아무 값이나 (답에 그대로 돌아옴). 결과는 보낸 클라이언트에게만:

```json
{ "v": 1, "type": "result", "payload": { "id": 7, "name": "pomodoro.toggle", "ok": true, "state": { … } }, "ts": … }
```

실패: `{ "ok": false, "error": "claude-off" | "busy" | "empty" | "unknown-command" | "screen-permission" | "capture-failed" | … }`

### 받기: 상태 (모든 클라이언트에게 방송)

| type | payload | 언제 |
|---|---|---|
| `welcome` | `{ app, version, protocol }` | 접속 직후 |
| `agent` | `{ state: "working" \| "asking" \| "idle" }` | 캐릭터(Claude)가 일 시작 / 사용자 승인 기다림 / 끝 |
| `pomodoro` | `{ event, running, paused, phase, remainingSec, cycle, cycles, minutes: { work, break, long } }` | `event: "tick"` 은 타이머가 도는 동안 1초마다. 그 밖의 event: `work` `break` `long` `done` `stopped` `paused` `resumed` |
| `reminder` | `{ text }` | 맞춰 둔 알림이 울릴 때 |
| `usage` | `{ five_hour?: { utilization(0~1), resetsAt(ms), status }, seven_day?: {…}, … }` | Claude Pro/Max 사용량이 갱신될 때 (대화할 때마다) |
| `mode` | `{ claude }` | Claude 모드를 켜거나 껐을 때 |
| `expression` | `{ name }` | 표정이 바뀌었을 때 (`null` = 원래 얼굴). 버튼 켜짐 표시용 |
| `pong` | | `{ "v":1, "type":"ping" }` 에 대한 답 |

`phase`: `idle` / `work`(집중) / `break`(짧은 휴식) / `long`(긴 휴식).

## 3. 명령 목록

| name | args | 하는 일 | 결과 |
|---|---|---|---|
| `mode.toggle` | | Claude 모드 켜기/끄기 (끄면 혼잣말 피규어) | `claude` (true/false) |
| `mode.set` | `{ on }` | Claude 모드 켜기/끄기 | `claude` |
| `talk.open` | | 말 걸기 입력칸 열기 | |
| `talk.toggle` | | 열기/닫기 | |
| `talk.hide` | | 닫기 | |
| `talk.send` | `{ text }` | 캐릭터에게 이 말을 건넴 (입력칸에 친 것과 같음) | 바쁘면 `error: "busy"` |
| `agent.stop` | | 하던 일 멈추기 | |
| `agent.newChat` | | 새 대화 시작 (지난 대화는 기억으로 압축) | |
| `clip.translate` | | 클립보드 글 번역 → 결과를 클립보드에 | |
| `clip.polish` | | 클립보드 글 다듬기 → 결과를 클립보드에 | |
| `screen.ask` | `{ question? }` | 화면을 찍어 붙임. `question` 이 있으면 바로 물어봄, 없으면 입력칸에 첨부만 | macOS 화면 녹화 권한이 없으면 `error: "screen-permission"` |
| `pomodoro.start` | `{ work?, break?, long?, cycles? }` (분, 기본 25/5/15/4) | 시작 (돌고 있으면 새로 시작) | `state` |
| `pomodoro.toggle` | 위와 같음 | 돌고 있으면 끝, 아니면 시작 | `state` |
| `pomodoro.pause` | | 일시정지 / 다시 | `state` |
| `pomodoro.skip` | | 다음 단계로 | `state` |
| `pomodoro.stop` | | 끝 | `state` |
| `reminder.list` | | 알림 목록 | `reminders: [{ id, text, at(ms), daily("HH:MM"\|null) }]` |
| `expression.list` | | 지금 모델의 표정 이름 목록 (model3.json 의 Expressions) | `expressions: [이름…]`, `current` |
| `expression.set` | `{ name, text? }` | 그 표정으로 바꿈 (같은 걸 다시 보내면 원래 얼굴로). `text` 가 있으면 말풍선도 (토큰 0) | 없는 이름이면 `error: "no-such-expression"` |
| `expression.reset` | | 원래 얼굴로 | |
| `motion.play` | `{ text? }` | 몸짓 하나 (+ 말풍선) | |
| `mascot.say` | `{ text }` | 캐릭터가 말풍선으로 말함 (Claude 안 씀, 토큰 0) | |
| `state.get` | | 지금 상태 | `{ claude, agent, pomodoro, usage, build }` |
| `usage.get` | | 사용량 새로 가져오기 (가능하면) | `{ usage }` |

## 4. 터미널에서 시험

```bash
node scripts/bridge-send.js command '{"name":"pomodoro.toggle"}'
node scripts/bridge-send.js command '{"name":"talk.send","args":{"text":"안녕!"}}'
node scripts/bridge-send.js command '{"name":"screen.ask","args":{"question":"이 에러 뭐야?"}}'
```

## 5. 플러그인 버튼 아이디어

- 🍅 포모도로: 누르면 `pomodoro.toggle`, 길게 누르면 `pomodoro.skip`. 버튼 제목에 `remainingSec` 을 `mm:ss` 로, 집중/휴식에 따라 아이콘 바꾸기.
- 💬 말 걸기: `talk.toggle`. `agent` 상태가 `asking` 이면 버튼을 깜빡여 승인 대기 알리기.
- 📸 화면 질문: `screen.ask` (질문은 버튼 설정에서 고정 문구로, 예: "이 에러 뭐야?").
- 🌐 번역 / ✍️ 다듬기: `clip.translate` / `clip.polish`.
- ⏹ 멈추기: `agent.stop`.
- 🔋 사용량: `usage` 상태를 받아 5시간 한도 %를 게이지로. 80% 넘으면 빨간색.
- 😊 표정 버튼 (VTube Studio 처럼): 버튼마다 `expression.set` + 대사. 설정 화면에서 `expression.list` 로 고르게. `expression` 방송으로 켜진 버튼 표시. 모델에 표정이 없으면 `motion.play`.
- 💭 정해진 말: `talk.send` (버튼마다 문구 설정, 예: "오늘 할 일 정리해 줘").
