/**
 * Screenshot Capture Module
 *
 * Captures screenshots of windows on macOS.
 *
 * Uses:
 * - Swift script with CGWindowListCopyWindowInfo for listing windows
 * - screencapture -l <windowid> for capturing specific windows
 *
 * IMPORTANT: Requires Screen Recording permission in System Preferences > Privacy & Security
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export interface WindowInfo {
  index: number;
  id: number;
  name: string;
  owner: string;
  bounds: string;
}

export interface ScreenshotResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

// Swift script for listing windows
const SWIFT_LIST_WINDOWS = `
import Cocoa

struct WindowInfo: Codable {
    let id: Int
    let name: String
    let owner: String
    let width: Int
    let height: Int
}

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    print("[]")
    exit(0)
}

var windows: [WindowInfo] = []
let skipOwners = ["Window Server", "Dock", "SystemUIServer", "Control Center", "Notification Center"]

for win in windowList {
    guard let owner = win[kCGWindowOwnerName as String] as? String,
          let name = win[kCGWindowName as String] as? String,
          let id = win[kCGWindowNumber as String] as? Int,
          let bounds = win[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? CGFloat,
          let height = bounds["Height"] as? CGFloat,
          let layer = win[kCGWindowLayer as String] as? Int else {
        continue
    }

    if name.isEmpty || layer < 0 || width < 100 || height < 100 {
        continue
    }
    if skipOwners.contains(owner) {
        continue
    }

    windows.append(WindowInfo(
        id: id,
        name: name,
        owner: owner,
        width: Int(width),
        height: Int(height)
    ))
}

let encoder = JSONEncoder()
if let data = try? encoder.encode(windows),
   let json = String(data: data, encoding: .utf8) {
    print(json)
} else {
    print("[]")
}
`;

export class ScreenshotCapture {
  private outputDir: string;

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  /**
   * Ensures the screenshot output directory exists.
   */
  async ensureOutputDir(): Promise<void> {
    await fs.mkdir(this.outputDir, { recursive: true });
  }

  /**
   * Lists visible windows using CGWindowListCopyWindowInfo via Swift.
   */
  async listWindows(): Promise<WindowInfo[]> {
    try {
      // Use system Swift to avoid toolchain issues
      const { stdout } = await execAsync(`/usr/bin/swift -e '${SWIFT_LIST_WINDOWS.replace(/'/g, "'\\''")}'`);
      const windows = JSON.parse(stdout.trim());

      return windows.map((win: any, idx: number) => ({
        index: idx + 1,
        id: win.id,
        name: win.name,
        owner: win.owner,
        bounds: `${win.width}x${win.height}`,
      }));
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list windows: ${errMsg}`);
    }
  }

  /**
   * Formats window list for Telegram output.
   */
  formatWindowList(windows: WindowInfo[]): string {
    if (windows.length === 0) {
      return 'No windows found.\n\nMake sure Screen Recording permission is granted in:\nSystem Settings > Privacy & Security > Screen Recording';
    }

    const lines = ['Available windows:'];
    for (const win of windows) {
      // Truncate long window names
      const name = win.name.length > 40 ? win.name.substring(0, 37) + '...' : win.name;
      lines.push(`  ${win.index}. ${win.owner}`);
      lines.push(`     ${name}`);
    }

    lines.push('');
    lines.push('Use /screenshot <n> to capture a window.');

    return lines.join('\n');
  }

  /**
   * Captures a screenshot of the specified window.
   *
   * @param windowIndex - The window index (1-based) from listWindows
   * @returns Screenshot result with file path or error
   */
  async captureWindow(windowIndex: number): Promise<ScreenshotResult> {
    await this.ensureOutputDir();

    // Get windows to find the window ID
    let windows: WindowInfo[];
    try {
      windows = await this.listWindows();
    } catch (error) {
      return {
        success: false,
        error: 'Failed to list windows. Grant Screen Recording permission.',
      };
    }

    const window = windows.find(w => w.index === windowIndex);

    if (!window) {
      return {
        success: false,
        error: `Window ${windowIndex} not found. Use /screenshot to see available windows.`,
      };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = window.owner.replace(/[^a-zA-Z0-9]/g, '_');
    const filename = `screenshot-${safeName}-${timestamp}.png`;
    const filePath = path.join(this.outputDir, filename);

    try {
      // screencapture -l uses window ID (CGWindowID)
      // -x suppresses sound, -o excludes shadow
      await execAsync(`screencapture -x -o -l ${window.id} "${filePath}"`);

      // Verify the file was created and has content
      try {
        const stats = await fs.stat(filePath);
        if (stats.size > 0) {
          return { success: true, filePath };
        }
        await fs.unlink(filePath).catch(() => {});
        return {
          success: false,
          error: 'Screenshot failed. Grant Screen Recording permission in System Settings.',
        };
      } catch {
        return {
          success: false,
          error: 'Screenshot failed. Window may have been closed.',
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to capture: ${errMsg}`,
      };
    }
  }

  // Aliases for backward compatibility
  async listDisplays(): Promise<WindowInfo[]> {
    return this.listWindows();
  }

  formatDisplayList(windows: WindowInfo[]): string {
    return this.formatWindowList(windows);
  }

  async captureDisplay(index: number): Promise<ScreenshotResult> {
    return this.captureWindow(index);
  }
}
