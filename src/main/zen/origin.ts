export function isValidZenExtensionOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    return (
      parsed.protocol === 'moz-extension:' &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password &&
      !parsed.port &&
      parsed.pathname === '' &&
      !parsed.search &&
      !parsed.hash &&
      parsed.href === origin
    )
  } catch {
    return false
  }
}

export function isAllowedZenExtensionOrigin(origin: string, approvedOrigin: string | null): boolean {
  return isValidZenExtensionOrigin(origin) && (approvedOrigin === null || approvedOrigin === origin)
}
