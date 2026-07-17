# Custom Liquid components — Liquidity Reversal store

Four self-contained snippets for Shopify **Custom Liquid** blocks, on a
black brushed-metal + green theme. Each file is standalone: its own CSS, markup
and JS, all namespaced under a unique prefix so **all four can live on one page
with zero clashes**.

| File | Prefix | Tier / look | Cart? |
|---|---|---|---|
| `backtesting-checklist-bundle.liquid` | `.bcb-` | **Tier 1 — Matte Steel** (flat, static, plain) | Adds **2** variants |
| `backtesting-workbook.liquid` | `.btw-` | Base styling (content only) | No button |
| `trade-journal-order-bump.liquid` | `.tjb-` | **Tier 2 — Diamond** (faceted, sheen + sparkle) | Toggle adds/removes **1** variant |
| `vault-bundle.liquid` | `.vb-` | **Tier 3 — Black Diamond** (obsidian, layered sweep + sparkle, gold seal) | Adds **3** variants |

Visual richness escalates on purpose: **cheap = dull/matte/static → expensive =
bright/faceted/animated**.

---

## Where to paste each snippet

All of these go into a **Custom Liquid** section/block (Online Store →
Customize → add block → *Custom Liquid*), or into a section that renders raw
Liquid. Paste the **entire file contents** into the block.

- **`backtesting-checklist-bundle.liquid`** — on the bundle's product page, or
  any landing page where you sell the Backtesting + Checklist entry bundle.
- **`backtesting-workbook.liquid`** — on the Backtesting Workbook product page,
  in the description area. Pure content, no cart button.
- **`trade-journal-order-bump.liquid`** — on the **main £47 kit product page**,
  placed **directly under the main Add-to-Cart button** so it reads as an
  order bump.
- **`vault-bundle.liquid`** — on the Vault bundle product/landing page as the
  flagship offer.

---

## CONFIG values you must fill in

Every file opens with a clearly commented `CONFIG` block of Liquid `assign`
statements. Replace the placeholders (`00000000000001`, etc.) with real values.

**Prices are in pence** (the smallest currency unit): `£19.00 → 1900`,
`£29.00 → 2900`. They're formatted for display with Shopify's `money` filter,
so they follow your store's currency settings automatically.

### `backtesting-checklist-bundle.liquid`
- `bcb_workbook_variant`, `bcb_checklist_variant` — the two numeric **variant IDs**.
- `bcb_workbook_price`, `bcb_checklist_price` — each item's individual price (pence).
- `bcb_bundle_price` — what you charge for the bundle (pence).
- Handles / copy strings are optional to change.

### `backtesting-workbook.liquid`
- No IDs needed. Just edit the `btw_*` copy strings if you want.

### `trade-journal-order-bump.liquid`
- `tjb_variant` — the Trade Journal **variant ID**.
- `tjb_price` — bump price (pence).

### `vault-bundle.liquid`
- `vb_v1`, `vb_v2`, `vb_v3` — the three Vault module **variant IDs**.
- `vb_p1`, `vb_p2`, `vb_p3` — each module's individual price (pence).
- `vb_bundle_price` — what you charge for the Vault (pence).

> **Savings are computed in Liquid** (`sum of individual prices − bundle price`)
> and only shown when positive. Nothing is hard-coded — if you change a price,
> the "You save …" figure updates itself. Set individual prices honestly.

### Finding a variant ID
Shopify admin → Products → the product → click the variant. The URL ends in
`.../variants/1234567890` — that number is the variant ID. (Store URLs use the
numeric ID; do not use the `gid://` GraphQL form here.)

---

## Add-to-cart behaviour

- Uses the **Shopify AJAX cart** (`fetch POST /cart/add.js`). The order-bump
  toggle also calls `/cart/change.js` with `quantity: 0` to remove the line
  when un-ticked.
- On success it tries to **refresh/open your theme's cart drawer**
  (`cart-drawer`, `#CartDrawer`, `.cart-drawer`, `[data-cart-drawer]`, plus a
  few common `cart:refresh` events). If no drawer is found, the bundle buttons
  **redirect to `/cart`**.
- All calls are wrapped in `try/catch` with visible success / error states and
  no `console` noise. If the toggle's add/remove fails, the toggle rolls back
  to match the real cart.
- **No `localStorage`/`sessionStorage`, no external JS/CSS libraries.**

> A **true in-checkout order bump** (one that appears inside checkout) requires
> Shopify **Plus + Checkout UI Extensions**. `trade-journal-order-bump.liquid`
> is the **product-page** AJAX version, which works on every plan.

---

## How to test the sparkle + reduced-motion behaviour

**See the effects (Tier 2 & 3):**
1. Load a page with `trade-journal-order-bump.liquid` and/or `vault-bundle.liquid`.
2. Watch for ~7s: a slow **specular sheen sweep** crosses each faceted card, a
   soft green caustic glow **breathes**, and small **four-point sparkles**
   twinkle in and out at staggered intervals. The Vault adds a wider light
   sweep, five layered sparkles, a shimmering CTA and a gold flagship seal.
3. Tier 1 (`.bcb-`) should look deliberately **flat and static** by comparison —
   that contrast is the point.

**Test reduced-motion (animation must stop):**
- **macOS:** System Settings → Accessibility → Display → **Reduce motion**.
- **Windows:** Settings → Accessibility → Visual effects → **Animation effects** off.
- **Chrome DevTools (no OS change):** open DevTools → `Cmd/Ctrl-Shift-P` →
  type **"Emulate CSS prefers-reduced-motion"** → choose *reduce*. Reload.

With reduced-motion on, all sheen/sparkle/shine **animation freezes**; the cards
stay fully styled and legible (sparkles hold at a soft steady state) — nothing
disappears, it just stops moving.

**Test AJAX gracefully failing:** temporarily set a variant ID to something
invalid and click add — you should see a red inline error message and **no
console errors**, and the order-bump toggle should snap back to unticked.

---

## Accessibility & responsiveness

- Real `<button>` / `<input type="checkbox">`, `aria-label`s, `role="status"`
  live regions for cart feedback, visible `:focus-visible` outlines.
- Tap targets ≥ 44px; single column on mobile.
- All animation is gated behind `prefers-reduced-motion`.

Every component ends with:

> *Educational material only — not financial advice. Trading index futures
> carries substantial risk of loss.*

No income/profit claims, no fake scarcity/countdowns, no fabricated
reviews/stats — per UK DMCC 2024 + financial-promotion rules.
