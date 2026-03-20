import { Hono } from "hono"
import { cors } from "hono/cors"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { Context } from "hono"
import type { ProxyConfig, PermissionMode } from "./types"
import { DEFAULT_PROXY_CONFIG } from "./types"
import { claudeLog } from "../logger"
import { execSync } from "child_process"
import { existsSync } from "fs"
import { fileURLToPath } from "url"
import { join, dirname } from "path"
import { opencodeMcpServer } from "../mcpTools"
import { createHash, randomUUID } from "crypto"
import { fuzzyMatchAgentName } from "./agentMatch"
import { buildAgentDefinitions } from "./agentDefs"
import { createPassthroughMcpServer, stripMcpPrefix, PASSTHROUGH_MCP_NAME, PASSTHROUGH_MCP_PREFIX } from "./passthroughTools"

// Session tracking for conversation continuity
// Maps opencode session ID -> Claude Agent SDK session state
interface SessionState {
  claudeSessionId: string
  lastAccess: number
  messageCount: number
  lastRequestId?: string
}
const sessionCache = new Map<string, SessionState>()

// Fallback: fingerprint-based session tracking for requests without x-opencode-session header
const fingerprintCache = new Map<string, SessionState>()

// Clean up stale sessions every 60 minutes (24 hour TTL like upstream)
const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of sessionCache.entries()) {
    if (now - value.lastAccess > SESSION_TTL_MS) {
      claudeLog("proxy.session.expired", { opencodeSession: key, claudeSessionId: value.claudeSessionId })
      sessionCache.delete(key)
    }
  }
  for (const [key, value] of fingerprintCache.entries()) {
    if (now - value.lastAccess > SESSION_TTL_MS) {
      claudeLog("proxy.session.expired", { fingerprint: key, claudeSessionId: value.claudeSessionId })
      fingerprintCache.delete(key)
    }
  }
}, 60 * 60 * 1000)

/**
 * Look up session state by opencode session ID (primary) or fingerprint (fallback).
 * When x-opencode-session header is present, it is the authoritative session key.
 * Otherwise fall back to fingerprint-based matching for backwards compatibility.
 */
function lookupSession(
  opencodeSessionId: string | undefined,
  body: {
    system?: string | Array<{ type: string; text?: string }>;
    messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  }
): { state: SessionState; source: "header" | "fingerprint" } | undefined {
  // Primary: use x-opencode-session header
  if (opencodeSessionId) {
    const cached = sessionCache.get(opencodeSessionId)
    if (cached) {
      claudeLog("proxy.session.lookup_hit", {
        source: "header",
        opencodeSession: opencodeSessionId,
        claudeSessionId: cached.claudeSessionId,
        previousMessageCount: cached.messageCount,
        currentMessageCount: body.messages?.length || 0
      })
      return { state: cached, source: "header" }
    }
    claudeLog("proxy.session.lookup_miss", { source: "header", opencodeSession: opencodeSessionId })
  }

  // Fallback: fingerprint-based matching
  const fingerprint = getConversationFingerprint(body)
  if (fingerprint) {
    const cached = fingerprintCache.get(fingerprint)
    if (cached) {
      claudeLog("proxy.session.lookup_hit", {
        source: "fingerprint",
        fingerprint,
        claudeSessionId: cached.claudeSessionId,
        previousMessageCount: cached.messageCount,
        currentMessageCount: body.messages?.length || 0
      })
      return { state: cached, source: "fingerprint" }
    }
  }

  return undefined
}

/**
 * Store the Claude Agent SDK session ID, keyed by opencode session and/or fingerprint.
 */
function storeSession(
  opencodeSessionId: string | undefined,
  body: {
    system?: string | Array<{ type: string; text?: string }>;
    messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  },
  claudeSessionId: string,
  requestId?: string
): void {
  if (!claudeSessionId) return

  const messageCount = body.messages?.length || 0
  const state: SessionState = {
    claudeSessionId,
    lastAccess: Date.now(),
    messageCount,
    lastRequestId: requestId
  }

  // Store by opencode session ID (primary)
  if (opencodeSessionId) {
    sessionCache.set(opencodeSessionId, state)
    claudeLog("proxy.session.stored", {
      source: "header",
      opencodeSession: opencodeSessionId,
      claudeSessionId,
      messageCount
    })
  }

  // Also store by fingerprint (fallback for requests without header)
  const fingerprint = getConversationFingerprint(body)
  if (fingerprint) {
    fingerprintCache.set(fingerprint, state)
    claudeLog("proxy.session.stored", {
      source: "fingerprint",
      fingerprint,
      claudeSessionId,
      messageCount
    })
  }
}

