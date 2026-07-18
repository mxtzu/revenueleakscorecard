# Ascend — "The Trading Playbook" homepage (Shopify OS 2.0)

A modular, production-ready Shopify homepage in Liquid for a ~£35 educational
strategy kit aimed at burned retail futures traders (ES & NASDAQ intraday).

Every headline, body block, image and CTA is editable in the theme customizer.
The page is built as an **arc**: it opens on the problem in the reader's own
voice and installs one belief per section before it ever mentions the product.

---

## Install

Copy these into your Online Store 2.0 theme (they mirror the theme folder layout):

```
sections/   →  your-theme/sections/
snippets/   →  your-theme/snippets/
templates/index.json  →  your-theme/templates/index.json   (this becomes the homepage)
```

Then open **Online Store → Themes → Customize** on the homepage. Every section
below appears in the sidebar in order, with editable text/blocks.

> The rest of the storefront (global `header`/`footer`, `theme.liquid` layout,
> `cart`, etc.) comes from your base theme. This deliverable is the **homepage
> template + its sections + snippets** only. The compliance block is rendered as
> the page's own `contentinfo` footer at the bottom of the homepage; if your
> theme already renders a global footer, decide whether to keep both or hide the
> theme footer on this template.

---

## Section order (the belief arc)

| # | Section file | Belief it installs |
|---|---|---|
| — | `ascend-tokens.liquid` | (no copy) emits the palette + shared CSS. Keep it **first**. |
| 1 | `hero-problem.liquid` | *My losses come from the trades I take, not the ones I miss.* |
| 2 | `agitate.liquid` | *I'm disciplined everywhere else — so this isn't "who I am".* |
| 3 | `real-cause.liquid` | *I don't have a willpower problem. I have a missing filter.* |
| 4 | `problem-mechanism.liquid` | *I'm not getting hunted. I'm volunteering.* |
| 5 | `solution-mechanism.liquid` | *Discipline can be something I follow, not summon.* **← tonal turn** |
| 6 | `what-you-get.liquid` | *This is a concrete, finite kit — not a subscription.* |
| 7 | `proof.liquid` | *I can verify this on my own data before risking a penny.* |
| 8 | `founder.liquid` | *This person isn't a guru; the "why sell it" objection is answered.* |
| 9 | `faq.liquid` | *My specific objection has already been addressed.* |
| 10 | `price-cta.liquid` | *£35 is small next to one more bad trade.* |
| 11 | `compliance-footer.liquid` | (legal) educational-not-advice + risk warning. |

The **tonal turn** happens at section 5: sections 1–4 use the heavy/dark palette
(`--ascend-bg`), sections 5–7 switch to the clean/light palette
(`--ascend-surface-light`), then 8–10 return to dark for the close.

---

## Palette & type — tuned in ONE place

Open the **"Ascend — Design tokens"** section in the customizer. Its settings map
to CSS custom properties consumed by every other section via
`var(--ascend-*, fallback)`:

| Setting | CSS variable | Used for |
|---|---|---|
| Page background | `--ascend-bg` | dark sections (1–4, 8–10) |
| Raised panel (dark) | `--ascend-surface` | cards on dark |
| Clean surface | `--ascend-surface-light` | solution/proof (5, 7) |
| Headings on dark / light | `--ascend-ink` / `--ascend-ink-dark` | all headings |
| Body text on dark | `--ascend-body` | paragraph text on dark |
| Muted / labels | `--ascend-muted` | eyebrows, captions |
| Loss / red register | `--ascend-loss` | the "bad trade" accents |
| Ascend accent (green) | `--ascend-accent` | CTAs, ticks, the turn |
| Keyboard focus ring | `--ascend-focus` | `:focus-visible` outlines |
| Sans / Serif stack | `--ascend-sans` / `--ascend-serif` | body vs. "thought" lines |

Type uses the **system font stack** (zero network requests). A quiet serif
(`Georgia`) is used only for the "thought" lines (hero, founder, payoffs) so they
read as private writing, not ad copy.

---

## Which theme settings map to which copy

Each section's schema labels are written to be self-explanatory in the editor.
Highlights:

- **Hero** — `Lead line (the thought)` is the "No reason to trade off-plan. I do
  it anyway." opener. `Subline` / `Reflection line` sit beneath it.
- **Agitate** — the `Disciplined → then` **blocks** are the "you'd never ship
  untested code, but you'll click a setup you can't name" contrasts. Add/remove
  freely (max 6).
- **Real Cause** — two columns: `Left = the story you were sold`,
  `Right = what's actually true`.
