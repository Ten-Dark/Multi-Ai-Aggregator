export interface ZenConnectorIdentity {
  instanceId: string
  browserName: string
  browserVersion: string
  extensionVersion: string
}

export interface ZenConnector<TTransport> extends ZenConnectorIdentity {
  transport: TTransport
  connectedAt: number
  lastHeartbeatAt: number
}

export interface RegisterConnectorResult<TTransport> {
  connector: ZenConnector<TTransport>
  replacedTransport?: TTransport
}

export class ZenConnectorRegistry<TTransport> {
  private readonly connectors = new Map<string, ZenConnector<TTransport>>()
  private readonly transports = new Map<TTransport, string>()
  private activeInstanceId: string | null = null

  register(
    identity: ZenConnectorIdentity,
    transport: TTransport,
    now = Date.now(),
  ): RegisterConnectorResult<TTransport> {
    const existing = this.connectors.get(identity.instanceId)
    if (existing?.transport === transport) {
      existing.browserName = identity.browserName
      existing.browserVersion = identity.browserVersion
      existing.extensionVersion = identity.extensionVersion
      existing.lastHeartbeatAt = now
      return { connector: existing }
    }

    if (existing) this.transports.delete(existing.transport)
    const previousInstanceId = this.transports.get(transport)
    if (previousInstanceId) this.remove(transport)

    const connector: ZenConnector<TTransport> = {
      ...identity,
      transport,
      connectedAt: now,
      lastHeartbeatAt: now,
    }
    this.connectors.set(identity.instanceId, connector)
    this.transports.set(transport, identity.instanceId)
    if (!this.activeInstanceId || !this.connectors.has(this.activeInstanceId)) {
      this.activeInstanceId = identity.instanceId
    }

    return {
      connector,
      replacedTransport: existing?.transport,
    }
  }

  heartbeat(transport: TTransport, instanceId: string, now = Date.now()): boolean {
    const registeredId = this.transports.get(transport)
    if (registeredId !== instanceId) return false
    const connector = this.connectors.get(instanceId)
    if (!connector || connector.transport !== transport) return false
    connector.lastHeartbeatAt = now
    return true
  }

  remove(transport: TTransport): ZenConnector<TTransport> | undefined {
    const instanceId = this.transports.get(transport)
    if (!instanceId) return undefined
    const connector = this.connectors.get(instanceId)
    this.transports.delete(transport)
    if (!connector || connector.transport !== transport) return undefined
    this.connectors.delete(instanceId)
    if (this.activeInstanceId === instanceId) {
      this.activeInstanceId = this.connectors.keys().next().value ?? null
    }
    return connector
  }

  getByTransport(transport: TTransport): ZenConnector<TTransport> | undefined {
    const instanceId = this.transports.get(transport)
    if (!instanceId) return undefined
    const connector = this.connectors.get(instanceId)
    return connector?.transport === transport ? connector : undefined
  }

  get(instanceId: string): ZenConnector<TTransport> | undefined {
    return this.connectors.get(instanceId)
  }

  getActive(): ZenConnector<TTransport> | undefined {
    return this.activeInstanceId
      ? this.connectors.get(this.activeInstanceId)
      : undefined
  }

  setActive(instanceId: string): boolean {
    if (!this.connectors.has(instanceId)) return false
    this.activeInstanceId = instanceId
    return true
  }

  list(): ZenConnector<TTransport>[] {
    return [...this.connectors.values()].sort((left, right) => left.connectedAt - right.connectedAt)
  }

  isFresh(connector: ZenConnector<TTransport>, now = Date.now(), timeoutMs = 45_000): boolean {
    return this.connectors.get(connector.instanceId) === connector
      && now - connector.lastHeartbeatAt <= timeoutMs
  }

  get size(): number {
    return this.connectors.size
  }

  clear(): ZenConnector<TTransport>[] {
    const removed = this.list()
    this.connectors.clear()
    this.transports.clear()
    this.activeInstanceId = null
    return removed
  }
}
