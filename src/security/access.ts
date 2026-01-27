/**
 * Access Control Module
 *
 * Implements the security model from project.md Section 10.
 * Uses a Telegram user ID whitelist to control access.
 * Messages from unauthorized users are ignored.
 */

export class AccessControl {
  private allowedUserIds: Set<number>;

  constructor(allowedUserIds: number[]) {
    this.allowedUserIds = new Set(allowedUserIds);
  }

  /**
   * Checks if a Telegram user ID is authorized to use the bridge.
   */
  isAuthorized(userId: number): boolean {
    return this.allowedUserIds.has(userId);
  }

  /**
   * Adds a user ID to the whitelist at runtime.
   */
  addUser(userId: number): void {
    this.allowedUserIds.add(userId);
  }

  /**
   * Removes a user ID from the whitelist at runtime.
   */
  removeUser(userId: number): void {
    this.allowedUserIds.delete(userId);
  }

  /**
   * Returns the list of currently authorized user IDs.
   */
  getAllowedUsers(): number[] {
    return Array.from(this.allowedUserIds);
  }
}
