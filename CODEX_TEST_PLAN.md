# Capri × Codex: validation checklist

## CI
- Node 20 / 24, Windows and Ubuntu: `npm test`
- Windows packaging: `npm ci`, `npm run dist -- --publish never`
- Expected installer: workflow artifact `Capri-Windows-Installer`

## Manual Windows checks (required before claiming release-ready)
1. Launch Capri, verify original desktop animations, tray menu and Claude demo.
2. Select **Install Codex hooks**; inspect `%USERPROFILE%\.codex\hooks.json`.
3. Start a fresh local Codex CLI session and review / trust hooks via `/hooks`.
4. Run a simple prompt, a file read, `apply_patch` touching two files, a successful and a failed command.
5. Trigger an interactive approval request; verify the alert remains until the matching action finishes.
6. Interrupt a task: it must **not** trigger a completion animation.
7. Run two sessions and ensure provider labels and turn order stay separate.
8. Quit Capri and use Codex normally. Nothing should break.
9. Use **Remove Codex hooks**; inspect that unrelated hooks were preserved.
10. Verify that cloud Codex tasks don't claim unsupported automatic tracking.

## Notes
- Do not submit passwords, tokens, API keys, private patches or customer data to test hooks.
- Review Windows SmartScreen and unsigned application warnings; don't bypass safeguards blindly.
- Original character graphics are not covered by MIT source license.
