# HeroUI Pro verification

Verified 2026-09-20 using the user-designated CollectUI proxy.

- Documentation: https://docs.collectui.pro/hpsetup/usage and https://docs.collectui.pro/ai-tools/mcp
- npm releases verified: hpsetup 4.7.1, hpmcp 0.0.18.
- Ran hpsetup react --auto --dry-run in a private isolated React project before installation. It reported the React Pro target; the initial empty-project dry run also printed a package-detection warning without changing the project. Actual install succeeded.
- HP Key successfully downloaded React Pro 1.0.0-beta.10; HeroUI React/Styles 3.2.6, React Aria Components 1.21.1, React 19.0.1.
- Personal Token authenticated through hpmcp react with a fresh private cache. Successfully fetched the component inventory and Sheet, Stepper, NumberStepper, Calendar and Modal docs. MCP reported 65 Pro and 71 OSS components.
- Missing @react-aria/ssr dependency surfaced in the actual Vite build; adding exact version 3.10.1 resolved it.
- Subpath imports for Pro Sheet, Stepper, NumberStepper plus OSS Calendar/Button passed Vite production build and TypeScript checking.
- Browser verified incrementing guests to 2, selecting September 24, and opening the add-on Sheet.
- Credential file is outside the repo, mode 0600. Existing .mcp.json literal tokens were replaced by scripts/heroui-mcp.mjs, which reads HEROUI_PERSONAL_TOKEN or the private configuration file. No key/token found in current tracked files or verification browser assets. Existing Git history was not rewritten.

Private verification directory: ~/.config/geniefront/heroui/verification. This is a dependency smoke test, not the selected booking UI. Production booking code/dependencies have not been changed by this verification. Integration must reconcile current React Aria 1.20.0 with Pro's >=1.21.1 requirement and avoid bulk installation into every Web workspace. hpsetup installs optional peers automatically; actual booking integration should retain only needed dependencies and component styles.
