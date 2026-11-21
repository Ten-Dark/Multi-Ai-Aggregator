import os from 'node:os'
import path from 'node:path'

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')

export const probeProfileDir =
  process.env.AGGREGATOR_PROBE_PROFILE_DIR ||
  path.join(localAppData, 'Multi-AI Aggregator', 'Forensics', 'probe-profile')
