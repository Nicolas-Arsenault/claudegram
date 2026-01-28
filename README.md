# Claudegram

Control Claude Code from Telegram with full terminal fidelity.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Overview

Claudegram bridges your Claude Code terminal session to Telegram, letting you interact with Claude from anywhere. Telegram acts as a remote keyboard, terminal output viewer, and image sender/receiver.

## Features

- **Full PTY Terminal** — Real pseudo-terminal connection to Claude Code
- **Native Commands** — All Claude slash commands forwarded verbatim
- **Image Input** — Send images from Telegram to Claude Code
- **Screenshots** — Capture and receive screenshots from the host machine
- **Secure Access** — Telegram user ID whitelist

## Architecture

```
Telegram Client
    ↕ (Telegram Bot API)
Claudegram
    ↕ (PTY)
Claude Code CLI
```

## Requirements

- macOS or Unix-based system
- Node.js >= 18.0.0
- Claude Code CLI (`brew install claude`)
- Telegram Bot Token (via @BotFather)

## Installation

```bash
git clone https://github.com/Nicolas-Arsenault/claudegram.git
cd claudegram
npm install
npm run build
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API token |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
| `SCREENSHOT_OUTPUT_DIR` | No | Screenshot directory (default: `./screenshots`) |
| `INPUT_IMAGE_DIR` | No | Image directory (default: `./inputs`) |
| `SESSION_IDLE_TIMEOUT_MS` | No | Idle timeout in ms (default: 1800000) |

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
| `/start` | Initialize and start a Claude session |
| `/screenshot` | List available displays |
| `/screenshot <n>` | Capture display n |
| `/kill` | Terminate current session |

All other messages are forwarded directly to Claude Code.

### Image Handling

1. Send any image to the bot
2. Image is saved locally
3. Claude is notified with the file path
4. Add a caption for context

## Session Model

- One Telegram chat = One Claude Code session
- Sessions timeout after 30 minutes of inactivity
- Use `/kill` to manually terminate

## Security

- Only whitelisted Telegram user IDs can interact
- Messages from unauthorized users are silently ignored
- No inbound network ports exposed

## Project Structure

```
src/
├── index.ts           # Entry point
├── config.ts          # Configuration
├── pty/session.ts     # PTY management
├── telegram/bot.ts    # Telegram handler
├── screenshot/capture.ts  # Screenshot (macOS)
└── security/access.ts # Access control
```

## License

MIT
