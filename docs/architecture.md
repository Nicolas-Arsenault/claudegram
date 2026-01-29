# Claudegram Architecture

## System Overview

Claudegram connects a real Claude Code terminal session to Telegram, providing full terminal fidelity through PTY (pseudo-terminal).

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Claudegram                               │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Telegram   │  │   AI Client  │  │   Screenshot         │  │
│  │     Bot      │──│   Interface  │  │   Capture            │  │
│  │  (telegraf)  │  │              │  │  (screencapture)     │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│         │                 │                    │                 │
│         │          ┌──────┴──────┐             │                 │
│         │          │             │             │                 │
│  ┌──────────────┐  ▼             ▼  ┌──────────────────────┐  │
│  │   Access     │ ┌────────┐ ┌────────┐ │   File System     │  │
│  │   Control    │ │ Claude │ │ Codex  │ │   (inputs/        │  │
│  │              │ │ Client │ │ Client │ │    screenshots/)  │  │
│  └──────────────┘ └────────┘ └────────┘ └───────────────────┘  │
│         │                 │       │              │               │
│  ┌──────────────┐        │       │                              │
│  │   Config     │        │       │                              │
│  │   Loader     │        │       │                              │
│  └──────────────┘        │       │                              │
└──────────────────────────│───────│──────────────────────────────┘
         │                 │       │
         ▼                 ▼       ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Telegram   │   │   Claude     │   │   OpenAI     │
│   Bot API    │   │   Code CLI   │   │   Codex CLI  │
└──────────────┘   └──────────────┘   └──────────────┘
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
- Select AI backend (Claude or Codex)
- Provide typed configuration object

### src/telegram/bot.ts
Telegram bot handler. Responsibilities:
- Connect to Telegram Bot API
- Route messages to appropriate handlers
- Create AI client based on configuration
- Forward text/commands to AI client
- Handle image downloads
- Handle screenshot commands
- Buffer and debounce AI output
- Enforce access control middleware

### src/sdk/types.ts
Shared types and interfaces. Responsibilities:
- Define AIClient interface
- Define AIResponse, SessionState, ProgressEvent types
- Define callback types for session events

### src/sdk/client.ts (ClaudeClient)
Claude Code SDK client. Responsibilities:
- Implement AIClient interface for Claude Code CLI
- Spawn Claude Code in non-interactive mode
- Manage one session per Telegram chat
- Parse stream-json output for progress events
- Handle idle timeout
- Clean up on session end

### src/sdk/codex-client.ts (CodexClient)
OpenAI Codex SDK client. Responsibilities:
- Implement AIClient interface for Codex CLI
- Spawn Codex in exec mode with JSON output
- Manage one session per Telegram chat
- Parse JSON events for progress updates
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

### Text Message Flow
```
Telegram message
    → Claudegram
    → AIClient.sendMessage()
    → Claude Code CLI or Codex CLI
    → Parse response/events
    → Telegram sendMessage
```

### Image Input Flow
```
Telegram image
    → Bot downloads image
    → Image saved to ./inputs/
    → AIClient.sendImage(path, caption)
    → AI processes file
```

### Screenshot Flow
```
/screenshot
    → List displays (system_profiler SPDisplaysDataType)
    → Format and send to Telegram

/screenshot <n>
    → Capture display (screencapture -D <n> <path>)
    → Send image to Telegram (sendPhoto)
```

## Session Lifecycle

1. **Creation**: Session created explicitly via `/start` command (not auto-created)
2. **Active**: Messages forwarded to PTY, output sent back, context retained
3. **Idle Timeout**: Session killed after 3 hours inactivity (configurable)
4. **Manual Kill**: User sends `/kill` command
5. **Process Exit**: Claude Code exits naturally
6. **New Session**: User must `/start` again; no previous context is retained

## Error Handling

- Configuration errors: Logged and process exits
- Session errors: Logged and session terminated
- Telegram API errors: Logged, message delivery retried
- Screenshot errors: Error message sent to user

## Security Model

- User ID whitelist enforced at middleware level
- Unauthorized users silently ignored
- No inbound network ports exposed
- Claude Code runs as local user
