# A08 — UI redesign: "Bold Midnight" theme + smoother components

**Version:** Android `0.3.9 → 0.4.1-alpha.1` (versionCode 12→14). First real visual identity for the app (was stock Material3 baseline — generic gray, flat hierarchy).

## v0.4.0 — theme (verified on device, looks great)

`Theme.kt` — a single dark **"Bold Midnight"** Material3 scheme: deep indigo surfaces (`#12102E`) + vivid violet accent (`#8B5CF6`), high contrast, lavender text. Crucially sets the full `surfaceContainer*` ramp so Cards render indigo (not the default gray). Custom shapes (rounder), default type scale. `NightOwlTheme` replaces the bare `MaterialTheme`, so **every** card/button/text recolors at once.

- **Header** "🦉 NightOwl" + a **gradient hero status banner**: large ARMED/PAUSED/NOT-ARMED badge (green/amber/red), headline state ("Curfew armed" / "Locked down"), the nightly window, a **live countdown** ("Curfew in 8h 2m", recomputed every 30s in device-local time), and "Locked in until <date> · held by <locker>". Replaces the old plain text Status card.

## v0.4.1 — smoother components

- `UiComponents.kt`: reusable `SectionHeader(icon, title)` + `StatusPill(text, color)`.
- **Consistent iconed headers** on every card: 🔐 Permissions · 👥 Friend Lock · 🌙 Schedule · 🎯 Focus Mode · 🚪 Uninstall · 📋 Allowlist · 🛡️ Enforcement.
- **Permissions** card: plain "Device admin: ✓" text rows → clean `label + ✓ Granted pill` (green) or a compact **Grant** button. 
- **Enforcement** card: the ● ARMED indicator is now a colored `StatusPill` (green armed / red not), right-aligned next to the header.
- **Friend Lock**: the dead/disabled "Generate pair code" button is now **hidden once paired** (was greyed clutter).
- **Schedule**: the misleading "Timezone: UTC" line now reads "Curfew uses this phone's local time · <zone>" (matches the A07 device-local enforcement).

## Status / verification

- **v0.4.0 theme:** installed + screenshotted on the Mi 9 Lite — confirmed (indigo/violet, gradient hero, live countdown all render correctly).
- **v0.4.1 polish:** compiles clean; **screenshot verification pending** (phone dropped off USB before install). Low risk — standard Compose patterns on the already-verified theme; will confirm on next connect.
- All changes are Compose-only; no enforcement/logic touched.
