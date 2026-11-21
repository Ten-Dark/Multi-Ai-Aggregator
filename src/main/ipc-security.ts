export interface IpcSenderTrustInput {
  senderMatchesWindow: boolean
  frameExists: boolean
  isMainFrame: boolean
  frameUrl: string
  currentUrl: string
  isPackaged: boolean
}

export function isTrustedIpcSender(input: IpcSenderTrustInput): boolean {
  if (
    !input.senderMatchesWindow ||
    !input.frameExists ||
    !input.isMainFrame ||
    input.frameUrl !== input.currentUrl
  ) {
    return false
  }

  let url: URL
  try {
    url = new URL(input.frameUrl)
  } catch {
    return false
  }

  if (input.isPackaged) return url.protocol === 'file:'

  if (url.protocol === 'file:') {
    return (
      url.pathname.endsWith('/dist-electron/renderer/index.html') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
  }

  return (
    url.protocol === 'http:' &&
    url.hostname === 'localhost' &&
    url.port === '5173' &&
    url.pathname === '/' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  )
}
