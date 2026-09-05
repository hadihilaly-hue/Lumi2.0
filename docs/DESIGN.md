# Lumi — Design System

Reference point: Linear. Restrained, tight, no decoration. Dark mode only —
light mode is out of scope. Black and white with grays for hierarchy, plus one
muted accent held to three uses.

This document is the contract. If a value isn't in here, it doesn't go in the
codebase.

---

## 1. Color

Every color in the product is defined once, here. No hex literal appears in any
`.css`, `.html`, or `.js` file outside this block.

```css
:root {
  /* Ground */
  --bg:            #171717;  /* app background */
  --bg-sidebar:    #1A1A1A;  /* sidebar, rails — one step off the ground */
  --surface:       #1E1E1E;  /* cards, input bar, user message, popovers */
  --surface-2:     #242424;  /* hover on surface, skeletons, disabled fills */

  /* Lines */
  --border:        #2D2D2D;  /* every border in the product */
  --border-strong: #3A3A3A;  /* hover state on interactive bordered elements */

  /* Text */
  --text:          #EDEDED;  /* body, headings, active nav      15.3:1 on bg */
  --text-2:        #A1A1A1;  /* secondary, meta, inactive nav    6.9:1 on bg */
  --text-3:        #8A8A8A;  /* labels, placeholders, timestamps 5.2:1 on bg */

  /* Accent — three uses only, see below */
  --accent:        #7F89E2;  /*                                  5.6:1 on bg */
  --accent-hover:  #9099E9;  /*                                  6.8:1 on bg */

  /* Danger — text and borders only, never a fill */
  --danger:        #EC5D62;  /*                                  5.4:1 on bg */

  /* Elevation — modals and dropdowns only. Nothing else casts a shadow. */
  --shadow-overlay: 0 8px 24px rgba(0,0,0,.6);
}
```

**The accent appears in exactly three places.** Nowhere else, ever:

1. The send button when the input is non-empty (background fill, white glyph)
2. Inline links inside Lumi's prose
3. The thinking/streaming indicator dot

It is not a button fill for primary actions, not a focus ring, not a selected
state, not a badge, not a chart color. Focus is `--border` → `--accent` on the
border only. Selected nav is `--surface` background plus `--text` foreground.

**Why the ground is `#171717` and not `#0A0A0A`:** near-black read as a hole
rather than a surface, and it left the ladder's lower rungs too close together
to separate a card from the page. `#171717` is the same register Claude and
ChatGPT sit in. Each rung above it was solved to hold the ratio it had against
its neighbour before the lift — a flat offset would have compressed the
hierarchy, since perceptual separation per code unit shrinks as luminance rises.

**Why `#7F89E2` and not Linear's `#5E6AD2`:** Linear's own indigo measures
3.8:1 against `#171717`, under the 4.5:1 threshold for body-size text. Link
text has to clear it, on `--surface` as well as on the ground. `#7F89E2` holds
5.2:1 on `--surface` with room to spare.

**Why primary buttons are not accent-filled:** `--text` on `#7F89E2` is 2.7:1 —
not usable for 13px button text at any size. Primary buttons are `--text` fill
with `--bg` text (15.3:1). This also keeps the accent scarce, which is the
entire point of having one.

**Every foreground token clears 4.5:1 on every ground token.** All 24 pairs
(`--text`, `--text-2`, `--text-3`, `--accent`, `--accent-hover`, `--danger`
against `--bg`, `--bg-sidebar`, `--surface`, `--surface-2`) measure 4.50:1 or
better; the floor is `--text-3` on `--surface-2`. Changing any one of these
nine values means re-running that sweep.

Status is never communicated by a colored pill. Status is a text label plus a
6px dot, and the dot is `--text-2` / `--text-3` — not green, amber, or red.
`--danger` is reserved for destructive-confirm text and validation errors.

---

## 2. Typography

Two families, three weights, eight levels. Request only what is used:

```
Inter          400, 500, 600
Source Serif 4 400, 400 italic
```

