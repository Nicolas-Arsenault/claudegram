# Architecture Documentation

## System Overview

The Claude Telegram Bridge connects a real Claude Code terminal session to Telegram, providing full terminal fidelity through PTY (pseudo-terminal).

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Claude Bridge Agent                          │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Telegram   │  │   Session    │  │   Screenshot         │  │
│  │     Bot      │──│   Manager    │  │   Capture            │  │
│  │  (telegraf)  │  │  (node-pty)  │  │  (screencapture)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│         │                 │                    │                 │
│         │                 │                    │                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Access     │  │   Config     │  │   File System        │  │
│  │   Control    │  │   Loader     │  │   (inputs/           │  │
│  │              │  │              │  │    screenshots/)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                 │
         ▼                 ▼
┌──────────────┐   ┌──────────────┐
│   Telegram   │   │   Claude     │
│   Bot API    │   │   Code CLI   │
└──────────────┘   └──────────────┘
```

## Module Responsibilities

### src/index.ts
Main entry point. Responsibilities:
- Load configuration
- Initialize TelegramBot
- Handle shutdown signals (SIGINT, SIGTERM)

### src/config.ts
Configuration management. Responsibilities:
- Load environment variables
- Validate required configuration
- Provide typed configuration object

### src/telegram/bot.ts
Telegram bot handler. Responsibilities:
- Connect to Telegram Bot API
- Route messages to appropriate handlers
- Forward text/commands to PTY (Section 6.2)
- Handle image downloads (Section 7)
- Handle screenshot commands (Section 9)
- Buffer and debounce PTY output
- Enforce access control middleware

### src/pty/session.ts
PTY session management. Responsibilities:
- Spawn Claude Code in PTY (Section 5)
- Manage one session per Telegram chat (Section 5.4)
- Forward input to PTY
- Capture PTY output
- Handle idle timeout
- Clean up on session end

### src/screenshot/capture.ts
Screenshot functionality. Responsibilities:
- List available displays (system_profiler)
- Capture screenshots (screencapture)
- Save to filesystem

### src/security/access.ts
Access control. Responsibilities:
- Maintain user ID whitelist
- Authorize/reject users

## Data Flows

### Text Message Flow (Section 5.3)
```
Telegram message
    → Claude Bridge Agent
    → PTY.write("<input>\n")
    → Claude Code CLI
    → PTY.read()
    → Telegram sendMessage
```

### Image Input Flow (Section 7.1)
```
Telegram image
    → Bot downloads image
    → Image saved to ./inputs/
    → PTY.write("User sent an image: <path>\n<caption>")
    → Claude Code processes file
```

### Screenshot Flow (Section 9)
```
/screenshot
    → List displays (system_profiler SPDisplaysDataType)
    → Format and send to Telegram

/screenshot <n>
    → Capture display (screencapture -D <n> <path>)
    → Send image to Telegram (sendPhoto)
```

## Session Lifecycle

1. **Creation**: Session created on first message from a chat
2. **Active**: Messages forwarded to PTY, output sent back
3. **Idle Timeout**: Session killed after 30 min inactivity (configurable)
4. **Manual Kill**: User sends `/kill` command
5. **Process Exit**: Claude Code exits naturally

## Error Handling

- Configuration errors: Logged and process exits
- Session errors: Logged and session terminated
- Telegram API errors: Logged, message delivery retried
- Screenshot errors: Error message sent to user

## Security Model (Section 10)

- User ID whitelist enforced at middleware level
- Unauthorized users silently ignored
- No inbound network ports exposed
- Claude Code runs as local user
