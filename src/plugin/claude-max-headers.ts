/**
 * OpenCode plugin that injects x-opencode-session and x-opencode-request headers
 * into requests sent to the Anthropic provider.
 *
 * This enables the claude-max-proxy to use reliable, header-based session tracking
 * instead of fingerprint-based heuristics.
 *
 * Installation:
 *   Copy this file to your project's .opencode/plugin/ directory,
 *   or reference it in opencode.json:
 *     { "plugin": ["file:///path/to/claude-max-headers.ts"] }
 */

// Inline types to avoid requiring @opencode-ai/plugin as a dependency.
// The plugin is loaded by opencode at runtime where these types are resolved.
type ChatHeadersHook = (
  incoming: {
    sessionID: string
    agent: any
    model: { providerID: string }
    provider: any
    message: { id: string }
  },
  output: { headers: Record<string, string> }
) => Promise<void>

type PluginHooks = {
  "chat.headers"?: ChatHeadersHook
}

type PluginFn = (input: any) => Promise<PluginHooks>

export const ClaudeMaxHeadersPlugin: PluginFn = async (_input) => {
  return {
    "chat.headers": async (incoming, output) => {
      if (incoming.model.providerID !== "anthropic") return

      output.headers["x-opencode-session"] = incoming.sessionID
      output.headers["x-opencode-request"] = incoming.message.id
    },
  }
}

export default ClaudeMaxHeadersPlugin
