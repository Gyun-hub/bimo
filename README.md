<p align="center"><img src="build/icon.png" width="96" alt="Bimo"></p>

<h1 align="center">Bimo</h1>

<p align="center">AI 코딩 CLI 터미널을 한 보드 위에 펼쳐 두고 같이 굴리는 데스크톱 앱</p>

<p align="center">한국어 · <a href="README.en.md">English</a></p>

여러 프로젝트에서 Claude Code · Codex 같은 AI CLI 를 동시에 돌리면 터미널 창이 금방 쌓인다. Bimo 는 그 터미널들을 무한 보드 위의 카드로 놓고, 어떤 세션이 일하는 중인지·답이 끝났는지를 한눈에 보여 준다.

## 기능

- **보드** — 세션을 카드로 놓고 끌어서 배치. 미니맵, 확대·축소, 폴더별 자동 정렬.
- **AI CLI 자동 감지** — 설치된 것만 런처에 나온다.
  Claude Code · Codex · Gemini · Qwen Code · OpenCode · Aider · Cursor · Copilot · Amp (PowerShell 은 항상)
- **상태 표시** — 일하는 중 / 응답 끝 / 실패를 카드 색으로. 확인 안 한 응답 목록.
- **세션 이어 열기** — 다른 터미널에서 했던 AI 대화를 보드로 끌어다 놓으면 이어서 연다.
- **프로젝트 사이드바** — 폴더별로 세션 묶기, 프로젝트 색 지정, git 브랜치 지정 실행.
- **보내기** — `@세션이름 할 일` 로 원하는 세션에 바로 입력 (`Ctrl+K`).
- **세션끼리 협업 (MCP)** — 케이블로 연결한 세션끼리 Claude 가 서로 말을 건다. 앱이 `bimo` MCP 서버(`list_sessions`, `send_to_session`)를 붙여 준다. 접속은 `127.0.0.1` + 실행마다 새로 만드는 토큰.
- **파일 보기** — 보드 안에서 파일 찾기·열기, Markdown 미리보기.
- **터미널 편의** — 캡처 이미지 붙여넣기, OSC 8 링크 열기, 마우스 모드 앱에서도 드래그 선택.
- **자동 업데이트** — GitHub Releases 에서 새 버전을 받는다.

## 설치

[Releases](https://github.com/Gyun-hub/bimo/releases) 에서 받는다.

| OS | 파일 |
|---|---|
| Windows (x64) | `Bimo-Setup-<버전>.exe` |
| macOS (Apple Silicon / Intel) | `.dmg` |

- Windows 설치본은 코드 서명이 없어 SmartScreen 경고가 뜬다. "추가 정보 → 실행".
- macOS 빌드도 서명·공증이 없다. 처음 열 때 우클릭 → 열기. 자동 업데이트는 macOS 에서 동작하지 않는다.

AI CLI 는 따로 설치해 둔다 (예: `npm i -g @anthropic-ai/claude-code`). Bimo 는 PATH 에 있는 CLI 를 찾아 쓴다.

## 데이터

| 위치 | 내용 |
|---|---|
| `%APPDATA%\Bimo\board.json` (Windows) / `~/Library/Application Support/Bimo` (macOS) | 보드 배치·세션 |
| 같은 폴더의 `Local Storage` | 설정 |

`BIMO_USER_DATA` 환경 변수로 데이터 폴더를 바꿀 수 있다 (테스트용 보드 분리 등).

## 개발

Node.js 22 기준.

```bash
npm install
npm start                 # 개발 실행
npm run smoke             # 기본 보드로 띄워 스크린샷(%TEMP%\bimo-smoke.png)만 찍고 종료
npm run dist:win          # Windows 설치본 → release/
npm run dist:mac          # macOS dmg/zip (macOS 에서)
```

아이콘은 `tools/make-icon.py` 가 16×16 픽셀 그림으로 그린다 (Pillow 필요).

```bash
python -I tools/make-icon.py   # build/icon.png · icon.ico · icon.icns
```

### 릴리스

`package.json` 의 `version` 을 올려 `main` 에 머지하면 `.github/workflows/release.yml` 이 Windows·Mac 설치 파일을 빌드해 `v<버전>` Release 로 올린다. 같은 버전 Release 가 이미 있으면 건너뛴다.

### 스택

Electron · xterm.js · node-pty (`@lydell/node-pty`) · CodeMirror 5 · marked + DOMPurify · electron-builder · electron-updater

## 라이선스

[MIT](LICENSE)
