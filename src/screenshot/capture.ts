/**
 * Screenshot Capture Module
 *
 * Implements screenshot functionality as specified in project.md Section 8.
 *
 * Uses native macOS tools:
 * - system_profiler SPDisplaysDataType for listing displays
 * - screencapture -D <display_index> <output_path> for capturing
 *
 * No external screenshot CLI tool is used.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export interface DisplayInfo {
  index: number;
  name: string;
  resolution: string;
  isMain: boolean;
}

export interface ScreenshotResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

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
   * Lists available displays using system_profiler.
   * As per project.md Section 8.3.
   */
  async listDisplays(): Promise<DisplayInfo[]> {
    try {
      const { stdout } = await execAsync('system_profiler SPDisplaysDataType');
      return this.parseDisplayInfo(stdout);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to list displays: ${errMsg}`);
    }
  }

  /**
   * Parses system_profiler output to extract display information.
   */
  private parseDisplayInfo(output: string): DisplayInfo[] {
    const displays: DisplayInfo[] = [];
    const lines = output.split('\n');

    let currentDisplay: Partial<DisplayInfo> | null = null;
    let displayIndex = 1;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect display name (lines ending with colon that aren't headers)
      if (trimmed.endsWith(':') && !trimmed.startsWith('Displays:') && !trimmed.startsWith('Graphics')) {
        if (currentDisplay && currentDisplay.name) {
          displays.push({
            index: displayIndex++,
            name: currentDisplay.name,
            resolution: currentDisplay.resolution || 'Unknown',
            isMain: currentDisplay.isMain || false,
          });
        }
        currentDisplay = { name: trimmed.slice(0, -1) };
      }

      // Parse resolution
      if (trimmed.startsWith('Resolution:') && currentDisplay) {
        currentDisplay.resolution = trimmed.replace('Resolution:', '').trim();
      }

      // Check for main display
      if (trimmed.includes('Main Display: Yes') && currentDisplay) {
        currentDisplay.isMain = true;
      }
    }

    // Add the last display
    if (currentDisplay && currentDisplay.name) {
      displays.push({
        index: displayIndex,
        name: currentDisplay.name,
        resolution: currentDisplay.resolution || 'Unknown',
        isMain: currentDisplay.isMain || false,
      });
    }

    return displays;
  }

  /**
   * Formats display list for Telegram output.
   */
  formatDisplayList(displays: DisplayInfo[]): string {
    if (displays.length === 0) {
      return 'No displays found.';
    }

    const lines = ['Available displays:'];
    for (const display of displays) {
      const mainIndicator = display.isMain ? ' (Main)' : '';
      lines.push(`  ${display.index}. ${display.name}${mainIndicator}`);
      lines.push(`     Resolution: ${display.resolution}`);
    }

    lines.push('');
    lines.push('Use /screenshot <index> to capture a specific display.');

    return lines.join('\n');
  }

  /**
   * Captures a screenshot of the specified display.
   * As per project.md Section 8.4.
   *
   * @param displayIndex - The display index (1-based)
   * @returns Screenshot result with file path or error
   */
  async captureDisplay(displayIndex: number): Promise<ScreenshotResult> {
    await this.ensureOutputDir();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `screenshot-${displayIndex}-${timestamp}.png`;
    const filePath = path.join(this.outputDir, filename);

    try {
      // screencapture -D uses 1-based display index
      await execAsync(`screencapture -D ${displayIndex} "${filePath}"`);

      // Verify the file was created
      try {
        await fs.access(filePath);
        return { success: true, filePath };
      } catch {
        return {
          success: false,
          error: `Screenshot file was not created. Display index ${displayIndex} may be invalid.`,
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Failed to capture screenshot: ${errMsg}`,
      };
    }
  }

  /**
   * Captures the main display (index 1).
   */
  async captureMainDisplay(): Promise<ScreenshotResult> {
    return this.captureDisplay(1);
  }
}