Sans for the entire interface. Serif for one thing only: Lumi's message prose.
That contrast is the product's single typographic idea — an interface around a
piece of writing. It stops working the moment serif appears anywhere else.

| Token         | Size | Weight | Line height | Tracking | Used for |
|---------------|------|--------|-------------|----------|----------|
| `--t-micro`   | 11px | 600    | 1.3         | +0.06em  | Section labels, tags. Uppercase. `--text-3` |
| `--t-meta`    | 12px | 400    | 1.4         | 0        | Timestamps, subtitles, help text, counters |
| `--t-ui`      | 13px | 400    | 1.45        | 0        | Default. Nav items, buttons, inputs, card body |
| `--t-strong`  | 14px | 500    | 1.4         | 0        | Card titles, message sender name, list headers |
| `--t-user`    | 15px | 400    | 1.6         | 0        | Student's own message text (sans) |
| `--t-prose`   | 16px | 400    | 1.7         | 0        | Lumi's message text (**serif**) |
| `--t-title`   | 20px | 600    | 1.25        | -0.01em  | View titles, wizard step headings |
| `--t-display` | 28px | 600    | 1.15        | -0.02em  | Sign-in wordmark. One instance in the product |

No other size exists. No 12.5px, no 13.5px, no half-pixels. No weight 300 or
700. Lumi's prose measures at most **68ch**; below that the serif stops reading
as writing and starts reading as a paragraph in a dashboard.

---

## 3. Spacing

4px base. Eight steps. Nothing between them.

```css
--space-1:  4px;   /* icon-to-label, tight inline pairs */
--space-2:  8px;   /* inside a control, label-to-field */
--space-3: 12px;   /* control padding, list item gaps */
--space-4: 16px;   /* card padding, group gaps */
--space-6: 24px;   /* section gaps within a panel */
--space-8: 32px;   /* between chat messages, between sections */
--space-12: 48px;  /* view top padding */
--space-16: 64px;  /* page gutters on wide viewports */
```

Radius — four values, and 8px is the ceiling:

```css
--radius-sm:   4px;  /* buttons, inputs, chips, small controls */
--radius-md:   6px;  /* cards, message bubbles, panels */
--radius-lg:   8px;  /* modals, popovers */
--radius-full: 999px; /* avatars only */
```

Borders are always `1px solid var(--border)`. No 0.5px, no 2px, no double
borders. Sidebar and panel dividers are the same 1px.

---

## 4. Components

### Chat message — Lumi
No bubble, no background, no border. Sender row: 20px circular avatar
(`--surface-2` fill, `--text-2` initials, `--t-micro`) + name in `--t-strong`
`--text`. `--space-2` below the row, then prose in `--t-prose` serif `--text`,
left-aligned, max 68ch. `--space-8` between messages.

Inline elements: `strong` is weight 600 same color. `em` is italic same color.
Links are `--accent`, no underline, no border-bottom. `code` is `--surface`
background, `--border` 1px, `--radius-sm`, 13px mono. `pre` is the same with
`--space-3` padding.

Feedback row (copy / thumbs): `--text-3` 14px glyphs, appears on message hover
only, `--space-3` below the message.

### Chat message — student
Right-aligned. `--surface` background, 1px `--border`, `--radius-md`,
`--space-3` padding, `--t-user` sans, `--text`. Max 60ch. No avatar, no name
label — position and treatment carry the attribution.

### Input bar
`--surface` background, 1px `--border`, `--radius-md`, padding
`10px 10px 10px 12px`. Focus: border → `--accent`. No glow, no shadow, no
background change.

Textarea: transparent, `--t-user`, `--text`, placeholder `--text-3`, max-height
120px then scroll.

Send button: 28×28, `--radius-sm`. Disabled — `--surface-2` fill, `--text-3`
glyph, no pointer. Armed — `--accent` fill, white glyph, hover `--accent-hover`.
No scale transform on hover or press. This button is the only accent-filled
surface in the product.

