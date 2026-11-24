import type { ModelId, ModelResult, TaskId, TaskStatus } from '../../shared/types.js'

export interface ActiveTask {
  taskId: TaskId
  batchId?: TaskId
  model: ModelId
  connectorId: string
  connectorGeneration: number
  status: TaskStatus
  result?: ModelResult
  cancelPromise?: Promise<boolean>
  cancelConfirmed?: boolean
  statusBeforeCancel?: TaskStatus
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['done', 'error', 'cancelled'])

export class TaskRegistry {
  private readonly tasks = new Map<TaskId, ActiveTask>()
  private readonly batches = new Map<TaskId, Set<TaskId>>()

  register(task: ActiveTask): void {
    if (this.tasks.has(task.taskId)) throw new Error('Task identifier collision.')
    this.tasks.set(task.taskId, task)
    if (task.batchId) {
      let members = this.batches.get(task.batchId)
      if (!members) {
        members = new Set<TaskId>()
        this.batches.set(task.batchId, members)
      }
      members.add(task.taskId)
    }
  }

  get(taskId: TaskId): ActiveTask | undefined {
    return this.tasks.get(taskId)
  }

  getByModel(model: ModelId): ActiveTask | undefined {
    return [...this.tasks.values()].find((task) => task.model === model)
  }

  getBatch(batchId: TaskId): ActiveTask[] {
    const members = this.batches.get(batchId)
    if (!members) return []
    return [...members]
      .map((taskId) => this.tasks.get(taskId))
      .filter((task): task is ActiveTask => Boolean(task))
  }

  setStatus(taskId: TaskId, status: TaskStatus): boolean {
    const task = this.tasks.get(taskId)
    if (!task || TERMINAL_STATUSES.has(task.status) || task.status === 'cancelling') return false
    task.status = status
    return true
  }

  beginCancellation(taskId: TaskId): ActiveTask | null {
    const task = this.tasks.get(taskId)
    if (!task || TERMINAL_STATUSES.has(task.status)) return null
    if (task.status === 'cancelling') return task
    task.statusBeforeCancel = task.status
    task.status = 'cancelling'
    return task
  }

  restoreAfterCancellationFailure(taskId: TaskId): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'cancelling') return false
    task.status = task.statusBeforeCancel ?? 'waiting'
    task.statusBeforeCancel = undefined
    return true
  }

  finish(taskId: TaskId, result: ModelResult): ModelResult | null {
    const task = this.tasks.get(taskId)
    if (
      !task ||
      TERMINAL_STATUSES.has(task.status) ||
      task.status === 'cancelling' ||
      (result.status !== 'done' && result.status !== 'error')
    ) return null
    task.status = result.status
    task.result = result
    return result
  }

  finishCancelled(taskId: TaskId, result: ModelResult, confirmed = true): ModelResult | null {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'cancelling' || result.status !== 'cancelled') return null
    task.status = 'cancelled'
    task.cancelConfirmed = confirmed
    task.result = result
    return result
  }

  remove(taskId: TaskId): void {
    const task = this.tasks.get(taskId)
    if (!task) return
    this.tasks.delete(taskId)
    if (task.batchId) {
      const members = this.batches.get(task.batchId)
      members?.delete(taskId)
      if (members?.size === 0) this.batches.delete(task.batchId)
    }
  }

  finalizeCancelling(resultFactory: (task: ActiveTask) => ModelResult): ModelResult[] {
    const results: ModelResult[] = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'cancelling') continue
      task.status = 'cancelled'
      task.cancelConfirmed = false
      task.result = resultFactory(task)
      results.push(task.result)
    }
    return results
  }

  cancelAll(resultFactory: (task: ActiveTask) => ModelResult): ModelResult[] {
    const results: ModelResult[] = []
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATUSES.has(task.status)) continue
      task.status = 'cancelled'
      task.cancelConfirmed = false
      task.result = resultFactory(task)
      results.push(task.result)
    }
    return results
  }
}
