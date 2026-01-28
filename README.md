# Claudegram

Control Claude Code from Telegram with full computer access.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Overview

Claudegram bridges Claude Code to Telegram, letting you interact with Claude from anywhere. Claude has full computer access via `--dangerously-skip-permissions`, enabling file operations, bash commands, and more.

## Features

- **Full Computer Access** — Claude can read/write files, execute commands, etc.
- **Real-time Progress** — See what Claude is doing (reading files, running commands, etc.)
- **Streaming Updates** — Tool usage displayed as it happens, with 30s fallback messages
- **Security Prompts** — Configurable system prompt to require confirmation before actions
- **Image Input** — Send images from Telegram to Claude Code
- **Screenshots** — Capture and receive screenshots from the host machine
- **Direct Shell Access** — Execute commands directly via `/cmd`
- **Secure Access** — Telegram user ID whitelist

## Architecture

```
Telegram Client
    ↕ (Telegram Bot API)
Claudegram
    ↕ (Claude Code SDK/CLI with stream-json)
Claude Code
    ↕ (--dangerously-skip-permissions)
Your Computer
```

## Requirements

- macOS (screenshot feature is macOS-only)
- Node.js >= 18.0.0
- Claude Code CLI installed and authenticated
- Telegram Bot Token (via @BotFather)
- **Screen Recording permission** for screenshots (System Settings > Privacy & Security > Screen Recording)

## Installation

```bash
git clone https://github.com/Nicolas-Arsenault/claudegram.git
cd claudegram
npm install
npm run build
```

## Setup

### Creating a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Start a chat and send `/newbot`
3. Choose a display name for your bot (e.g., "My Claudegram")
4. Choose a username ending in `bot` (e.g., `my_claudegram_bot`)
5. BotFather will reply with your **bot token** — save this securely

```
Done! Congratulations on your new bot. You will find it at t.me/my_claudegram_bot.
Use this token to access the HTTP API:
123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

### Getting Your Telegram User ID

Your user ID is required for the whitelist. To find it:

1. Search for `@userinfobot` on Telegram
2. Start a chat and send any message
3. The bot replies with your user ID

```
Your user ID: 123456789
```

Alternatively, forward a message from yourself to `@userinfobot`.

### Authenticating Claude Code

Before running Claudegram, ensure Claude Code is authenticated:

```bash
claude
```

This will open a browser for OAuth login with Anthropic. Once authenticated, Claudegram will use those stored credentials.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API token |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `SYSTEM_PROMPT_FILE` | No | Path to custom system prompt file (default: `./CLAUDE_PROMPT.md`) |
| `SCREENSHOT_OUTPUT_DIR` | No | Screenshot directory (default: `./screenshots`) |
| `INPUT_IMAGE_DIR` | No | Image directory (default: `./inputs`) |
| `SESSION_IDLE_TIMEOUT_MS` | No | Idle timeout in ms (default: 10800000 / 3 hours) |

### Example

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export ALLOWED_USER_IDS="123456,789012"
npm start
```

## Usage

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Start a new Claude session (required before sending messages) |
| `/status` | Check if a session is active |
| `/screenshot` | List available displays |
| `/screenshot <n>` | Capture display n |
| `/kill` | Terminate current session |
| `/cmd <command>` | Execute shell command directly (bypasses Claude) |

All other messages are sent to Claude Code (requires active session).

### Progress Updates

While Claude works, you'll see real-time updates:

- `🔧 Reading: src/index.ts` — File being read
- `🔧 Writing: src/config.ts` — File being written
- `🔧 Running: npm test` — Command being executed
- `🔧 Searching for: "pattern"` — Content search
- `💭 Thinking...` — Claude is reasoning
- `⏳ Still working...` — Fallback every 30s if no other activity

### Direct Shell Execution

The `/cmd` command executes shell commands directly on the host machine without going through Claude:

```
/cmd ls -la
/cmd git status
/cmd npm test
```

Output includes stdout, stderr, and exit code. Long outputs are automatically split across multiple messages.

### Image Handling

1. Send any image to the bot
2. Image is saved locally
3. Claude is notified with the file path
4. Add a caption for context

## Security

### Access Control

- Only whitelisted Telegram user IDs can interact
- Messages from unauthorized users are silently ignored
- No inbound network ports exposed

### System Prompt

Claudegram includes a default security prompt (`CLAUDE_PROMPT.md`) that instructs Claude to:

- Ask for confirmation before destructive operations
- Explain what actions it plans to take
- Request approval before modifying or deleting files
- Warn about potentially dangerous commands

You can customize this by editing `CLAUDE_PROMPT.md` or setting `SYSTEM_PROMPT_FILE` to a different file.

## Session Model

- **Explicit start** — Use `/start` to create a session (no auto-creation)
- **Persistent context** — Claude retains full context within a session via `--resume`
- **One session per chat** — Each Telegram chat has its own Claude instance
- **3-hour timeout** — Sessions end after 3 hours of inactivity (configurable)
- **Manual termination** — Use `/kill` to end a session early
- **Clean process management** — `/kill` terminates any running Claude process

## Project Structure

```
src/
├── index.ts              # Entry point
├── config.ts             # Configuration
├── sdk/client.ts         # Claude Code SDK client with streaming
├── telegram/bot.ts       # Telegram handler with progress updates
├── screenshot/capture.ts # Screenshot (macOS)
└── security/access.ts    # Access control
```

## License

MIT
