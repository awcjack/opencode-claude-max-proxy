# opencode-claude-max-proxy

[![npm version](https://img.shields.io/npm/v/opencode-claude-max-proxy.svg)](https://www.npmjs.com/package/opencode-claude-max-proxy)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/rynfar/opencode-claude-max-proxy.svg)](https://github.com/rynfar/opencode-claude-max-proxy/stargazers)

Use your **Claude Max subscription** with OpenCode.

## The Problem

Anthropic doesn't allow Claude Max subscribers to use their subscription with third-party tools like OpenCode. If you want to use Claude in OpenCode, you have to pay for API access separately - even though you're already paying for "unlimited" Claude.

Your options are:
1. Use Claude's official apps only (limited to their UI)
2. Pay again for API access on top of your Max subscription
3. **Use this proxy**

## The Solution

This proxy bridges the gap using Anthropic's own tools:

```
OpenCode → Proxy (localhost:3456) → Claude Agent SDK → Your Claude Max Subscription
```

The [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) is Anthropic's **official npm package** that lets developers build with Claude using their Max subscription. This proxy simply translates OpenCode's API requests into SDK calls.

**Your Max subscription. Anthropic's official SDK. Zero additional cost.**

## Is This Allowed?

**Yes.** Here's why:

| Concern | Reality |
|---------|---------|
| "Bypassing restrictions" | No. We use Anthropic's public SDK exactly as documented |
| "Violating TOS" | No. The SDK is designed for programmatic Claude access |
| "Unauthorized access" | No. You authenticate with `claude login` using your own account |
| "Reverse engineering" | No. We call `query()` from their npm package, that's it |

The Claude Agent SDK exists specifically to let Max subscribers use Claude programmatically. We're just translating the request format so OpenCode can use it.

**~200 lines of TypeScript. No hacks. No magic. Just format translation.**

## Features

| Feature | Description |
|---------|-------------|
| **Zero API costs** | Uses your Claude Max subscription, not per-token billing |
| **Full compatibility** | Works with any Anthropic model in OpenCode |
| **Streaming support** | Real-time SSE streaming just like the real API |
| **Session resumption** | Continue conversations across requests with context preservation |
| **Large context support** | No turn limits - handles complex, multi-step tasks |
| **Auto-permissions** | No file operation prompts - seamless workflow |
| **Configurable timeouts** | 60 minute default, adjustable for massive tasks |
| **Auto-start** | Optional launchd service for macOS |
| **Simple setup** | Two commands to get running |

## Prerequisites

1. **Claude Max subscription** - [Subscribe here](https://claude.ai/settings/subscription)

2. **Claude CLI** installed and authenticated:
   ```bash
   npm install -g @anthropic-ai/claude-code
   claude login
   ```

3. **Bun** runtime:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

## Installation

```bash
git clone https://github.com/rynfar/opencode-claude-max-proxy
cd opencode-claude-max-proxy
bun install
```

## Usage

### Start the Proxy

```bash
bun run proxy
```

### Run OpenCode

```bash
ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

Select any `anthropic/claude-*` model (opus, sonnet, haiku).

### One-liner

```bash
bun run proxy & ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode
```

## Auto-start on macOS

Set up the proxy to run automatically on login:

```bash
cat > ~/Library/LaunchAgents/com.claude-max-proxy.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.claude-max-proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which bun)</string>
        <string>run</string>
        <string>proxy</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$(pwd)</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.claude-max-proxy.plist
```

Then add an alias to `~/.zshrc`:

```bash
echo "alias oc='ANTHROPIC_API_KEY=dummy ANTHROPIC_BASE_URL=http://127.0.0.1:3456 opencode'" >> ~/.zshrc
source ~/.zshrc
```

Now just run `oc` to start OpenCode with Claude Max.

## Model Mapping

| OpenCode Model | Claude SDK |
|----------------|------------|
| `anthropic/claude-opus-*` | opus |
| `anthropic/claude-sonnet-*` | sonnet |
| `anthropic/claude-haiku-*` | haiku |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `CLAUDE_PROXY_PORT` | 3456 | Proxy server port |
| `CLAUDE_PROXY_HOST` | 127.0.0.1 | Proxy server host |

## How It Works

1. **OpenCode** sends a request to `http://127.0.0.1:3456/messages` (thinking it's the Anthropic API)
2. **Proxy** receives the request and extracts the messages
3. **Proxy** calls `query()` from the Claude Agent SDK with your prompt
4. **Claude Agent SDK** authenticates using your Claude CLI login (tied to your Max subscription)
5. **Claude** processes the request using your subscription
6. **Proxy** streams the response back in Anthropic SSE format
7. **OpenCode** receives the response as if it came from the real API

The proxy is ~200 lines of TypeScript. No magic, no hacks.

## Session Resumption

**New in v1.1.0**: Continue conversations across multiple requests with full context preservation.

### How It Works

The proxy now captures session IDs from the Claude SDK and returns them via the `X-Claude-Session-ID` response header. Include this header in subsequent requests to resume the conversation:

```bash
# First request - get session ID
RESPONSE=$(curl -i -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"My name is Alice"}]}')

SESSION_ID=$(echo "$RESPONSE" | grep -i "X-Claude-Session-ID:" | cut -d: -f2 | tr -d ' \r')

# Second request - resume with context
curl -X POST http://127.0.0.1:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "X-Claude-Session-ID: $SESSION_ID" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"What is my name?"}]}'

# Claude remembers: "Your name is Alice"
```

### Benefits

- **Context Continuity**: Claude remembers previous interactions
- **Multi-Step Tasks**: Build on previous work without re-explaining
- **Natural Conversations**: Chat naturally across multiple requests

### Notes

- Session resumption adds ~1-1.5s latency per turn (SDK overhead)
- Sessions are stored in `~/.claude/projects/`
- If session ID is invalid/expired, proxy starts a new session gracefully

For detailed usage examples and troubleshooting, see [SESSION_RESUMPTION.md](./SESSION_RESUMPTION.md).

## FAQ

### Why do I need `ANTHROPIC_API_KEY=dummy`?

OpenCode requires an API key to be set, but we never actually use it. The Claude Agent SDK handles authentication through your Claude CLI login. Any non-empty string works.

### Does this work with other tools besides OpenCode?

Yes! Any tool that uses the Anthropic API format can use this proxy. Just point `ANTHROPIC_BASE_URL` to `http://127.0.0.1:3456`.

### What about rate limits?

Your Claude Max subscription has its own usage limits. This proxy doesn't add any additional limits.

### Is my data sent anywhere else?

No. The proxy runs locally on your machine. Your requests go directly to Claude through the official SDK.

## Troubleshooting

### "Claude Code process exited with code 1"

**Most common issue** - Authentication required.

**Quick fix:**
```bash
claude login
```

Then restart the proxy. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for detailed diagnostics.

### "Claude SDK Process Abort"

**Issue:** SDK exits with "Claude Code process aborted by user" but you didn't abort it.

**Most common cause:** Rate limiting or usage limits on your Claude Max subscription.

**Quick diagnosis:**
```bash
# Enable debug logging to see what's happening
export OPENCODE_CLAUDE_PROVIDER_DEBUG=1
bun run proxy
```

**Solutions:**
1. **Rate limiting** - Wait 5-10 minutes and try again
2. **Usage limits** - Check your Claude Max subscription at https://claude.ai/settings/subscription
3. **Network issues** - Verify connectivity: `curl https://api.anthropic.com`
4. **Resource constraints** - Monitor with Activity Monitor or htop

See [SDK_ABORT_TROUBLESHOOTING.md](./SDK_ABORT_TROUBLESHOOTING.md) for comprehensive diagnosis and solutions.

### "Claude says it edited files but I don't see changes"

**Issue:** Claude reports editing files, but changes don't appear.

**Cause:** Working directory is set incorrectly. The SDK can only access files within the configured working directory.

**Solution:**
```bash
# Set working directory to your projects folder
export CLAUDE_PROXY_CWD=/Users/awcjack/Documents
bun run proxy

# Verify startup shows correct directory:
# Working Directory: /Users/awcjack/Documents
```

**New: Enhanced Debugging**

The proxy now logs file operations automatically:
```bash
bun run proxy

# Look for these in console:
# [FILE OPERATION]: Writing to /Users/awcjack/Documents/test.txt
# [TOOL RESULT]: { is_error: false, content_preview: '...' }
```

These logs show **exactly where** files are being written and whether operations succeeded.

See:
- [FILE_OPERATION_DEBUGGING.md](./FILE_OPERATION_DEBUGGING.md) - Debug file operation issues
- [FILE_OPERATIONS_GUIDE.md](./FILE_OPERATIONS_GUIDE.md) - Working directory setup

### "Authentication failed"

Run `claude login` to authenticate with the Claude CLI:

```bash
claude login
```

Verify it works:
```bash
claude --version
echo "test" | claude
```

### "Connection refused"

Make sure the proxy is running:

```bash
bun run proxy
```

Check the port is not already in use:
```bash
lsof -i :3456
```

### Proxy keeps dying

Use the launchd service (see Auto-start section) which automatically restarts the proxy.

Or check logs for errors:
```bash
# Enable debug logging
export OPENCODE_CLAUDE_PROVIDER_DEBUG=1
bun run proxy
```

### "I need permission to read these files"

If Claude asks for permission but can't proceed:

**This is now fixed!** The proxy defaults to `bypassPermissions` mode. Restart the proxy:

```bash
bun run proxy

# Should show:
# Permission Mode: bypassPermissions
#   ⚠️  Auto-approving all file operations (no prompts)
```

To set a specific working directory:
```bash
export CLAUDE_PROXY_CWD=/Users/awcjack/Documents/my-project
bun run proxy
```

See [PERMISSIONS_GUIDE.md](./PERMISSIONS_GUIDE.md) for detailed configuration.

### Tasks Complete Too Early

If complex tasks finish prematurely without completing the work:

**This is now fixed!** The proxy no longer limits turns. To verify:
```bash
# Check startup message shows generous timeouts
bun run proxy

# Should display:
# Total timeout: 60 minutes
# Inactivity timeout: 15 minutes
```

For **very large context tasks** (full codebase analysis, extensive refactoring):
```bash
# Increase timeouts before starting
export CLAUDE_PROXY_TIMEOUT_MS=7200000      # 2 hours
export CLAUDE_PROXY_INACTIVITY_MS=1800000   # 30 minutes
bun run proxy
```

See [LARGE_CONTEXT_SUPPORT.md](./LARGE_CONTEXT_SUPPORT.md) for details.

### Streaming Issues

The proxy includes enhanced streaming with timeouts and error handling. See [STREAMING_IMPROVEMENTS.md](./STREAMING_IMPROVEMENTS.md) for details.

**If you experience connection resets:**
- Timeouts are set to 60 minutes (total) and 15 minutes (inactivity) by default
- Check stderr output in proxy console
- Verify network stability to api.anthropic.com

For comprehensive troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## License

MIT

## Credits

Built with the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) by Anthropic.