/**
 * Generate a fingerprint for a conversation (fallback when no x-opencode-session header).
 */
function getConversationFingerprint(body: {
  system?: string | Array<{ type: string; text?: string }>;
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
}): string {
  let firstUserMessage: string | undefined
  if (body.messages && body.messages.length > 0) {
    for (const msg of body.messages) {
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          firstUserMessage = msg.content
        } else if (Array.isArray(msg.content)) {
          firstUserMessage = msg.content
            .filter((block: any) => block.type === "text" && block.text)
            .map((block: any) => block.text)
            .join("")
        }
        break
      }
    }
  }

  if (!firstUserMessage) return ""

  const contextSnippet = firstUserMessage.slice(0, 2000)
  return createHash("sha256").update(contextSnippet).digest("hex").slice(0, 16)
}

/**
 * Extract only the last user message from the conversation.
 *
 * When resuming a Claude Agent SDK session, the SDK already has the full
 * conversation history. OpenCode re-sends everything (user1, assistant1,
 * user2, ...) but we only need the genuinely new user turn.
 *
 * Slicing by message count is unreliable because opencode inserts synthetic
 * user messages (reminders, system tags) that inflate the count. Instead,
 * find the last "user" role message — that is the new turn.
 */
function getLastUserMessage(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
): Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg && msg.role === "user") {
      return [msg]
    }
  }
  return messages.slice(-1)
}

/** Clear all session caches (used in tests) */
export function clearSessionCache() {
  sessionCache.clear()
  fingerprintCache.clear()
}

// --- Error Classification ---
function classifyError(errMsg: string): { status: number; type: string; message: string } {
  const lower = errMsg.toLowerCase()

  if (lower.includes("401") || lower.includes("authentication") || lower.includes("invalid auth") || lower.includes("credentials")) {
    return {
      status: 401,
      type: "authentication_error",
      message: "Claude authentication expired or invalid. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
    }
  }

  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many requests")) {
    return {
      status: 429,
      type: "rate_limit_error",
      message: "Claude Max rate limit reached. Wait a moment and try again."
    }
  }

  if (lower.includes("402") || lower.includes("billing") || lower.includes("subscription") || lower.includes("payment")) {
    return {
      status: 402,
      type: "billing_error",
      message: "Claude Max subscription issue. Check your subscription status at https://claude.ai/settings/subscription"
    }
  }

  if (lower.includes("exited with code") || lower.includes("process exited")) {
    const codeMatch = errMsg.match(/exited with code (\d+)/)
    const code = codeMatch ? codeMatch[1] : "unknown"

    if (code === "1" && !lower.includes("tool") && !lower.includes("mcp")) {
      return {
        status: 401,
        type: "authentication_error",
        message: "Claude Code process crashed (exit code 1). This usually means authentication expired. Run 'claude login' in your terminal to re-authenticate, then restart the proxy."
      }
    }

    return {
      status: 502,
      type: "api_error",
      message: `Claude Code process exited unexpectedly (code ${code}). Check proxy logs for details. If this persists, try 'claude login' to refresh authentication.`
    }
  }

  if (lower.includes("timeout") || lower.includes("timed out")) {
    return {
      status: 504,
      type: "timeout_error",
      message: "Request timed out. The operation may have been too complex. Try a simpler request."
    }
  }

  if (lower.includes("500") || lower.includes("server error") || lower.includes("internal error")) {
    return {
      status: 502,
      type: "api_error",
      message: "Claude API returned a server error. This is usually temporary — try again in a moment."
    }
  }

  if (lower.includes("503") || lower.includes("overloaded")) {
    return {
      status: 503,
      type: "overloaded_error",
      message: "Claude is temporarily overloaded. Try again in a few seconds."
    }
  }

  return {
    status: 500,
    type: "api_error",
    message: errMsg || "Unknown error"
  }
}

const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
]

// Claude Code SDK tools that have NO equivalent in OpenCode.
const CLAUDE_CODE_ONLY_TOOLS = [
  "ToolSearch",
  "CronCreate",
  "CronDelete",
  "CronList",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "NotebookEdit",
  "TodoWrite",
  "AskUserQuestion",
  "Skill",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "WebSearch",
]

const MCP_SERVER_NAME = "opencode"

const ALLOWED_MCP_TOOLS = [
  `mcp__${MCP_SERVER_NAME}__read`,
  `mcp__${MCP_SERVER_NAME}__write`,
  `mcp__${MCP_SERVER_NAME}__edit`,
  `mcp__${MCP_SERVER_NAME}__bash`,
  `mcp__${MCP_SERVER_NAME}__glob`,
  `mcp__${MCP_SERVER_NAME}__grep`
]

