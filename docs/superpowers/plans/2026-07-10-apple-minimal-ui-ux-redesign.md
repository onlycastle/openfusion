# OpenFusion Apple-style minimal UI/UX redesign plan

**Date:** 2026-07-10  
**Status:** proposed  
**Scope:** macOS desktop shell (`apps/desktop`)  
**Intent:** simplify the product, not merely reskin it

## 1. Outcome

OpenFusion should feel like a focused Mac utility: one calm navigation layer,
one clear task at a time, system-familiar controls, and detail that appears only
when it helps a decision. The redesign keeps the product's honesty around
quality, cost, and review, but removes the current "engineering cockpit" feel.

This plan is based on a source and state audit of every React surface, the Tauri
window configuration, the current CSS system, and the desktop test suite. The
real Tauri app launched successfully during the audit. A live screenshot review
could not be completed because macOS Screen Recording permission was not
available, so visual judgments below are grounded in the rendered structure and
CSS rather than a claimed pixel-level inspection.

Apple's current macOS guidance reinforces the direction: use large displays to
reduce nesting and unnecessary modality, keep sidebars shallow and hideable,
put app-wide settings in a dedicated Settings window, use alerts sparingly, and
keep feedback close to the item it describes.

References:

- [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)
- [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
- [Settings](https://developer.apple.com/design/human-interface-guidelines/settings)
- [Alerts](https://developer.apple.com/design/human-interface-guidelines/alerts)
- [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)
- [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)

## 2. Current-state audit

### What is already good

- System font stack, local-only assets, light/dark color schemes, semantic
  success/warning/failure colors, reduced-motion handling, and visible keyboard
  focus are already present.
- The Tauri window uses an overlay title bar and macOS sidebar vibrancy.
- Async operations distinguish running, cancelling, cancelled, done, and error.
- Cost, quality, and pricing uncertainty are not hidden. The eval fail treatment
  deliberately prevents a savings number from reading as a win.
- Engine errors are generally rendered as user-facing text instead of stack
  traces, and secrets are not rendered or logged.
- The frontend is healthy before redesign work: TypeScript passes and all 173
  desktop tests pass.

These are foundations to preserve.

### Main UX problems

1. **The shell spends too much space on navigation.** The default 1024 px window
   reserves 388 px for two always-visible rails before content. The information
   hierarchy is only two levels deep, so the second permanent rail costs more
   attention and space than it saves.
2. **Navigation terminology conflicts.** Rail 2 says `Chat`, while the screen
   says `Studio`; `Harness setting` is awkward and singular; `Evals` is internal
   shorthand. The user has to learn implementation vocabulary before the
   product model.
3. **Developer telemetry is always visible.** The 26 px footer exposes engine
   event counts and the last RPC method. This is diagnostic information, not a
   primary product status.
4. **The visual hierarchy is flat.** Paths, setup checks, build state, action
   buttons, stage logs, diffs, review attempts, and cost ledgers often have
   similar weight. Minimal color does not by itself create simplicity.
5. **Raw implementation detail leaks into the experience.** Absolute paths,
   engine stage names, model identifiers, JSON-RPC error codes, and long
   instrument copy appear in primary reading paths.
6. **Settings is an oversized modal form.** One scrolling dialog contains
   connections, provider inventory, and provider creation. It has no pane
   navigation, no dirty-form guard, and no task-focused add-provider flow.
7. **Important mutations have no safety layer.** Project removal, provider
   removal, orchestrator sign-out, Project Card approval, harness rebuild, and
   applying a diff either happen immediately or have no impact preview.
8. **Feedback is inconsistent.** Some mutations show a status, some silently
   reload, some optimistically revert, and some swallow errors. Success feedback
   is often absent; field-level validation is rare.
9. **Loading states replace content with text.** `Loading harness…`,
   `Checking…`, and `working…` do not preserve layout or show where the result
   will appear.
10. **The browser development surface is not a reliable visual QA surface.**
    Running Vite directly crashes at the Tauri `Channel` subscription, so
    designers cannot inspect fixture states in a browser without the native
    host. This makes exhaustive dialog and state review unnecessarily hard.

### Dialog and interruption audit

The current app has one custom modal (`SettingsDialog`) and one native folder
picker. Several actions that deserve either an undo path, an alert, or a review
sheet have none.

- Settings focuses the dialog container, but it does not trap focus, make the
  background inert, restore focus to the opener, lock background scroll, or
  guard unsaved provider fields.
- Backdrop click and Escape always close Settings, even with an API key or form
  edits in progress.
- Dialog tests cover only open/closed rendering. They do not cover keyboard
  order, Escape, focus restoration, click-outside behavior, dirty state, or
  default/destructive buttons.
- Project and provider removal are immediate. Project removal is metadata-only
  and should be undoable; provider removal deletes credential state and needs an
  impact-aware confirmation.
- `Apply diff` changes the working tree immediately. Its explanatory sentence
  is not a substitute for a review step.
- Rebuilding a harness can replace generated project artifacts. It needs a
  preflight when an existing harness or approved Project Card is present.
- Project Card approval changes what the model is allowed to trust, but approval
  has no focused review/confirmation step.
- Quitting or switching projects during a live run or dirty Project Card has no
  explicit UX contract.

## 3. Product principles

1. **Content before chrome.** Navigation and diagnostics recede; the current
   project and current task dominate.
2. **One obvious primary action.** Each state has one visually primary next
   step. Secondary and destructive actions use menus or quieter buttons.
3. **Progressive disclosure.** Show the verdict, outcome, and next action first;
   keep paths, logs, pricing detail, and engine stages behind disclosure rows or
   an inspector.
4. **System-familiar behavior.** Use a hideable source-list sidebar, a real
   Settings window, native folder selection, standard keyboard shortcuts, and
   familiar alert/sheet ordering.
5. **Calm by default, loud when necessary.** Reserve strong color for focus,
   destructive actions, blocking warnings, and quality hazards.
6. **Never hide consequences.** Cost, working-tree mutations, credential
   deletion, and model trust changes remain explicit.
7. **Feedback stays in context.** Row edits acknowledge success or failure in
   the row; form errors appear beside the field; global alerts are a last resort.
8. **Every state is designed.** Idle, loading, empty, ready, dirty, submitting,
   success, warning, error, stale, cancelled, and offline states are first-class.

## 4. Target information architecture

### Main window

Replace the two permanent rails and telemetry footer with:

```text
┌──────────────────────────────────────────────────────────────────┐
│ [sidebar]  openfusion ▾     Project ready          Context action│
├───────────────┬──────────────────────────────────────────────────┤
│ Studio        │                                                  │
│ Harness       │                 active content                   │
│ Evaluations   │                                                  │
│               │                                                  │
│ Recent runs   │                                                  │
└───────────────┴──────────────────────────────────────────────────┘
```

- A single 216–232 px hideable sidebar contains the three project sections.
- The toolbar contains the current-project switcher. Its menu lists recent
  projects, `Open Project…`, and `Remove from OpenFusion`.
- `Recent runs` is a compact disclosure or inspector entry, not a second
  navigation rail. It can consume the already-shipped run ledger later.
- Settings moves to the app menu and `Command–,`; a quiet Settings entry may
  remain in the project switcher during transition, but not as a critical
  bottom-of-sidebar action.
- The current absolute path is available from the project switcher tooltip or a
  `Project Info` popover, not repeated in primary content.
- The developer event footer is removed. Diagnostics move to a hidden
  `Help > Diagnostics` window or a development-only overlay.

At narrow widths, collapse the sidebar automatically and keep the toolbar
project switcher. Do not convert both rails into stacked horizontal strips.

### Naming

- `Chat` / `Studio` -> **Studio** everywhere.
- `Harness setting` -> **Harness**.
- `Evals` -> **Evaluations** in UI; keep `evals` in code/RPC names.
- `Open task chat` -> **Start a task**.
- `Recheck project` -> **Refresh status**.
- `Apply diff` -> **Apply Changes**.
- User-facing errors omit JSON-RPC codes. A disclosure labeled `Technical
  details` may contain the code when it helps support.

## 5. Surface redesign

### Studio

Studio is a four-state flow, not one long screen:

1. **No project:** centered empty state with one sentence, `Open Project…`, and
   up to three recent projects.
2. **Project setup:** a compact readiness checklist for Orchestrator, Model
   provider, Wiki, and Harness. Each incomplete row has one direct action.
   Completed rows collapse into a single `Ready` summary.
3. **Ready, no run:** a large task composer and three example task chips. The
   routing explanation is a short info popover, not permanent microcopy.
4. **Run/result:** keep the composer docked. Render a calm activity timeline,
   then a result summary with `Summary`, `Changes`, `Review`, and `Cost`
   segments. Open on Summary; do not make users scroll through every engine
   stage to reach the outcome.

Use a spinner beside the active stage and a determinate bar when the engine can
expose stage counts. Keep Cancel visible in the same location throughout the
run. A normal cancel is immediate because it does not mutate the project; only
warn if a future operation would discard partial user-authored work.

### Harness

- Lead with Project Card status and team health, not a tree diagram.
- Project Card uses a readable editor with a sticky `Save Draft` / `Approve`
  action area. `Full card` opens in a side inspector or disclosure, not a raw
  `<pre>` block in the main column.
- Agent routing is a compact list: agent name, concise responsibility, model
  pop-up, and an optional disclosure for task classes.
- Model and escalation changes auto-save. Show `Saving…`, `Saved`, or a row-
  level retry message; revert failed optimistic edits visibly.
- Missing/stale/invalid harness states reuse the Studio readiness component and
  the same language.

### Evaluations

- Replace the documentation-style form with a task builder: commit list, test
  command, validation summary, and a primary button that includes the count,
  such as `Run 6 Evaluations`.
- Validate commit lines and the command before enabling Run. Errors appear below
  the affected field.
- The result begins with verdict, savings, quality delta, task count, and one
  next action. Detailed per-task rows and clean-subset methodology live under
  disclosures.
- Keep the quality-hazard fail state visually strongest. Never encode verdict by
  color alone.
- Add the run-ledger history strip after the primary report, as already planned
  in the run-ledger design.

### Settings

Build a dedicated macOS Settings window instead of a blocking modal.

- Open from the app menu and `Command–,`.
- Use a stable toolbar with two panes: **Connections** and **Providers**.
- Restore the most recently viewed pane.
- Settings changes that are naturally reversible save immediately; no global
  Save button.
- Connections shows Claude Code as one concise row with state, detail, and one
  action.
- Providers shows configured providers in a list. `+` opens an Add Provider
  sheet; row actions live in a trailing `…` menu.
- The Add Provider sheet contains Provider, Model, API key, Keychain toggle,
  and an `Advanced` disclosure for base URL. It owns its validation and success
  state and never pre-fills a key.

If a second Tauri window is too risky for the first delivery, implement the
same pane architecture in the current modal as a short-lived compatibility
step, but do not keep the single scrolling form.

## 6. Dialog, alert, sheet, popover, and toast specification

Use five interruption levels consistently:

- **Inline notice:** recoverable local errors, missing setup, save/retry states.
- **Toast:** brief confirmation or undo for a completed, noncritical action.
- **Popover/menu:** choices related to one control; no destructive confirmation.
- **Sheet:** a focused task or a rich review tied to the current window.
- **Native alert:** short, critical, two-button confirmation for an uncommon
  irreversible action.

Do not use a modal merely to report success or a normal error.

| Trigger | Presentation | Required content and behavior |
|---|---|---|
| Open project | Native folder picker | Directory-only; preserve last location when possible. Invalid repo returns to the empty/setup state with `Choose Another Folder`, not a second alert. |
| Remove project | No dialog when undo exists | Remove registry metadata only, then show `Removed <name>` + `Undo` for 8 seconds. Never touch the repository. Without undo, use a native Cancel/Remove alert. |
| Open Settings | Separate nonmodal window | `Command–,`, single instance, restore last pane and focus. Main window remains usable. |
| Add provider | Sheet in Settings | Focus Provider first. Cancel leading, `Add Provider` trailing. Return submits only when valid. Escape cancels; if dirty, use the discard alert below. |
| Close dirty Add Provider sheet | Native alert | Title: `Discard this provider?` Text: `The API key and other unsaved details will be cleared.` Buttons: `Keep Editing`, `Discard`. No default destructive button. |
| Remove provider | Native alert | Title: `Remove <provider>?` Explain that the saved key is deleted and routed agents may stop working. Buttons: `Cancel`, `Remove`. If dependency data is available, list affected project/agent count before enabling Remove. |
| Connect orchestrator | Inline progress, external official CLI/browser | Change button to spinner + `Connecting…`; keep window responsive. On return, re-probe. Not-installed and failed states stay in the row with `Try Again` or install guidance. Never ask for a subscription token. |
| Sign out orchestrator | Native alert | Title: `Sign out of Claude Code?` Explain that generation and review will be unavailable until reconnect. Buttons: `Cancel`, `Sign Out`. |
| Approve Project Card | Review sheet | Show the exact digest being trusted, its project, and the consequence. Buttons: `Cancel`, `Approve Card`. On success close sheet and show inline Approved state. |
| Navigate/switch with dirty Project Card | Three-choice sheet | `Save Draft`, `Discard Changes`, `Cancel`. Preserve destination and continue only after the selected resolution succeeds. |
| Build first harness | Inline preflight | Explicitly state that model usage may be incurred; the primary button itself is the commitment. No redundant alert. |
| Rebuild existing harness | Review sheet | Explain which generated artifacts may change and whether an approved card will return to draft. Buttons: `Cancel`, `Rebuild Harness`. |
| Rebuild wiki | No dialog | Local, replaceable operation. Show progress in place and a completion toast only if it lasts long enough to move out of view. |
| Run evaluations | Inline preflight by default | Button includes task count. Add a sheet only when a defined high-cost/high-count threshold is crossed; show project, count, command, and known estimate. Do not confirm every normal run. |
| Cancel task/evaluation | Immediate | Keep button location stable and change to `Cancelling…`. Use a confirmation only if a future cancellation discards user-authored work. |
| Apply generated changes | Review sheet | Show target project, file/change summary, dirty-working-tree warning, and `does not commit`. Buttons: `Cancel`, `Apply Changes`. Successful apply closes the sheet and shows `Applied to working tree` + `View Changes`. Conflicts stay in the sheet with `Copy Details` and `Close`. |
| Quit with active run | Native alert | `A task is still running.` Buttons: `Cancel`, `Stop and Quit`. Do not silently orphan or cancel work. |
| Crash boundary | Full-window recovery state | Friendly title, brief message, `Reload Interface`, and a collapsed `Technical details`. Never expose secrets, task text, or model output in diagnostics. |

### Shared modal behavior

Every sheet/alert implementation must satisfy all of these:

- One modal layer at a time; no nested backdrops.
- `aria-labelledby` and `aria-describedby` point to visible copy.
- Focus enters the first meaningful control, stays inside, and returns to the
  opener on close.
- Background content is inert and cannot scroll.
- Escape and `Command–.` perform the safe cancel action.
- Return activates the primary action only when it is enabled and safe.
- Backdrop click never dismisses a dirty or destructive flow.
- Cancel is leading and the primary action trailing. Destructive actions are
  visibly destructive but are not the automatic default.
- Buttons keep a stable width while changing to submitting labels.
- Async failure keeps the dialog open, preserves non-secret input, and focuses
  the relevant inline error.
- At 860×600 and 200% zoom, content remains reachable without trapping the
  footer actions offscreen.

## 7. Visual system

### Tokens

- Respect the user's macOS accent color where WebKit/Tauri allows it; use
  system blue only as a fallback. Remove fixed indigo as the universal accent.
- Keep system typography. Use a small, deliberate scale: 11 caption, 13 body,
  15 emphasized body, 20 section title, 28 empty-state/hero.
- Use tabular monospace only for measured values, paths, diffs, and model IDs.
  Do not render ordinary text fields in monospace globally.
- Use an 8 px spacing grid with 4 px only for icon/text micro-spacing.
- Standard radii: 8 px controls/rows, 12 px panels, 16 px sheets/composer.
- Use three surface levels only: window, sidebar/material, floating
  sheet/popover. Avoid turning every section into a bordered card.
- Use 16 px local SVG symbols with consistent stroke weight. Replace text `×`,
  `+`, and emoji warning marks with labeled icon controls.

### Motion

- 120–180 ms opacity/position transitions for popovers, sidebar collapse, and
  state changes.
- No decorative animation. Progress motion exists only to prove work is
  continuing.
- `prefers-reduced-motion` disables movement while preserving state changes.

## 8. Component and state architecture

Create a small UI foundation before rebuilding screens:

```text
apps/desktop/src/ui/
  Button.tsx             primary / secondary / quiet / destructive
  IconButton.tsx
  FormField.tsx          label, help, error, described-by wiring
  Select.tsx
  Notice.tsx             info / warning / error / success
  Spinner.tsx
  EmptyState.tsx
  Badge.tsx
  Disclosure.tsx
  SegmentedControl.tsx
  Toolbar.tsx
  Sidebar.tsx
  Sheet.tsx
  AlertDialog.tsx
  ToastProvider.tsx
  modalFocus.ts
  tokens.css
```

Also add:

- A central `friendlyError` mapper that converts engine codes/stages into
  actionable copy and keeps technical detail separate.
- A reusable `AsyncState` convention so controls consistently expose idle,
  submitting, success, and failure.
- A project navigation guard for dirty forms and active runs.
- A diagnostics surface for event counts and RPC metadata in development only.
- A development-only UI state gallery with mocked Tauri/engine responses. It
  must render every major surface and dialog through plain Vite so screenshot
  tests do not require a live sidecar or credentials.

Avoid adopting a large component library. The current app needs a coherent
dozen primitives, not a second design language.

## 9. Implementation sequence

### Phase 0 — Baseline and safety contracts

- [ ] Add a UI state inventory test fixture for every existing screen state.
- [ ] Add dialog interaction tests for focus, Escape, return, click-outside,
      dirty close, and focus restoration.
- [ ] Add screenshot baselines at 1024×720, 860×600, and 1440×900 in light and
      dark appearances.
- [ ] Document current strings and actions so terminology changes are deliberate.

**Exit:** current UI can be rendered and compared without the native host.

### Phase 1 — Design-system primitives

- [ ] Extract tokens from `styles.css` into `tokens.css`; remove undefined
      fallback variables such as `--hairline`, `--chip-bg`, and `--muted`.
- [ ] Build Button, FormField, Notice, Spinner, Badge, EmptyState, Sheet,
      AlertDialog, and Toast primitives.
- [ ] Build modal focus/keyboard behavior once and test it exhaustively.
- [ ] Centralize friendly errors and async action feedback.

**Exit:** no screen-specific modal or button behavior is needed later.

### Phase 2 — Shell and navigation

- [ ] Replace AppRail + ProjectRail with one hideable Sidebar and toolbar
      project switcher.
- [ ] Remove the telemetry status bar from production UI.
- [ ] Add `Command–,`, sidebar toggle, and standard menu commands in Tauri.
- [ ] Implement narrow-window sidebar collapse.
- [ ] Rename sections to Studio, Harness, and Evaluations.

**Exit:** at 1024 px, at least 760 px can be devoted to content when the
sidebar is visible, and the full width is available when hidden.

### Phase 3 — Studio flow

- [ ] Build shared project empty/readiness components.
- [ ] Separate setup, composer, running, and result states.
- [ ] Replace the raw stage transcript with an activity timeline and result
      segments; retain full details behind disclosure.
- [ ] Add Apply Changes review sheet and active-run quit guard.
- [ ] Integrate recent outcomes from `engine.runs.list`.

**Exit:** a first-time user can open a repo, finish setup, run a task, inspect
the outcome, and apply changes without seeing raw engine vocabulary by default.

### Phase 4 — Harness and Evaluations

- [ ] Redesign Project Card editor and implement dirty-navigation guard.
- [ ] Add Approve Card and Rebuild Harness sheets.
- [ ] Convert routing edits to row-level auto-save feedback.
- [ ] Rebuild Evaluation task entry, validation, results hierarchy, and history.
- [ ] Keep ETH-hazard semantics and clean-subset truth intact.

**Exit:** complex evidence is progressively disclosed, while every trust/cost
decision remains explicit.

### Phase 5 — Settings and credential flows

- [ ] Add a dedicated single-instance Settings window with `Command–,`.
- [ ] Build Connections and Providers panes and remember the last pane.
- [ ] Move provider creation into its sheet with dirty-discard protection.
- [ ] Add Remove Provider and Sign Out alerts with dependency-aware copy.
- [ ] Verify keys never appear in DOM snapshots, logs, screenshots, or errors.

**Exit:** the main window never becomes a long credentials form and settings
behave like a Mac app.

### Phase 6 — Polish and release gate

- [ ] Keyboard-only pass, including Full Keyboard Access.
- [ ] VoiceOver pass for sidebar, sheets, progress, result segments, and tables.
- [ ] Contrast audit in light/dark, increased contrast, and inactive-window states.
- [ ] Reduced-motion pass and 200% zoom pass.
- [ ] Tauri smoke: native folder picker, Settings window lifecycle, external CLI
      connect, alerts, quit guard, and working-tree apply.
- [ ] Visual regression review at all baseline sizes.

**Exit:** no P0/P1 accessibility or destructive-action issue remains.

## 10. Acceptance criteria

- A new user can explain the app's three areas after one minute: do work,
  configure the harness, evaluate quality.
- There is one persistent sidebar, and it can be hidden.
- Production UI contains no engine event count, RPC method name, or raw error
  code in the primary message.
- Every destructive or trust-changing action has either undo, an impact-aware
  confirmation, or a review sheet as specified above.
- Every modal passes focus entry, trap, safe Escape, focus restoration, and
  dirty-state tests.
- No success-only informational modal exists.
- Long operations always show continuing progress, remain cancellable when
  safe, and never shift the Cancel control unexpectedly.
- Main workflows fit at 860×600 without hidden actions and work at 200% zoom.
- Light/dark/reduced-motion states have visual regression coverage.
- Existing engine behavior, honesty gates, no-content-logging rules, and all
  current frontend tests remain intact.

## 11. Recommended delivery slices

Ship as reviewable slices rather than one visual rewrite:

1. UI state gallery + primitives + modal safety.
2. One-sidebar shell + toolbar + telemetry removal.
3. Studio setup/composer/result hierarchy + Apply sheet.
4. Harness and Evaluations redesign.
5. Dedicated Settings window and credential dialogs.
6. Accessibility, screenshots, and native smoke hardening.

The first two slices create the biggest perceived improvement with the lowest
product risk. The Settings/window slice is deliberately later because it
crosses the React/Tauri window boundary and deserves isolated testing.