Attach button: ghost, `--text-3`, hover `--text-2`. Always visible — no
`:has()` reveal trickery.

### Sidebar
240px, `--bg-sidebar`, 1px right border. Wordmark is "Lumi" in Source Serif 4
15px/600 `--text` — no mark, no glyph, no glow, no animation.

Items: 28px tall, `--space-2` horizontal padding, `--radius-sm`, `--t-ui`
`--text-2`. Hover — `--surface` background. Active — `--surface` background,
`--text` foreground. No left accent bar, no bold.

Section labels: `--t-micro` `--text-3`, `--space-6` above, `--space-2` below.

Icons in nav only where the label alone is genuinely ambiguous. Most items are
text.

### Buttons
Four variants. Every one is 30px tall, `--space-3` horizontal padding,
`--radius-sm`, `--t-ui` at weight 500, 120ms color transition, no transform.

- **Primary** — `--text` fill, `--bg` text. One per view, maximum.
- **Secondary** — transparent, 1px `--border`, `--text`. Hover: border
  `--border-strong`, background `--surface`.
- **Ghost** — no border, `--text-2`. Hover: `--text`, background `--surface-2`.
- **Destructive** — ghost metrics, `--danger` text. Hover: background
  `--surface-2`. Never a red fill.

### Form fields
Recessed: `--bg` background against `--surface` panels, 1px `--border`,
`--radius-sm`, `--space-2`/`--space-3` padding, `--t-ui` `--text`. Focus:
border `--accent`. Placeholder `--text-3`.

Label above in `--t-meta` weight 500 `--text-2`, `--space-2` gap. Help text
below in `--t-meta` `--text-3`. Error text replaces help text in `--danger`
and the field border goes `--danger`. Character counters are `--t-meta`
`--text-3`, right-aligned, and never change color.

### Cards
`--surface` background, 1px `--border`, `--radius-md`, `--space-4` padding.
No shadow. Clickable cards: hover border → `--border-strong`. Nothing lifts,
scales, or brightens.

Title `--t-strong` `--text`. Meta `--t-meta` `--text-3`. Body `--t-ui`
`--text-2`. Grid gap `--space-3`.

### Empty states
One line of `--t-ui` `--text-2` saying what would appear here, and one ghost
button if there's an action. **Left-aligned**, in the flow of the panel — not
centered, no illustration, no icon, no emoji. A centered empty state with a
graphic reads as a consumer app.

### Loading
- **Streaming/thinking** — "Mr. Harris is thinking" in `--t-ui` `--text-2`,
  preceded by a 5px `--accent` dot pulsing opacity 0.3 → 1 over 1.2s. One dot,
  not three.
- **Content loading** — `--surface-2` blocks at the final layout's dimensions,
  `--radius-sm`. No shimmer sweep.
- **Spinners** — full-page auth boot only. Nowhere else.

### Modals and popovers
`--surface` background, 1px `--border`, `--radius-lg`, `--shadow-overlay`,
backdrop `rgba(0,0,0,.6)`. The only elements in the product that cast a shadow.

---

## 5. What Lumi never does

- **Gradients.** None. Not in backgrounds, buttons, borders, or text.
- **Shadows**, except `--shadow-overlay` on modals and popovers.
- **Glows.** No `box-shadow` used as a halo. The breathing logo animation is
  deleted.
- **Emoji in the interface.** Not in cards, buttons, banners, empty states,
  privacy notes, or headings. Icons are 14px or 16px stroke SVG at 1.5 stroke
  width in `currentColor`. Emoji inside a student's or teacher's own typed
  content is their business and passes through untouched. Third-party brand
  marks (the Google sign-in mark) are exempt from `currentColor` and keep their
  official colors.
- **Colored status pills.** No green/amber/red fills. Status is text plus a
  neutral dot.
- **A second accent hue.** One accent, three uses.
- **Accent as a background behind a block of text.** Send button only.
- **Transform on hover.** No scale, no lift, no rotate. Color and border only.
- **Decorative animation.** Motion is 120–160ms, opacity or color, and only to
  soften a state change. Nothing loops. Nothing pulses except the thinking dot.
