# Mother

A Discord bot assistant that runs on a Raspberry Pi 5. Uses Claude Haiku 4.5 as its primary brain via Anthropic OAuth, with Claude Code escalation for complex tasks.

Forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Mother lives in [`packages/mother/`](packages/mother/) and depends on the `pi-ai`, `pi-agent-core`, and `pi-coding-agent` packages from the monorepo.

## Raspberry Pi 5 Setup (Ubuntu Server)

Complete guide for a fresh install from scratch.

### Prerequisites

- Raspberry Pi 5 (4GB+ RAM)
- SD card (32GB+)
- Anthropic Max subscription (for Claude OAuth)
- Discord bot token and guild ID

### 1. Flash Ubuntu Server

- Download **Ubuntu Server 24.04 LTS (ARM64)** from [ubuntu.com](https://ubuntu.com/download/raspberry-pi)
- Flash to SD card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/)
- In imager settings: set hostname, enable SSH, set username/password, configure WiFi if needed

### 2. SSH in and update

```bash
ssh youruser@pi-hostname
sudo apt update && sudo apt upgrade -y
```

### 3. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
node -v  # should be 22.x
```

### 4. Install build tools

```bash
sudo apt install -y git build-essential
```

### 5. Set up SSH key for GitHub (if needed)

```bash
ssh-keygen -t ed25519 -C "your-github-noreply@users.noreply.github.com"
cat ~/.ssh/id_ed25519.pub
# Add this key at https://github.com/settings/keys
```

### 6. Clone and build

```bash
git clone git@github.com:EdibleTuber/Mother.git ~/pi-mono
cd ~/pi-mono
npm ci
npm run build
```

### 7. Link the CLIs

```bash
cd ~/pi-mono/packages/coding-agent && npm link
cd ~/pi-mono/packages/mother && npm link
```

This makes `pi` and `mother` available as commands.

### 8. Install Claude Code CLI

The `claude` tool (used for escalation to Sonnet/Opus) requires the Claude Code CLI:

```bash
npm install -g @anthropic-ai/claude-code
```

### 9. Authenticate with Anthropic

```bash
pi /login anthropic
```

This will:
1. Print a URL -- open it in a browser on **any machine** (your laptop is fine)
2. Log in to claude.ai and authorize
3. You get a code (format: `code#state`) -- paste it back into the terminal

Tokens are stored in `~/.pi/agent/auth.json`. Both Mother (Haiku) and the Claude Code escalation tool share these credentials. Tokens auto-refresh.

### 10. Set up Discord secrets

Store tokens in a root-owned env file (not `.bashrc`):

```bash
sudo tee /etc/mother.env << 'EOF'
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_guild_id
EOF

sudo chmod 600 /etc/mother.env
sudo chown root:root /etc/mother.env
```

systemd reads this before dropping to the `mother` user, so the process gets the vars but the user can't read the file directly.

### 11. Start Mother

```bash
mkdir -p ~/mother-workspace
node ~/pi-mono/packages/mother/dist/main.js ~/mother-workspace --sandbox=host
```

She bootstraps the workspace structure on first run. Use `--cli` for local testing without Discord:

```bash
node ~/pi-mono/packages/mother/dist/main.js ~/mother-workspace --sandbox=host --cli
```

### 12. Auto-start Mother on boot

Create `/etc/systemd/system/mother.service`:

```ini
[Unit]
Description=Mother Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
User=youruser
EnvironmentFile=/etc/mother.env
ExecStart=/usr/bin/node /home/youruser/pi-mono/packages/mother/dist/main.js /home/youruser/mother-workspace --sandbox=host
Restart=always
RestartSec=10
WorkingDirectory=/home/youruser/pi-mono/packages/mother

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable mother
sudo systemctl start mother
sudo journalctl -u mother -f  # watch logs
```

### 13. (Optional) Kiosk display for built-in screen

If your Pi has a screen and you want it to auto-display a dashboard Mother builds:

```bash
sudo apt install -y cage chromium-browser
```

Create `/etc/systemd/system/kiosk.service`:

```ini
[Unit]
Description=Kiosk Browser
After=network.target

[Service]
User=youruser
Environment=WLR_LIBINPUT_NO_DEVICES=1
ExecStart=/usr/bin/cage -- /usr/bin/chromium-browser --kiosk --noerrdialogs --disable-infobars http://localhost:3000
Restart=always

[Install]
WantedBy=graphical.target
```

```bash
sudo systemctl enable kiosk
sudo systemctl start kiosk
```

When Mother serves a dashboard on port 3000, it shows up on the screen automatically.

## Updating

```bash
cd ~/pi-mono
git pull
npm ci
npm run build
cd packages/mother && npm run build  # mother is not in the root build chain
sudo systemctl restart mother        # if using systemd
```

## Architecture

Mother is a competent agent that handles most tasks directly (file edits, bash commands, code writing). For complex multi-file work, she escalates to Claude Code (Sonnet/Opus) via the `claude` tool.

```
Discord <-> Mother (Haiku 4.5 on Pi) --escalation--> Claude Code (Sonnet/Opus)
                |
                v
        Workspace filesystem
        (memory, logs, skills, events)
```

### Future: Worker Architecture

Mother will orchestrate Docker containers on a GPU-equipped inference server for heavy workloads:

```
Mother (Pi 5, orchestrator)
  |
  v  REST API
Inference Server (GPU, Docker)
  |-- RE worker (jadx, ghidra, radare2)
  |-- Asset worker (Blender headless, Godot)
  |-- Workers get Ollama access for tasks needing local LLM reasoning
```

The API enforces guardrails: container caps, allowed images only, resource limits, and auto-kill timeouts.

See [`packages/mother/DESIGN.md`](packages/mother/DESIGN.md) for full architecture documentation.

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages (does not include mother)
npm run check        # Lint, format, and type check (biome + tsgo)
cd packages/mother && npm run build  # Build mother separately
```

Mother dev mode (file watching):

```bash
cd packages/mother
./dev.sh ./data --cli
```

## License

MIT