// MCP CLI tools directory (generated by mcporter)
const MCP_TOOLS_DIR = process.env.MCP_TOOLS_DIR || `${process.env.HOME}/.local/bin`

// Prepend MCP tools directory to PATH so Claude Agent SDK can invoke them via Bash
function buildEnvWithMcpTools(): Record<string, string | undefined> {
  const env = { ...process.env }
  const currentPath = env.PATH || ""
  env.PATH = `${MCP_TOOLS_DIR}:${currentPath}`
  return env
}

// System prompt addition for MCP CLI tools
const MCP_CLI_SYSTEM_PROMPT = `
You have access to external CLI tools generated from MCP servers. Use them via Bash:

## mcp-github — GitHub operations (44 tools)
Usage: mcp-github <command> [--flags] --output json
Common: get-me, list-issues, list-pull-requests, search-code, search-issues,
        issue-read, pull-request-read, create-pull-request, add-issue-comment,
        list-commits, list-branches, get-file-contents, merge-pull-request
Example: mcp-github list-pull-requests --owner awcjack --repo myrepo --output json

## mcp-gke — Google Kubernetes Engine (8 tools)
Usage: mcp-gke <command> [--flags] --output json
Common: list-clusters, get-cluster, query-logs, get-log-schema,
        list-recommendations, list-monitored-resource-descriptors
Example: mcp-gke list-clusters --output json

Run \`mcp-github --help\` or \`mcp-gke --help\` for full usage.
Always use --output json for machine-readable results.
`.trim()

function resolveClaudeExecutable(): string {
  // 1. Try the SDK's bundled cli.js (same dir as this module's SDK)
  try {
    const sdkPath = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))
    const sdkCliJs = join(dirname(sdkPath), "cli.js")
    if (existsSync(sdkCliJs)) return sdkCliJs
  } catch {}

  // 2. Try the system-installed claude binary
  try {
    const claudePath = execSync("which claude", { encoding: "utf-8" }).trim()
    if (claudePath && existsSync(claudePath)) return claudePath
  } catch {}

  throw new Error("Could not find Claude Code executable. Install via: npm install -g @anthropic-ai/claude-code")
}

const claudeExecutable = resolveClaudeExecutable()

function mapModelToClaudeModel(model: string): "sonnet" | "opus" | "haiku" {
  if (model.includes("opus")) return "opus"
  if (model.includes("haiku")) return "haiku"
  return "sonnet"
}

/**
 * Detect if OpenCode is in plan mode by checking the last user message
 * for the plan.txt system-reminder marker that OpenCode appends.
 */