- **Problem Mechanism** — the numbered `Mechanism step` blocks walk stops →
  liquidity → unfiltered entry → sweep. `Honest-framing note` keeps it a real
  mechanism, not a conspiracy.
- **Solution** — two block types in one section: `Flow step` (the 4-move summary:
  Sweep → Shift → Agree → Else) and `Gate rule` (the 8-point checklist). The
  green tick numbers on the gate auto-number from the `check` blocks.
- **What You Get** — `Stack item` blocks are the 3 core deliverables; the
  `Order-bump` settings are the ~£15 Trade Journal add-on.
- **Proof** — `Annotated chart image` (image picker) + `Annotation` blocks. This
  is the highest-leverage element on the page. **Placeholder — replace.**
- **Founder** — `Founder story` richtext. **Placeholder — replace with TRUE events.**
- **FAQ** — `Question` blocks (native `<details>` accordion, keyboard-accessible).
- **Price / CTA** — pick a `Product` (the CTA links to it) **or** set a custom
  `CTA URL`. `Value reframe` is the "less than one more trade you shouldn't have
  taken" line. `Included item` blocks list what's in the kit.
- **Compliance Footer** — `Education body`, `Risk body`, and `Stat + source`
  (must cite a real regulator/source). Footer `link` blocks for Terms/Refund/etc.

---

## ⚠️ Placeholders that MUST be replaced before going live

The theme shows an amber **"PLACEHOLDER — replace before launch"** banner on these
items **inside the theme editor only** (via `request.design_mode`); live visitors
never see the banners. Replace the underlying content regardless:

- [ ] **Founder story** (`08 Founder`) — real, first-person events only. No
      invented account sizes, timelines, or outcomes.
- [ ] **Worked-trade / backtest example** (`07 Proof`) — one honestly-annotated
      real trade or backtest from real data. Ideally include a case where the
      filter said *no*. **No cherry-picking, no fabrication.**
- [ ] **Any testimonials/quotes** — none are shipped, by design. If you add them,
      they must be **genuine, attributed, and verifiable**. Fabricated reviews are
      **illegal under the UK DMCC Act 2024**.
- [ ] **"Most retail traders lose" stat source** (`11 Compliance`) — if you state a
      figure, cite a **real, named regulator/source** and link it. Frame it as
      market reality, **never** as an implied promise you'll be the exception.
- [ ] **Sign-off name** (`08 Founder`) and footer legal entity name.
- [ ] **Price** — confirm `£35`, the Trade Journal `~£15`, and the currency match
      your actual product/variant.
- [ ] **CTA target** — set the real product or checkout URL in `10 Price — CTA`.
- [ ] **Footer links** — point Terms/Refund/Privacy/Contact at real pages.

---

## Copy guardrails baked in (don't undo them)

- **Process claims only.** No profit promises, income claims, results guarantees,
  or "you'll be in the winning minority." The default copy is written this way on
  purpose — keep it that way when you edit.
- **Empathy before claim.** Somber recognition early; controlled empowerment only
  from the Solution section on. That's mirrored in the palette turn.
- **Specific beats vague.** No hype adjectives standing in for proof.

---

## Accessibility & performance notes

- Semantic landmarks (`<section aria-labelledby>`, `<footer role="contentinfo">`),
  one `<h1>` (hero) and `<h2>`/`<h3>` hierarchy throughout.
- FAQ uses native `<details>/<summary>` — keyboard-operable with **no JavaScript**.
  (The whole page ships zero JS.)
- All CTAs are real focusable links with a high-contrast `:focus-visible` ring;
  `prefers-reduced-motion` is respected.
- Images use `loading="lazy"`, `decoding="async"`, `srcset`/`sizes`, and explicit
  `width`/`height` to avoid layout shift. Add descriptive `alt` text on the proof
  image.
- CSS is scoped per section (`.<name>-{{ section.id }}`) and inlined via
  `{% style %}` — no render-blocking external stylesheets or fonts.
- Colour pairings target **WCAG AA**; if you retune the palette in the tokens
  section, re-check contrast (body-on-bg and accent-on-bg especially).

---

## ⚖️ Legal — read this

This page includes a baseline risk warning and an "educational content, not
financial advice" line. **This does NOT fully immunise the page under FCA rules
on financial promotions.** Before running **any** paid traffic to this page, have
a **financial-promotions solicitor review the entire page** — not just the footer.
The same note is repeated as a code comment at the top of
`sections/compliance-footer.liquid`.
