# Claude Telegram Bridge

A bridge connecting Claude Code terminal sessions to Telegram, providing full terminal fidelity through PTY.

## Overview

This system allows developers to interact with a real Claude Code terminal through Telegram. Telegram acts as a remote keyboard, terminal output viewer, and image sender/receiver.

## Features

- **Full PTY Terminal**: Real pseudo-terminal connection to Claude Code
- **Native Command Support**: All Claude slash commands forwarded verbatim
- **Image Input**: Send images from Telegram to Claude Code
- **Screenshot Capture**: Capture and receive screenshots from the host machine
- **Access Control**: Telegram user ID whitelist security

## Architecture

```
Telegram Client
    ↕ (Telegram Bot API)
Telegram Bot
    ↕
Claude Bridge Agent
    ├── PTY ↔ Claude Code CLI
    ├── Screenshot capture (macOS native)
    ├── Image ingestion pipeline
    ├── Session management
    └── Access control
```

## Requirements

- macOS or Unix-based system
- Node.js >= 18.0.0
- Claude Code CLI installed (`brew install claude`)
- Telegram Bot Token

## Installation

```bash
npm install
npm run build
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Your Telegram bot API token |
| `ALLOWED_USER_IDS` | Yes | Comma-separated list of allowed Telegram user IDs |
| `SCREENSHOT_OUTPUT_DIR` | No | Directory for screenshots (default: `./screenshots`) |
| `INPUT_IMAGE_DIR` | No | Directory for received images (default: `./inputs`) |
| `SESSION_IDLE_TIMEOUT_MS` | No | Session idle timeout in ms (default: 1800000 / 30 min) |

### Example

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
export ALLOWED_USER_IDS="123456,789012"
```

## Usage

### Starting the Bridge

```bash
npm start
```

Or directly:

```bash
node dist/index.js
```

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize the bridge and start a Claude session |
| `/screenshot` | List available displays |
| `/screenshot <n>` | Capture display number n and send to Telegram |
| `/kill` | Terminate the current Claude session |

All other text messages are forwarded directly to Claude Code.

### Image Handling

- Send any image to the bot (as photo or document)
- The image is saved locally and Claude is notified with the file path
- Add a caption to provide context for Claude

## Session Model

- One Telegram chat = One Claude Code PTY session
- Sessions timeout after 30 minutes of inactivity (configurable)
- Use `/kill` to manually terminate a session

## Security

- Only whitelisted Telegram user IDs can interact with the bot
- Messages from unauthorized users are silently ignored
- Claude Code runs as the local user
- No inbound network ports are exposed

## Project Structure

```
src/
├── index.ts           # Main entry point
├── config.ts          # Configuration loader
├── pty/
│   └── session.ts     # PTY session management
├── telegram/
│   └── bot.ts         # Telegram bot handler
├── screenshot/
│   └── capture.ts     # Screenshot capture (macOS)
└── security/
    └── access.ts      # Access control
```

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

## License

MIT
