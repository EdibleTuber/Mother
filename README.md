# Mother

A Discord bot assistant powered by a local LLM via Ollama. Lightweight enough to run on a Raspberry Pi, but works on any Linux machine.

Forked from [badlogic/pi-mono](https://github.com/badlogic/pi-mono). Mother lives in [`packages/mother/`](packages/mother/) and depends on the `pi-ai`, `pi-agent-core`, and `pi-coding-agent` packages from the monorepo.

## Setup (Ubuntu Server)

Complete guide for a fresh install from scratch. Works on any Linux machine -- a Raspberry Pi, a VM, a spare laptop, etc.

### Prerequisites

- A Linux machine (ARM64 or x86_64)
- Ollama running locally or on a reachable server
- Discord bot token and guild ID

### 1. Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
node -v  # should be 22.x
```

### 2. Install build tools

```bash
sudo apt install -y git build-essential
```

### 3. Set up SSH key for GitHub (if needed)

```bash
ssh-keygen -t ed25519 -C "your-github-noreply@users.noreply.github.com"
cat ~/.ssh/id_ed25519.pub
# Add this key at https://github.com/settings/keys
```

### 4. Clone and build

```bash
git clone git@github.com:EdibleTuber/Mother.git ~/pi-mono
cd ~/pi-mono
npm ci
npm run build
```

### 5. Link the CLIs

```bash
cd ~/pi-mono/packages/coding-agent && npm link
cd ~/pi-mono/packages/mother && npm link
```

This makes `pi` and `mother` available as commands.

### 6. Authenticate with Anthropic (optional, for paid API models)

```bash
pi /login anthropic
```

This will:
1. Print a URL -- open it in a browser on **any machine** (your laptop is fine)
2. Log in to claude.ai and authorize
3. You get a code (format: `code#state`) -- paste it back into the terminal

Tokens are stored in `~/.pi/agent/auth.json`. Tokens auto-refresh. This step is only needed if you configure Mother to use an Anthropic model instead of Ollama.

### 7. Set up Discord secrets

Store tokens in a root-owned env file (not `.bashrc`):

```bash
sudo tee /etc/mother.env << 'EOF'
DISCORD_BOT_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_guild_id
MOTHER_ALLOWED_USERS=comma,separated,discord,user,ids
EOF

sudo chmod 600 /etc/mother.env
sudo chown root:root /etc/mother.env
```

`MOTHER_ALLOWED_USERS` is a comma-separated list of Discord user IDs that Mother will respond to. If unset, she responds to everyone in the guild. To find your Discord user ID, enable Developer Mode in Discord settings and right-click your username.

systemd reads this before dropping to the `mother` user, so the process gets the vars but the user can't read the file directly.

### 8. Start Mother

```bash
mkdir -p ~/mother-workspace
node ~/pi-mono/packages/mother/dist/main.js ~/mother-workspace --sandbox=host
```

She bootstraps the workspace structure on first run. Use `--cli` for local testing without Discord:

```bash
node ~/pi-mono/packages/mother/dist/main.js ~/mother-workspace --sandbox=host --cli
```

### 9. Auto-start Mother on boot

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

### 10. (Optional) Kiosk display

If your machine has a screen and you want it to auto-display a dashboard Mother builds:

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

## Security

Mother uses structural enforcement at the tool level to guard against prompt injection and misuse. These guards run before execution and cannot be bypassed by the LLM. Active in host mode only (docker sandbox already isolates).

- **Discord user allowlist** -- `MOTHER_ALLOWED_USERS` restricts which Discord users Mother responds to.
- **Command whitelist** -- The first binary in each command segment (split by `&&`, `||`, `;`, `|`) must be on a whitelist. Unknown commands are denied. Shell builtins (`cd`, `echo`, `pwd`, etc.) are implicitly allowed, except `eval` and `exec`. A small critical-pattern blocklist supplements the whitelist (`rm -rf /`, fork bombs).
- **Path scoping** -- File tools (read, write, edit, attach) only allow access to the workspace directory, `/tmp`, and any extra paths from `MOTHER_ALLOWED_PATHS`.

### Configuration

| Env var | Description |
|---------|-------------|
| `MOTHER_ALLOWED_USERS` | Comma-separated Discord user IDs |
| `MOTHER_ALLOWED_PATHS` | Colon-separated extra paths for file tools (e.g. `/opt/data:/mnt/shared`) |
| `MOTHER_ALLOWED_COMMANDS` | `+/-` prefixed, comma-separated command modifications (e.g. `+rustup,-ssh,-scp`) |

`MOTHER_ALLOWED_COMMANDS` uses `+`/`-` prefix syntax to add/remove from the default whitelist. No prefix is treated as `+`. Example for a restrictive deployment:

```
MOTHER_ALLOWED_COMMANDS=-ssh,-scp,-rsync,-python,-python3,-node,-npm,-npx,-kill,-pkill
```

**Security note:** Language runtimes (node, python, etc.) can spawn arbitrary subprocesses, effectively bypassing the whitelist. The permissive default trusts that the LLM won't actively subvert the guard -- this is defense-in-depth for prompt injection, not a security boundary. For multi-user deployments, remove runtimes from the whitelist.

## Architecture

Mother is a competent agent that handles tasks directly using her tools (bash, read, write, edit, attach). She calls a local LLM via Ollama, either on the same machine or a remote inference server.

```
Discord <-> Host (Mother) <-> Ollama (local or remote)
                |
                v
        Workspace filesystem
        (memory, logs, skills, events)
```

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
