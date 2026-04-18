# NOVA MAIL: FROM-SCRATCH PRODUCT UI SPEC

Date: 2026-04-08
Owner: Frontend Architecture + Product Design
Status: Approved for implementation

---

## 🎨 IMPLEMENTATION STATUS

### ✅ Phase 1: Design Foundation COMPLETE (April 8, 2026)

**What's Been Implemented:**

1. **CSS Design System Redesigned** (`src/app/globals.css`)
   - ✅ Unified accent color: **Indigo** (#6366f1 light, #818cf8 dark) - same hue family across themes
   - ✅ Replaced sage-green dark mode with indigo for consistent product identity
   - ✅ Typography scale: 7 semantic sizes (Display, H1-H3, Body, Label, Caption)
   - ✅ Spacing scale: 8 levels using 4px base unit
   - ✅ Motion system: 80ms-220ms timing for interactions
   - ✅ Shadow system: xs-xl for proper depth hierarchy
   - ✅ Semantic color states: success, warning, danger, info (properly contrasted)
   - ✅ Removed glassmorphism blur, replaced with clean shadows for premium feel

2. **Core Components Refactored**
   - ✅ **EmailRow**: Compact 72px design (was 112px), removed 6 redundant badges, mobile-friendly actions
   - ✅ **AIPanel**: Simplified layout, semantic confidence (High/Medium/Low), inline draft editing, no clutter
   - ✅ **ThreadView**: Clean header, inline AI draft (not side panel), proper spacing hierarchy

3. **Color System Unified**
   - ✅ Dark mode now uses indigo accent (same family as light mode)
   - ✅ All hardcoded Tailwind colors replaced with CSS variables
   - ✅ Backward compatibility layer (old names still work) enables gradual migration

### 🚧 Phase 2: Component Polish (Next)
- [ ] Fix remaining hardcoded colors (4 files: settings, drafts, pages, compose)
- [ ] Mobile responsiveness refinement
- [ ] Micro-interactions (button press, loading states, toasts)
- [ ] Category pills visible in inbox (not dropdown)
- [ ] Account identity prominence

### 📋 Phase 3: Testing & Verification
- [ ] Theme switching test (dark ↔ light)
- [ ] Mobile device testing (iPad, iPhone, Android)
- [ ] Contrast ratio validation (WCAG AA+)
- [ ] Browser compatibility (Chrome, Firefox, Safari)

---

## CRITICAL DESIGN CHANGES MADE

### Color System
**Before:** Blue accent (#0f5fa6) in light mode, Sage Green (#8fb9ae) in dark mode = Two different products
**After:** Indigo (#6366f1 / #818cf8) unified across themes = Single, coherent identity

### Inbox Density
**Before:** 112px rows with 6+ status badges
**After:** 72px rows with only essential info (sender, subject, preview, category, state) = Better scannability

### AI Visibility
**Before:** Side panel away from writing context
**After:** Inline card between email and reply composer = Reduced friction, clearer workflow

### Typography
**Before:** 5+ inconsistent sizes (xs, sm, base, 15px, 2xl)
**After:** 7 semantic scales with consistent ratios = Professional, cohesive

### Mobile Experience  
**Before:** Hover-only actions invisible on touch
**After:** Always-visible menu button + optional gesture support = Touch-native

---

---

This document defines a full replacement of the current UI system.

What is explicitly removed:
- Legacy fixed shell assumptions
- Sidebar-first hierarchy
- Tab-driven detail model
- Detached AI workspace paradigm
- Default-visible metadata and debug surfaces

What is explicitly preserved:
- Inbox functionality
- Thread view
- AI draft generation and actions
- RAG transparency (hidden by default)
- Multi-account switching
- Categories and filtering
- Attachments in compose/reply
- Full action set (generate, send, archive, etc.)
- Existing API contracts and backend workflows

Non-goal:
- No backend schema change
- No endpoint contract change

---

## 2) New Experience Model

Product name for internal implementation: Nova Mail

Core principle:
Minimal by default. Expandable on demand. Zero clutter. Maximum clarity.

Interaction thesis:
- Single focused surface at a time
- Progressive disclosure for advanced context
- AI appears inline at the moment of decision
- Operational telemetry is never in the default path

---

## 3) New Information Architecture

No inherited layout rules from current UI are retained.

### 3.1 Global Structure

Desktop:
- Stage layer (primary canvas)
- Floating command layer
- Context drawer layer

Mobile/Tablet:
- Stage layer
- Bottom quick actions
- Full-screen overlays for command and context

### 3.2 Navigation Model

Primary navigation is command-first, not sidebar-first.

Entry points:
- Global command trigger (Cmd/Ctrl+K)
- Account chip in top utility rail
- Contextual filter pills above inbox stream

No permanent left navigation is required.
A temporary navigation sheet can be opened on demand.

### 3.3 Screen States

State A: Focus Inbox
- Full-width message stream
- Subtle filters and category chips
- Hover/select reveal actions only when needed

State B: Immersive Thread
- Vertical reading flow
- Inline reply composer and inline AI proposal
- Attachments integrated where reply happens

State C: Context Drawer (optional)
- RAG traces, decision rationale, metrics, logs
- Fully hidden by default

---

## 4) Layout Concepts (New, Not Derived)

### 4.1 Inbox Stage

Top utility rail:
- Account identity chip with explicit sender identity
- Search field with natural-language prompt support
- Command button
- Quiet settings icon

Inbox stream:
- Sender as strongest line weight
- Subject as second line
- Preview as tertiary text
- Category marker as subtle color-thread tag
- Time aligned right with low visual weight

Action reveal rules:
- Hover: quick actions appear (generate, archive, open)
- Selection: persistent action strip appears above stream

### 4.2 Thread Stage

Everything in one vertical document:
- Thread header
- Original message stack
- Inline AI draft block
- Inline human edit block
- Attachments strip
- Send row

No tabs. No panel switching.

### 4.3 Context Drawer

Hidden default. Opens from a single Context button.

Sections:
- Why this draft
- Retrieved memory snippets
- Category and decision rationale
- Model and latency metrics
- Processing events and logs

Default collapsed sections:
- All except top summary sentence

---

## 5) New Component System (Greenfield)

All components below are new and replace prior hierarchy.

### 5.1 App-Level Components

- NovaStage
  - Owns route-level layout and transition choreography
- UtilityRail
  - Account identity, search, command entry, settings
- CommandPalette
  - Jump to account, filter, message, action
- ContextDrawer
  - Progressive disclosure container

### 5.2 Inbox Components

- InboxStream
  - Virtualized list container with keyboard navigation
- MessageTile
  - Sender, subject, preview, time, subtle category token
- TileActionStrip
  - Hover/selection actions
- CategoryRibbon
  - Low-noise filter controls
- BulkActionBar
  - Appears only when multi-select active

### 5.3 Thread Components

- ThreadDocument
  - Full vertical conversation document
- MessageBlock
  - Each email in thread, chronological grouping
- InlineReplyComposer
  - User-editable reply body and send controls
- AttachmentTray
  - Add/remove/preview attachments in-place
- AINativeDraftCard
  - AI draft appears as proposed next reply
- SendDecisionRow
  - Primary send plus secondary actions

### 5.4 Progressive Disclosure Components

- ContextToggle
  - Open/close context drawer
- RAGInsightPanel
  - Retrieved snippets and relevance cues
- DecisionNarrativePanel
  - Why category, why action
- OpsTelemetryPanel
  - Token counts, trace, logs (collapsed by default)

### 5.5 Identity Components

- AccountIdentityChip
  - Explicit active sender identity
- AccountSwitchSheet
  - Fast account change and account status
- SenderGuaranteeBadge
  - Confirms current sending identity in composer row

---

## 6) User Flows (Fast Path)

### 6.1 Inbox to Send (Primary)

1. User opens Inbox Stage
2. User scans MessageTile list
3. Hover reveals Generate and Open actions
4. User opens thread
5. Inline AI draft appears under conversation
6. User edits inline, adds attachment if needed
7. User sends from SendDecisionRow

Expected target time:
- Familiar user: under 10 seconds for simple reply

### 6.2 Account-Safe Send

1. Active account always visible in UtilityRail
2. Thread stage repeats sender identity near send button
3. User can switch identity without leaving current context
4. Draft and send calls use selected account context

### 6.3 Transparency on Demand

1. User taps Context
2. Drawer opens with one-line summary first
3. User expands Why, RAG, Metrics, Logs only if needed
4. Drawer closes without losing thread position

---

## 7) Visual Identity

### 7.1 Tone

- Premium calm
- High readability
- Confident but quiet

### 7.2 Typography

Suggested pairing:
- Display and headings: Sora
- Body and UI text: Instrument Sans

Type scale:
- Display: 32/40
- H1: 24/32
- H2: 18/26
- Body: 15/24
- Meta: 12/18

### 7.3 Spacing System

Base spacing unit: 4
Operational rhythm:
- 8, 12, 16, 24, 32, 48

Rules:
- Minimum 16 padding on mobile tiles
- Minimum 24 on desktop stage cards
- Single vertical rhythm in thread document

### 7.4 Color and Surfaces

No purple bias.

Palette direction:
- Warm neutrals for base surfaces
- Slate text hierarchy
- Single accent family for active/AI states
- Distinct semantic tones for warning and error

Surface model:
- Stage background gradient
- Elevated cards with soft blur and thin border
- Focus states use contrast and motion, not heavy fills

### 7.5 Motion System

Meaningful motion only:
- Stage transition: 180ms ease-out
- Tile hover reveal: 120ms
- Drawer open/close: 220ms
- AI draft insertion: subtle fade-up 160ms

No decorative animation loops.

---

## 8) Behavior Contracts

These contracts keep backend compatibility intact.

Preserved contracts:
- Inbox fetch shape and filtering behavior
- Thread detail payload and actions
- Draft generation and send endpoints
- Archive and state transition actions
- Multi-account accountId handling
- Attachment upload and send behavior

Frontend contract rules:
- New components can reorganize display only
- No change to payload field names
- No change to endpoint semantics

---

## 9) Implementation Plan (Safe Replacement)

### Phase 0: Foundation

- Introduce new token system in global styles
- Add motion primitives and surface primitives
- Add command palette infrastructure

Deliverable:
- Visual foundation without feature regression

### Phase 1: New Shell and Navigation

- Replace legacy app shell with NovaStage + UtilityRail
- Add AccountIdentityChip and AccountSwitchSheet
- Add temporary nav sheet (optional), no permanent sidebar requirement

Deliverable:
- New product frame, account clarity always visible

### Phase 2: Inbox Stream Rewrite

- Replace current inbox hierarchy with InboxStream + MessageTile
- Add hover and selection action model
- Add subtle CategoryRibbon filters

Deliverable:
- Clean, readable, action-efficient inbox

### Phase 3: Thread Rewrite

- Replace thread tabs/panels with ThreadDocument vertical flow
- Add AINativeDraftCard inline
- Add InlineReplyComposer with integrated AttachmentTray
- Add SenderGuaranteeBadge at send point

Deliverable:
- End-to-end immersive thread and send experience

### Phase 4: Progressive Disclosure

- Add ContextDrawer
- Move all advanced and debug data to collapsed sections
- Keep default view task-focused

Deliverable:
- Transparency preserved without clutter

### Phase 5: Hardening and Rollout

- Feature parity audit against existing actions
- Accessibility pass (keyboard and screen readers)
- Performance pass (tile virtualization and transition costs)
- Controlled release flag for production rollout

Deliverable:
- Backend-safe release candidate

---

## 10) Acceptance Criteria

This redesign is only accepted if all are true:

1. Default UI shows no tabs and no debug metadata blocks
2. AI draft appears inline in thread, not in a separate panel or tab
3. Account identity is always visible before send
4. Attachments are added and previewed inline where user replies
5. Categories are visible but low-noise and filterable
6. Advanced transparency is available but hidden by default
7. All existing actions still work through unchanged API contracts
8. New UI is visually and structurally distinct from current product

---

## 11) Build Mapping (Suggested File Replacement Strategy)

Suggested replacement targets:
- src/components/AppShell.tsx -> replace with NovaStage entry
- src/components/layout/TopBar.tsx -> replace with UtilityRail
- src/components/layout/Sidebar.tsx -> deprecate in favor of nav sheet
- src/app/inbox/page.tsx -> rebuild around InboxStream and ThreadDocument stages
- src/components/email/EmailRow.tsx -> replace with MessageTile
- src/components/email/ThreadView.tsx -> replace with ThreadDocument
- src/components/email/AIPanel.tsx -> replace with AINativeDraftCard
- src/components/email/QuickReply.tsx -> replace with InlineReplyComposer + AttachmentTray
- src/components/email/EmailMetadataPanel.tsx -> migrate to ContextDrawer panels

Note:
Replacement means deleting prior component structures and mounting the new system with the same data contracts.

---

## 12) Product Statement

This is not a UI refresh.
This is a product reset where AI, identity, and action speed are native to the core flow.

Target outcome:
A premium communication system that feels faster than legacy email tools, clearer than current inbox products, and unmistakably new.
