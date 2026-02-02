export type PermissionMode =
  | "default"           // Standard permission behavior - prompts for confirmation
  | "acceptEdits"       // Auto-accept file edits
  | "bypassPermissions" // Bypass all permission checks (use with caution)

export interface ProxyConfig {
  port: number
  host: string
  debug: boolean
  permissionMode: PermissionMode
  workingDirectory?: string
}

export const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  port: 3456,
  host: "127.0.0.1",
  debug: process.env.CLAUDE_PROXY_DEBUG === "1",
  permissionMode: (process.env.CLAUDE_PROXY_PERMISSION_MODE as PermissionMode) || "bypassPermissions",
  workingDirectory: process.env.CLAUDE_PROXY_CWD || process.cwd()
}
