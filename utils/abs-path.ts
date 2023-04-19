export const getToAbsPath = (importMetaUrl: string) => (relPath: string) => {
  const basePath = new URL(importMetaUrl)
  const absolutePath = new URL(relPath, basePath)
  return absolutePath.pathname
}
