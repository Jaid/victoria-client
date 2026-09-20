export const defaultEndpoint = 'http://localhost:4318'

const basename = (value: string | undefined) => {
  if (!value) {
    return
  }
  return value.replaceAll('\\', '/').replace(/\/+$/u, '').split('/').at(-1) || undefined
}
export const defaultBrowserServiceName = () => {
  return typeof location === 'undefined' ? 'unknown' : location.hostname || 'unknown'
}
export const defaultOsServiceName = () => {
  if (typeof process === 'undefined') {
    return 'unknown'
  }
  return basename(process.argv[1]) ?? basename(process.argv[0]) ?? 'unknown'
}