- **Radius above 8px** on anything that isn't an avatar.
- **Weight 700 or 300.**
- **Centered body text.**
- **A hex literal, size, spacing value, or radius outside the token block.**
- **A duplicate component.** The teacher portal uses the same buttons, cards,
  and fields as the student app. It does not define its own.

---

## 6. Demo screens

Five screens carry the demo. Each is done when the list below is true — not
when it looks approximately right.

### 1. Sign-in (`index.html`)
Full-bleed `--bg`. Centered column, max 320px. "Lumi" in `--t-display` serif,
one line of `--t-ui` `--text-2` beneath it, then the Google button as
secondary, full width. Footer link to the privacy policy in `--t-meta`
`--text-3`.

**Done:** no `✦` orb, no role-picker emoji, no card border around the column,
no shadow. Nothing moves on load.

### 2. Student home — class grid (`app.html`, `homeView`)
Greeting in `--t-title`, subtitle `--t-meta` `--text-3`. Due-soon strip, then
class cards in a responsive grid, `--space-3` gap.

**Done:** every card is the same height regardless of content length. Urgency
is a dot and a text label, never a colored card edge or a red chip. Search
field matches the standard form field exactly. No icons in the card headers.

### 3. New thread — pinned welcome + starters
Pinned welcome card at the top: `--surface`, 1px `--border`, `--radius-md`,
`--space-4` padding, the teacher's name as `FROM MR. HARRIS` in `--t-micro`
`--text-3`, body in `--t-prose` serif, italic serif signoff. Below it, three
starter chips as secondary buttons, stacked left-aligned, text only.

One ghost link may sit under the chips — "Pick up where you left off — {title}"
— and only when there is a thread to resume. It is a feature, not decoration.

**Done:** the orange washi-tape graphic is gone. No avatar inside the card, no
"written during setup" tag, no subline, no divider. The chips wrap without
reflowing the card. Nothing else in the empty chat area — no greeting, no
divider, no placeholder, no icon.

### 4. Active conversation
Lumi in serif at 68ch, student messages right in `--surface` bubbles, thinking
dot visible mid-stream, input bar armed with the accent send button.

**Done:** this is the screenshot that has to sell the product. Streaming text
does not reflow the layout. Code blocks and KaTeX sit inside the 68ch measure
without horizontal scroll on a laptop viewport. The accent appears exactly
twice on screen — the send button and the thinking dot — and there is nothing
else colored anywhere in the frame.

### 5. Teacher onboarding wizard (`teacher.html`)
One content step (the teaching-voice textarea with its counter) and the review
step with summary cards.

**Done:** step indicator is `--t-micro` text, not dots or a progress bar. The
textarea is the standard form field at a generous height. Counter is
`--text-3` and stays that color past the soft limit. The `🔒 Only Lumi sees
this` notes are text in `--t-meta` `--text-3` with no lock glyph. Summary cards
are standard cards; Edit is a ghost button. Continue is the single primary
button on the screen.

---

## 7. Migration notes

- The `dark-mode` class plumbing (`localStorage['lumi-theme']`, the inline
  script in each page head) is no longer needed. Tokens go on bare `:root`;
  the class and the toggle come out.
- `style.css` currently carries 47 hex literals, ~60 hardcoded `rgba()` values,
  25 font sizes, and 18 radii. `teacher.html` carries another 650 lines of CSS
  and 15 more hex literals; `admin.html` and `index.html` have their own. All
  of it resolves to the tokens above or gets deleted.
- Reorganize `style.css` by primitive — tokens, base, typography, buttons,
  fields, cards, then features — not by feature as it is today.
- Cache-busting is already `?t=Date.now()` on every page, so there is no stale
  CSS to fight during the rebuild.
- The `lumiBreathe` keyframe is defined twice (`style.css` and `teacher.html`).
  Both go.
