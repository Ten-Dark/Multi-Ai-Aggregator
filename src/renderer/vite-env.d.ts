/// <reference types="vite/client" />

import type { AggregatorApi } from '../shared/types'

declare global {
  interface Window {
    aggregator: AggregatorApi
  }
}

export {}
