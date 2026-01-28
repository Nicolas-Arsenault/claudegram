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

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot API token |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs |
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

All other messages are forwarded directly to Claude Code (requires active session).

### Image Handling

1. Send any image to the bot
2. Image is saved locally
3. Claude is notified with the file path
4. Add a caption for context

## Session Model

- **Explicit start** — Use `/start` to create a session (no auto-creation)
- **Persistent context** — Claude retains full context within a session
- **One session per chat** — Each Telegram chat has its own Claude instance
- **3-hour timeout** — Sessions end after 3 hours of inactivity (configurable)
- **Manual termination** — Use `/kill` to end a session early
- **No context carryover** — New sessions start fresh with no previous context

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