function detectPlanMode(
  messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
): boolean {
  if (!messages || messages.length === 0) return false

  // Find the last user message (OpenCode appends plan.txt to it)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "user") continue

    const text = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content
            .filter((block: any) => block.type === "text" && block.text)
            .map((block: any) => block.text)
            .join("")
        : ""

    // Check for OpenCode's plan mode markers from plan.txt
    return text.includes("# Plan Mode - System Reminder")
      || text.includes("Plan mode ACTIVE")
      || text.includes("Plan mode is active. The user indicated that they do not want you to execute yet")
  }

  return false
}

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "1.8.0",
      format: "anthropic",
      endpoints: ["/v1/messages", "/messages", "/health"]
    })
  })

  // --- Concurrency Control ---
  const MAX_CONCURRENT_SESSIONS = parseInt(process.env.CLAUDE_PROXY_MAX_CONCURRENT || "10", 10)
  let activeSessions = 0
  const sessionQueue: Array<{ resolve: () => void }> = []

  async function acquireSession(): Promise<void> {
    if (activeSessions < MAX_CONCURRENT_SESSIONS) {
      activeSessions++
      return
    }
    return new Promise<void>((resolve) => {
      sessionQueue.push({ resolve })
    })
  }

  function releaseSession(): void {
    activeSessions--
    const next = sessionQueue.shift()
    if (next) {
      activeSessions++
      next.resolve()
    }
  }

  const handleMessages = async (c: Context) => {
    try {
      const body = await c.req.json()
      const model = mapModelToClaudeModel(body.model || "sonnet")
      const stream = body.stream ?? true

      // Extract and strip x-opencode-* headers (they should not reach Claude Agent SDK)
      const opencodeSessionId = c.req.header("x-opencode-session")
      const opencodeRequestId = c.req.header("x-opencode-request")

      // Detect if OpenCode is in plan mode and override permission mode
      const isPlanMode = detectPlanMode(body.messages)
      const effectivePermissionMode = isPlanMode ? "plan" : finalConfig.permissionMode

      claudeLog("proxy.anthropic.request", {
        model,
        stream,
        messageCount: body.messages?.length,
        opencodeSession: opencodeSessionId,
        opencodeRequest: opencodeRequestId,
        isPlanMode,
        effectivePermissionMode
      })

      // Session tracking: use x-opencode-session (primary) or fingerprint (fallback)
      const sessionLookup = lookupSession(opencodeSessionId, body)
      const resumeSessionId = sessionLookup?.state.claudeSessionId

      if (resumeSessionId) {
        claudeLog("proxy.session.resume_requested", {
          claudeSessionId: resumeSessionId,
          source: sessionLookup!.source,
          opencodeSession: opencodeSessionId,
          currentMessageCount: body.messages?.length
        })
      }

      // Capture stderr for debugging
      const stderrMessages: string[] = []

      const stderrHandler = (data: string) => {
        stderrMessages.push(data)
        // Log all stderr output when debug is enabled, or if it contains errors
        if (finalConfig.debug || data.includes("error") || data.includes("failed") || data.includes("abort")) {
          console.error("[Claude SDK stderr]:", data)
        }
        // Log abort messages specifically
        if (data.includes("aborted")) {
          claudeLog("proxy.sdk.abort_detected", { message: data })
        }
      }

      // When resuming a session, only send the last user message.
      // The Claude Agent SDK already has the full conversation history via `resume`.
      // OpenCode re-sends everything, but we only need the new user turn.
      const messagesToSend = resumeSessionId
        ? getLastUserMessage(body.messages)
        : body.messages

      if (resumeSessionId) {
        claudeLog("proxy.session.sending_last_user_message", {
          totalMessages: body.messages?.length,
          sendingNew: messagesToSend?.length
        })
      }

      const prompt = messagesToSend
        ?.map((m: { role: string; content: string | Array<{ type: string; text?: string }> }) => {
          const role = m.role === "assistant" ? "Assistant" : "Human"
          let content: string
          if (typeof m.content === "string") {
            content = m.content
          } else if (Array.isArray(m.content)) {
            content = m.content
              .filter((block: any) => block.type === "text" && block.text)
              .map((block: any) => block.text)
              .join("")
          } else {
            content = String(m.content)
          }
          return `${role}: ${content}`
        })
        .join("\n\n") || ""

      if (!stream) {
        let fullContent = ""
        let currentSessionId: string | undefined
        const abortController = new AbortController()
        // Use environment variable or default to 60 minutes for large context tasks
        const timeoutMs = parseInt(process.env.CLAUDE_PROXY_TIMEOUT_MS || "3600000", 10)
        const timeout = setTimeout(() => {
          abortController.abort(new Error("Request timeout"))
        }, timeoutMs)

        try {
          claudeLog("proxy.query.start", { mode: "non-streaming", model, timeoutMs, resume: !!resumeSessionId })

          // Allow unlimited turns for complex tasks (use abortController for timeout)
          const response = query({
            prompt,
            options: {
              model,
              abortController,
              stderr: stderrHandler,
              permissionMode: effectivePermissionMode,
              cwd: finalConfig.workingDirectory,
              env: buildEnvWithMcpTools(),
              systemPrompt: {
                type: "preset",
                preset: "claude_code",
                append: MCP_CLI_SYSTEM_PROMPT,
              },
              mcpServers: {
                "computer-control-mcp": {
                  command: "uvx",
                  args: ["computer-control-mcp", "server"]
                }
              },
              ...(resumeSessionId && { resume: resumeSessionId })
            }
          })

          for await (const message of response) {
            // Capture session ID from SystemMessage init (available early)
            if (message.type === "system" && (message as any).subtype === "init") {
              if ((message as any).session_id) {
                currentSessionId = (message as any).session_id
                if (resumeSessionId) {
                  claudeLog("proxy.session.resumed", { sessionId: currentSessionId })
                } else {
                  claudeLog("proxy.session.new", { sessionId: currentSessionId })
                }
              }
            }
            // Also capture from ResultMessage (most reliable, always present)
            if (message.type === "result") {
              if ((message as any).session_id) {
                currentSessionId = (message as any).session_id
              }
            }
            if (message.type === "assistant") {
              for (const block of message.message.content) {
                if (block.type === "text") {
                  fullContent += block.text
                }
              }
            }
          }

          clearTimeout(timeout)

          // Store session for future requests
          if (currentSessionId) {
            storeSession(opencodeSessionId, body, currentSessionId, opencodeRequestId)
          }

          return c.json({
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: fullContent }],
            model: body.model,
            stop_reason: "end_turn",
            usage: { input_tokens: 0, output_tokens: 0 }
          }, {
            headers: {
              'X-Claude-Session-ID': currentSessionId || `session_${Date.now()}`
            }
          })
        } catch (error) {
          clearTimeout(timeout)

          // Enhanced error logging for exit code 1
          if (error instanceof Error) {
            console.error("[Proxy Error]:", error.message)
            if (stderrMessages.length > 0) {
              console.error("[Claude SDK stderr]:", stderrMessages.join("\n"))
            }
          }

          throw error
        }
      }

      // Create abort controller for timeout and cleanup
      const abortController = new AbortController()
      // Use environment variables or defaults for large context support
      const streamTimeout = parseInt(process.env.CLAUDE_PROXY_TIMEOUT_MS || "3600000", 10) // 60 minutes default
      const inactivityTimeout = parseInt(process.env.CLAUDE_PROXY_INACTIVITY_MS || "900000", 10) // 15 minutes default
      let timeoutId: Timer | null = null
      let inactivityTimeoutId: Timer | null = null
      let clientDisconnected = false  // Track client-initiated disconnection
      let currentSessionId: string | undefined
      let turnCount = 0
      let hasResult = false
      let hasStreamEvents = false  // Track if we receive stream events

      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          // Set overall stream timeout
          timeoutId = setTimeout(() => {
            claudeLog("proxy.stream.timeout", { timeout: streamTimeout })
            abortController.abort(new Error("Stream timeout exceeded"))
            controller.close()
          }, streamTimeout)

          // Function to reset inactivity timeout
          const resetInactivityTimeout = () => {
            if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId)
            inactivityTimeoutId = setTimeout(() => {
              claudeLog("proxy.stream.inactivity", { timeout: inactivityTimeout })
              abortController.abort(new Error("Stream inactivity timeout"))
              controller.close()
            }, inactivityTimeout)
          }

          try {
            controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: `msg_${Date.now()}`,
                type: "message",
                role: "assistant",
                content: [],
                model: body.model,
                stop_reason: null,
                usage: { input_tokens: 0, output_tokens: 0 }
              }
            })}\n\n`))

            controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" }
            })}\n\n`))

            resetInactivityTimeout()

            claudeLog("proxy.query.start", { mode: "streaming", model, streamTimeout, inactivityTimeout, resume: !!resumeSessionId })

            // Create query with streaming options and abort controller
            // Allow unlimited turns for complex tasks (timeout controlled by abortController)
            const response = query({
              prompt,
              options: {
                model,
                includePartialMessages: true,  // Enable real-time streaming events
                abortController,  // For cancellation control
                stderr: stderrHandler,
                permissionMode: effectivePermissionMode,
                cwd: finalConfig.workingDirectory,
                env: buildEnvWithMcpTools(),
                systemPrompt: {
                  type: "preset",
                  preset: "claude_code",
                  append: MCP_CLI_SYSTEM_PROMPT,
                },
                mcpServers: {
                  "computer-control-mcp": {
                    command: "uvx",
                    args: ["computer-control-mcp", "server"]
                  }
                },
                ...(resumeSessionId && { resume: resumeSessionId })
              }
            })

            // Heartbeat to keep connection alive
            const heartbeat = setInterval(() => {
              // Stop heartbeat if client disconnected
              if (clientDisconnected) {
                clearInterval(heartbeat)
                return
              }
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`))
              } catch {
                clearInterval(heartbeat)
              }
            }, 15_000)

            try {
              for await (const message of response) {
                // Break early if client disconnected
                if (clientDisconnected) {
                  claudeLog("proxy.stream.early_exit", { message: "Client disconnected during streaming" })
                  break
                }

                // Reset inactivity timeout on each message
                resetInactivityTimeout()

                // Log ALL message types for debugging
                if (finalConfig.debug) {
                  claudeLog("proxy.message", { type: message.type, keys: Object.keys(message) })
                }

                // Capture session ID from SystemMessage init (available early in stream)
                if (message.type === "system" && (message as any).subtype === "init") {
                  if ((message as any).session_id && !currentSessionId) {
                    currentSessionId = (message as any).session_id
                    if (resumeSessionId) {
                      claudeLog("proxy.session.resumed", { sessionId: currentSessionId })
                    } else {
                      claudeLog("proxy.session.new", { sessionId: currentSessionId })
                    }
                  }
                }

                // Track turns and results
                if (message.type === "assistant") {
                  turnCount++
                  claudeLog("proxy.turn", { turn: turnCount })
                  if (finalConfig.debug) {
                    claudeLog("proxy.assistant.content", {
                      contentBlockCount: message.message.content.length,
                      types: message.message.content.map((b: any) => b.type)
                    })
                  }
                }

                // Log tool execution results
                if (message.type === "user" && (message as any).tool_use_result) {
                  const toolResult = (message as any).tool_use_result
                  console.log("[TOOL RESULT]:", {
                    is_error: toolResult.is_error,
                    content_preview: JSON.stringify(toolResult).substring(0, 500)
                  })
                  claudeLog("proxy.tool_result", {
                    tool_result: toolResult,
                    is_error: toolResult.is_error,
                    content_preview: JSON.stringify(toolResult).substring(0, 500)
                  })
                }

                if (message.type === "result") {
                  hasResult = true
                  // Capture session ID from ResultMessage (most reliable, always present)
                  if ((message as any).session_id) {
                    currentSessionId = (message as any).session_id
                  }
                  claudeLog("proxy.result", {
                    subtype: message.subtype,
                    num_turns: message.num_turns,
                    duration_ms: message.duration_ms,
                    is_error: message.is_error,
                    session_id: currentSessionId
                  })
                }

                // Handle partial streaming events for real-time updates
                if (message.type === "stream_event") {
                  hasStreamEvents = true
                  const event = message.event

                  // Only forward TEXT events to OpenCode, not tool_use
                  // The SDK handles file operations internally and returns text descriptions
                  if (event.type === "content_block_start") {
                    // Only forward text content blocks, skip tool_use
                    if (event.content_block?.type === "text" || !event.content_block?.type) {
                      controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                        type: "content_block_start",
                        index: event.index,
                        content_block: { type: "text", text: "" }
                      })}\n\n`))

                    }
                  } else if (event.type === "content_block_delta") {
                    // Only forward text deltas, skip tool input deltas
                    if (event.delta?.type === "text_delta") {
                      controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: "content_block_delta",
                        index: event.index,
                        delta: event.delta
                      })}\n\n`))
                    }
                  } else if (event.type === "content_block_stop") {
                    // Forward all stops
                    controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: event.index
                    })}\n\n`))
                  }
                }
                // Handle complete assistant messages ONLY if we haven't received stream events
                // (fallback for older SDK versions or when streaming is not available)
                else if (message.type === "assistant" && !hasStreamEvents) {
                  // Only forward text blocks, skip tool_use blocks
                  // The SDK executes tools internally and describes what it did in text
                  const textBlocks = message.message.content.filter((b: any) => b.type === "text")

                  for (let i = 0; i < textBlocks.length; i++) {
                    const block = textBlocks[i]
                    if (!block || block.type !== "text") continue

                    // Send content_block_start
                    controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify({
                      type: "content_block_start",
                      index: i,
                      content_block: { type: "text", text: "" }
                    })}\n\n`))

                    // Send content as delta
                    controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: i,
                      delta: { type: "text_delta", text: (block as any).text }
                    })}\n\n`))

                    // Send content_block_stop
                    controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: "content_block_stop",
                      index: i
                    })}\n\n`))
                  }
                }
              }
            } finally {
              clearInterval(heartbeat)
            }

            // Log completion
            claudeLog("proxy.stream.complete", {
              turns: turnCount,
              hasResult,
              hasStreamEvents,
              exitedNormally: true,
              sessionId: currentSessionId
            })

            // Store session for future requests
            if (currentSessionId) {
              storeSession(opencodeSessionId, body, currentSessionId, opencodeRequestId)
            }

            // Clear timeouts on successful completion
            if (timeoutId) clearTimeout(timeoutId)
            if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId)

            controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0
            })}\n\n`))

            controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 0 }
            })}\n\n`))

            controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
              type: "message_stop"
            })}\n\n`))

            controller.close()
          } catch (error) {
            // Clear timeouts on error
            if (timeoutId) clearTimeout(timeoutId)
            if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId)

            // If client disconnected, this is expected - don't treat as error
            if (clientDisconnected) {
              claudeLog("proxy.stream.client_disconnect_handled", { message: "Client disconnected, cleanup complete" })
              controller.close()
              return
            }

            const errorMessage = error instanceof Error ? error.message : String(error)

            // Check for Claude SDK process abort (different from user-initiated abort)
            const isSdkAbort = errorMessage.includes("Claude Code process aborted") ||
                               errorMessage.includes("process aborted by user")

            // Check for connection resets (but not SDK aborts)
            const isConnectionReset = !isSdkAbort && error instanceof Error && (
              error.message.includes("reset") ||
              error.message.includes("ECONNRESET") ||
              error.name === "AbortError"
            )

            // Check for Claude Code exit code 1 (authentication/initialization failure)
            const isExitCode1 = errorMessage.includes("exited with code 1") ||
                                errorMessage.includes("exit code 1")

            // Enhanced error logging
            if (isExitCode1) {
              console.error("\n❌ Claude Code Authentication Error")
              console.error("━".repeat(60))
              console.error("The Claude Code CLI exited with code 1.")
              console.error("\nCommon causes:")
              console.error("  1. Not logged in - run: claude login")
              console.error("  2. Invalid API key or session expired")
              console.error("  3. Claude Code CLI not installed")
              console.error("\nStderr output:")
              if (stderrMessages.length > 0) {
                stderrMessages.forEach(msg => console.error("  ", msg))
              } else {
                console.error("   (no stderr output)")
              }
              console.error("━".repeat(60))
              console.error("\nTroubleshooting steps:")
              console.error("  1. Run: claude login")
              console.error("  2. Verify: claude --version")
              console.error("  3. Check: echo $ANTHROPIC_API_KEY")
              console.error("━".repeat(60) + "\n")

              claudeLog("proxy.sdk.exit_code_1", {
                error: errorMessage,
                stderr: stderrMessages
              })
            } else if (isSdkAbort) {
              console.error("\n⚠️  Claude SDK Process Abort")
              console.error("━".repeat(60))
              console.error("The Claude SDK process exited unexpectedly.")
              console.error("\nError:", errorMessage)
              console.error("\nContext:")
              console.error("  Turn count:", turnCount)
              console.error("  Has result:", hasResult)
              console.error("  Debug mode:", finalConfig.debug)
              console.error("\nStderr output:")
              if (stderrMessages.length > 0) {
                stderrMessages.forEach(msg => console.error("  ", msg))
              } else {
                console.error("   (no stderr output)")
              }
              console.error("\nPossible causes:")
              console.error("  1. SDK process received a signal (SIGTERM, SIGINT)")
              console.error("  2. Resource constraints (memory, CPU)")
              console.error("  3. Internal SDK error or crash")
              console.error("  4. Network connectivity issues")
              console.error("  5. API rate limiting or quota exceeded")
              console.error("\nTroubleshooting:")
              console.error("  1. Check system resources: htop or Activity Monitor")
              console.error("  2. Enable debug logging: export OPENCODE_CLAUDE_PROVIDER_DEBUG=1")
              console.error("  3. Try with increased timeouts:")
              console.error("     export CLAUDE_PROXY_TIMEOUT_MS=7200000  # 2 hours")
              console.error("  4. Check network connectivity: curl https://api.anthropic.com")
              console.error("  5. Verify Claude login: claude login")
              console.error("  6. Check Claude Code version: claude --version")
              console.error("━".repeat(60) + "\n")

              claudeLog("proxy.sdk.abort", {
                error: errorMessage,
                stderr: stderrMessages,
                turnCount,
                hasResult
              })
            } else if (isConnectionReset) {
              console.error("[Connection Reset]:", errorMessage)
              if (stderrMessages.length > 0) {
                console.error("[Claude SDK stderr]:", stderrMessages.join("\n"))
              }
              claudeLog("proxy.connection.reset", {
                error: errorMessage,
                type: error instanceof Error ? error.name : "unknown"
              })
            } else {
              console.error("[Proxy Error]:", errorMessage)
              if (stderrMessages.length > 0) {
                console.error("[Claude SDK stderr]:", stderrMessages.join("\n"))
              }
              claudeLog("proxy.anthropic.error", {
                error: errorMessage
              })
            }

            // Send appropriate error to client
            let errorType = "api_error"
            let userMessage = errorMessage

            if (isExitCode1) {
              errorType = "authentication_error"
              userMessage = "Claude Code authentication failed. Please run 'claude login' and try again."
            } else if (isSdkAbort) {
              errorType = "api_error"
              userMessage = "Claude SDK process exited unexpectedly. This may be due to resource constraints, network issues, or an internal SDK error. Check the proxy logs for details."
            } else if (isConnectionReset) {
              errorType = "connection_error"
            }

            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
              type: "error",
              error: {
                type: errorType,
                message: userMessage
              }
            })}\n\n`))
            controller.close()
          }
        },
        cancel() {
          // Cleanup on client disconnect
          clientDisconnected = true
          claudeLog("proxy.stream.cancelled", { message: "Client disconnected" })
          if (timeoutId) clearTimeout(timeoutId)
          if (inactivityTimeoutId) clearTimeout(inactivityTimeoutId)
          // Don't abort the SDK process - let it complete gracefully
          // The stream will be closed but SDK can finish its work
        }
      })

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Claude-Session-ID": currentSessionId || resumeSessionId || `session_${Date.now()}`
        }
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const isExitCode1 = errorMessage.includes("exited with code 1") ||
                          errorMessage.includes("exit code 1")

      if (isExitCode1) {
        console.error("\n❌ Claude Code Authentication Error (Non-Streaming)")
        console.error("━".repeat(60))
        console.error("Error:", errorMessage)
        console.error("\nPlease run: claude login")
        console.error("━".repeat(60) + "\n")
      }

      claudeLog("proxy.error", { error: errorMessage })

      return c.json({
        type: "error",
        error: {
          type: isExitCode1 ? "authentication_error" : "api_error",
          message: isExitCode1
            ? "Claude Code authentication failed. Please run 'claude login' and try again."
            : errorMessage
        }
      }, isExitCode1 ? 401 : 500)
    }
  }

  app.post("/v1/messages", handleMessages)
  app.post("/messages", handleMessages)

  // Health check endpoint — verifies auth status
  app.get("/health", (c) => {
    try {
      const authJson = execSync("claude auth status", { encoding: "utf-8", timeout: 5000 })
      const auth = JSON.parse(authJson)
      if (!auth.loggedIn) {
        return c.json({
          status: "unhealthy",
          error: "Not logged in. Run: claude login",
          auth: { loggedIn: false }
        }, 503)
      }
      return c.json({
        status: "healthy",
        auth: {
          loggedIn: true,
          email: auth.email,
          subscriptionType: auth.subscriptionType,
        },
        mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
      })
    } catch {
      return c.json({
        status: "degraded",
        error: "Could not verify auth status",
        mode: process.env.CLAUDE_PROXY_PASSTHROUGH ? "passthrough" : "internal",
      })
    }
  })

  return { app, config: finalConfig }
}

export async function startProxyServer(config: Partial<ProxyConfig> = {}) {
  const { app, config: finalConfig } = createProxyServer(config)

  // Configure Bun server with no idle timeout for long-running requests
  const server = Bun.serve({
    port: finalConfig.port,
    hostname: finalConfig.host,
    fetch: app.fetch,
    // Disable idle timeout - we handle timeouts in the stream itself
    idleTimeout: 0,
    // Use a very large write timeout for streaming responses (2 hours)
    development: false
  })

  const timeoutMs = parseInt(process.env.CLAUDE_PROXY_TIMEOUT_MS || "3600000", 10)
  const inactivityMs = parseInt(process.env.CLAUDE_PROXY_INACTIVITY_MS || "900000", 10)

  console.log(`\n${"=".repeat(70)}`)
  console.log(`Claude Max Proxy (Anthropic API)`)
  console.log(`${"=".repeat(70)}`)
  console.log(`Server: http://${finalConfig.host}:${finalConfig.port}`)
  console.log(`\nWorking Directory: ${finalConfig.workingDirectory}`)
  console.log(`  ⚠️  File operations are restricted to this directory and subdirectories`)
  console.log(`  💡 To change: export CLAUDE_PROXY_CWD=/path/to/your/project`)
  console.log(`\nPermission Mode: ${finalConfig.permissionMode}`)
  if (finalConfig.permissionMode === "bypassPermissions") {
    console.log(`  ⚠️  Auto-approving all file operations (no prompts)`)
  } else if (finalConfig.permissionMode === "acceptEdits") {
    console.log(`  ✓ Auto-approving file edits (reads will still prompt)`)
  } else {
    console.log(`  ℹ️  Will prompt for file operations`)
  }
  console.log(`\nTimeout Configuration:`)
  console.log(`  Total timeout:      ${timeoutMs / 1000 / 60} minutes (${timeoutMs}ms)`)
  console.log(`  Inactivity timeout: ${inactivityMs / 1000 / 60} minutes (${inactivityMs}ms)`)
  console.log(`\nTo use with OpenCode:`)
  console.log(`  ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://${finalConfig.host}:${finalConfig.port} opencode`)
  console.log(`\nConfiguration Options:`)
  console.log(`  # Permission modes:`)
  console.log(`  export CLAUDE_PROXY_PERMISSION_MODE=bypassPermissions  # No prompts (default)`)
  console.log(`  export CLAUDE_PROXY_PERMISSION_MODE=acceptEdits        # Auto-approve edits`)
  console.log(`  export CLAUDE_PROXY_PERMISSION_MODE=default            # Prompt for all`)
  console.log(`  `)
  console.log(`  # Working directory:`)
  console.log(`  export CLAUDE_PROXY_CWD=/path/to/your/project`)
  console.log(`  `)
  console.log(`  # Timeouts for large tasks:`)
  console.log(`  export CLAUDE_PROXY_TIMEOUT_MS=7200000      # 2 hours total`)
  console.log(`  export CLAUDE_PROXY_INACTIVITY_MS=1800000   # 30 minutes inactivity`)
  console.log(`${"=".repeat(70)}\n`)

  return server
}
