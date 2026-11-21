export type SnapshotKey = 'browser' | 'zenConnection' | `session:${string}`

export class EventSnapshotTracker {
  private readonly versions = new Map<SnapshotKey, number>()

  capture(key: SnapshotKey): number {
    return this.versions.get(key) ?? 0
  }

  markEvent(key: SnapshotKey): void {
    this.versions.set(key, this.capture(key) + 1)
  }

  isCurrent(key: SnapshotKey, capturedVersion: number): boolean {
    return this.capture(key) === capturedVersion
  }
}
