# Lumi — Logo Redesign Brief

> Handoff brief for a designer or design tool (e.g. Claude design). Everything here
> is candidates-only exploration; the live app logo has **not** been changed.

## The problem
The current mark is the character **`✦`** (U+2726, a four-pointed star) set inside a
rounded accent tile. It reads too close to **Google Gemini's sparkle** and to the
generic "AI sparkle" that many AI products now use. The replacement must be:

- **Clearly distinct** from a four-pointed star / sparkle.
- **Not** a generic AI shimmer, orb, or spark.
- Ownable and legible from **16px (favicon) up to 128px+**.

## What "Lumi" is
An AI **tutoring app for students and teachers**. "Lumi" evokes **light / illumination**.
Good conceptual territory: illumination (light, bright idea), letterforms (the "L"),
and tutoring / dialogue (conversation, the "aha" moment, learning).

## Brand palette
| Role | Light mode | Dark mode |
|------|-----------|-----------|
| Accent (primary mark color) | navy `#1D2D4F` | periwinkle `#C5D2E8` |
| Background | cream `#F2ECE0` | dark navy `#1A1F2C` |
| Warm spark (use sparingly) | orange `#C76D3D` | orange `#D08964` |

Fonts in use: Inter (sans), Source Serif 4 (serif display, e.g. the "Lumi" wordmark).

## Where the mark appears (all as a rounded ~8px accent tile)
- Sidebar header `.logo-mark` — **28px**
- Mobile header `.mob-logo-mark` — **24px**
- Onboarding `.ob-logo-mark` — **52px** (has a soft breathing glow animation)
- Sign-in page `.signin-orb`
- Scheduler header `.sched-logo-mark`
- **Favicon — does not exist yet.** A 16px-legible version should be part of the final set.

## The five explored directions (see candidate-*.svg + logo-candidates.html)
1. **Lightbulb** — illumination. Clearest "Lumi = light"; strongest legibility at all sizes. *(recommended)*
2. **"L" that emits light** — the only true letterform/monogram; most ownable, but the rays need tuning so they read as light, not sprouting.
3. **Dialogue + dawning insight** — speech bubble + rising sun = the tutoring "aha"; best story, busiest at 16px.
4. **Lantern** — guiding light; distinctive, **but at small sizes the handle-over-body silhouette risks reading as a padlock** — reshape or set aside.
5. **Radiant open book** — education-forward; clean, balanced, no sparkle. *(recommended runner-up)*

## Recommendation for the next iteration
- Lead with **#1 (Lightbulb)** and **#5 (Open book)**; keep **#3** if you want the
  tutoring-conversation story to lead the brand.
- Deliver a **dedicated 16px favicon** variant (simplify or drop the fine warm-orange
  detail — it disappears at favicon size).
- Provide the mark **standalone** and **inside the rounded accent tile**, in both
  light (navy on cream) and dark (periwinkle on navy) treatments.
- Keep the warm orange as a small accent only — never the dominant color.

## Files in this folder
- `candidate-1.svg … candidate-5.svg` — editable SVG sources (use `currentColor`, so they recolor to context).
- `logo-candidates.html` — gallery: each mark at 16 / 32 / 128px on light & dark, plus in-tile previews, with rationales.
- `BRIEF.md` — this document.
