# Claude ↔ Telegram Terminal Bridge  
Unified System Architecture & Build Specification (macOS / Unix)

This document is the single source of truth for building a system that connects a real Claude Code terminal session running on a macOS / Unix machine to a Telegram bot.

This document is intended to be persistently referenced by Claude Code while implementing the system.

---

## 1. System Objective

Build a minimal-setup application that allows developers to interact with a real Claude Code terminal through Telegram, with full terminal fidelity.

The system must support:
- Full interactive terminal control using a real PTY
- Native Claude slash commands (no re-implementation)
- Image input sent from Telegram to Claude Code
- Screenshot capture from the host machine
- Screenshot delivery to Telegram
- macOS / Unix only (Windows explicitly out of scope)

Telegram acts as:
- A remote keyboard
- A remote terminal output viewer
- A remote image sender/receiver

Claude Code runs unchanged.

---

## 2. High-Level Architecture

Telegram Client  
↕ (Telegram Bot API over HTTPS)  
Telegram Bot  
↕  
Claude Bridge Agent (local process)
- PTY ↔ Claude Code CLI
- Built-in screen capture (macOS / Unix)
- Image ingestion pipeline
- Session management
- Security / access control

---

## 3. Design Principles

- Terminal fidelity first: Claude Code must believe it runs in a real terminal
- Zero command duplication: All slash commands are forwarded verbatim
- File-based vision: Images are passed as file paths
- Minimal setup: One agent process, no web UI, no cloud services
- macOS / Unix native tooling only
- Telegram is transport only, not a logic layer

---

## 4. Claude Bridge Agent

### 4.1 Responsibilities

The Claude Bridge Agent is a single local daemon running on the same machine as Claude Code.

Responsibilities:
- Spawn and manage a PTY-backed Claude Code process
- Forward Telegram text and commands directly to the PTY
- Stream PTY output back to Telegram
- Download and store images received from Telegram
- Capture screenshots on demand using native OS tools
- Enforce access control (Telegram user whitelist)

---

## 5. Terminal Integration (PTY – Mandatory)

### 5.1 Rationale

Claude Code relies on:
- Interactive prompts
- ANSI escape sequences
- Cursor movement
- Progress indicators
- Streaming output

Plain stdin/stdout is insufficient and will break behavior.

A pseudo-terminal (PTY) is mandatory.

---

### 5.2 PTY Implementation Options

- Node.js (recommended): node-pty
- Python: pexpect
- Go: creack/pty

---

### 5.3 Terminal Data Flow

Telegram message  
→ Claude Bridge Agent  
→ PTY.write("<input>\n")  
→ Claude Code CLI  
→ PTY.read()  
→ Telegram sendMessage

---

### 5.4 Session Model

- Default model: 1 Telegram chat = 1 Claude Code PTY session
- One Claude Code process per chat
- Optional idle timeout (e.g. 30 minutes)

---

## 6. Telegram Bot Interface

### 6.1 Supported Inputs

- Plain text messages
- Slash commands
- Images (photo or document)

---

### 6.2 Input Handling Rules

Text message:
- Forward directly to PTY

Slash command:
- Forward verbatim to PTY (no parsing or interpretation)

Image:
- Download locally
- Save to filesystem
- Notify Claude Code via PTY with file path

The bot must not interpret or reimplement Claude functionality.

---

## 7. Image Input to Claude Code

### 7.1 Image Ingestion Flow

Telegram image  
→ Bot downloads image  
→ Image saved to local filesystem  
→ Claude notified via PTY

---

### 7.2 Claude Notification Format

Claude is informed using natural language and file paths:

User sent an image: ./inputs/ui_state.png  
Please inspect this image.

Claude Code already understands how to work with images provided as files.

---

## 8. Screenshot Capture (Built-In)

### 8.1 Scope

Screenshot capture is implemented directly in the Claude Bridge Agent using native macOS / Unix tools.

No external screenshot CLI tool is used.

---

### 8.2 Screenshot Capabilities

- List available displays
- Capture a specific display
- Save screenshot to disk
- Send screenshot to Telegram

---

### 8.3 Listing Available Screens (macOS)

Use system_profiler or screencapture metadata to enumerate displays.

Example internal command:
- system_profiler SPDisplaysDataType

The Claude Bridge parses and formats the output for Telegram.

---

### 8.4 Capturing a Screen (macOS)

Use the built-in screencapture utility.

Example:
- screencapture -D <display_index> <output_path>

The agent is responsible for:
- Choosing the display index
- Writing the image file
- Handling errors

---

## 9. Screenshot Command Flow

Telegram command:
/screenshot

Flow:
- Claude Bridge lists available screens
- Sends formatted list to Telegram

Telegram command:
/screenshot <index>

Flow:
- Claude Bridge captures specified display
- Saves screenshot locally
- Sends image to Telegram using sendPhoto

---

## 10. Security Model

### 10.1 Access Control

- Telegram user ID whitelist
- Messages from unauthorized users are ignored

---

### 10.2 Execution Safety

- Claude Code runs as the local user or a restricted user
- No inbound network ports exposed
- Optional sandboxing via OS permissions

---

## 11. Configuration

Environment variables:

TELEGRAM_BOT_TOKEN=<token>  
ALLOWED_USER_IDS=123456,789012  

Optional:
- SCREENSHOT_OUTPUT_DIR=./screenshots
- INPUT_IMAGE_DIR=./inputs

---

## 12. Minimal Setup Goal

Target installation experience:

brew install claude  
curl -sL <installer> | bash  
claude-telegram-bridge start  

No database.  
No web UI.  
No cloud dependency.

---

## 13. Non-Goals

- Reimplementing Claude Code behavior
- Building a graphical UI
- Supporting Windows
- Multi-user orchestration by default
- Long-term session persistence across restarts

---

## 14. Summary

This system provides:
- A real PTY-backed Claude Code terminal
- Telegram-based remote interaction
- File-based image and screenshot workflows
- Native macOS / Unix tooling
- Minimal setup with maximum terminal fidelity

This document is authoritative and must be followed by Claude Code during implementation.

