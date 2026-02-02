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

const BLOCKED_BUILTIN_TOOLS = [
  "Read", "Write", "Edit", "MultiEdit",
  "Bash", "Glob", "Grep", "NotebookEdit",
  "WebFetch", "WebSearch", "TodoWrite"
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

export function createProxyServer(config: Partial<ProxyConfig> = {}) {
  const finalConfig = { ...DEFAULT_PROXY_CONFIG, ...config }
  const app = new Hono()

  app.use("*", cors())

  app.get("/", (c) => {
    return c.json({
      status: "ok",
      service: "claude-max-proxy",
      version: "1.0.0",
      format: "anthropic",
      endpoints: ["/v1/messages", "/messages"]
    })
  })

  const handleMessages = async (c: Context) => {
    try {
      const body = await c.req.json()
      const model = mapModelToClaudeModel(body.model || "sonnet")
      const stream = body.stream ?? true

      claudeLog("proxy.anthropic.request", { model, stream, messageCount: body.messages?.length })

      // Extract session ID from request headers for conversation resumption
      const resumeSessionId = c.req.header('X-Claude-Session-ID')
      if (resumeSessionId) {
        claudeLog("proxy.session.resume_requested", { sessionId: resumeSessionId })
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

      const prompt = body.messages
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
              permissionMode: finalConfig.permissionMode,
              cwd: finalConfig.workingDirectory,
              ...(resumeSessionId && { resume: resumeSessionId })
            }
          })

          for await (const message of response) {
            if (message.type === "assistant") {
              // Capture session ID from SDK response
              if (message.session_id) {
                currentSessionId = message.session_id
                if (resumeSessionId) {
                  claudeLog("proxy.session.resumed", { sessionId: currentSessionId })
                } else {
                  claudeLog("proxy.session.new", { sessionId: currentSessionId })
                }
              }
              for (const block of message.message.content) {
                if (block.type === "text") {
                  fullContent += block.text
                }
              }
            }
          }

          clearTimeout(timeout)

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
                permissionMode: finalConfig.permissionMode,
                cwd: finalConfig.workingDirectory,
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

                // Track turns and results
                if (message.type === "assistant") {
                  turnCount++
                  // Capture session ID from SDK response
                  if (message.session_id) {
                    if (!currentSessionId) {
                      currentSessionId = message.session_id
                      if (resumeSessionId) {
                        claudeLog("proxy.session.resumed", { sessionId: currentSessionId })
                      } else {
                        claudeLog("proxy.session.new", { sessionId: currentSessionId })
                      }
                    }
                  }
                  claudeLog("proxy.turn", { turn: turnCount, session_id: message.session_id })
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
                  claudeLog("proxy.result", {
                    subtype: message.subtype,
                    num_turns: message.num_turns,
                    duration_ms: message.duration_ms,
                    is_error: message.is_error
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
              exitedNormally: true
            })

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
