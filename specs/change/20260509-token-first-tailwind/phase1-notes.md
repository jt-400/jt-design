# Phase 1 Notes: Foundation PR

## Implementation

<!-- Files created/modified; implementation decisions; migration inventory/classification; retained/deferred rationale; problems encountered; deviations from design -->

### Step 1: Tailwind foundations

- `apps/web/package.json` / `pnpm-lock.yaml` - added Tailwind v4 foundation dependencies: `tailwindcss`, `@tailwindcss/postcss`, and `postcss`.
- `apps/web/postcss.config.mjs` - added the web-local PostCSS config that loads `@tailwindcss/postcss`.
- `scripts/guard.ts` - allowlisted the exact PostCSS config path with a compatibility-format comment so the residual JavaScript guard continues to fail on unplanned project-owned JavaScript.
- `apps/web/src/index.css` - added Tailwind theme/utilities layered imports, kept Preflight excluded, added the local base-layer border-style reset, and recorded the cascade policy for retained element/reset rules before component migration.

### Step 2: Open Design Tailwind tokens

- `apps/web/src/index.css` - added the CSS-first `@theme` block that clears Tailwind default colors and exposes the project-approved color namespace for surfaces, borders, text, accent, semantic status, interaction overlays, radius, shadows, fonts, and exact compact UI text-size aliases.
- `apps/web/src/index.css` - added missing runtime source variables for `--accent-wash`, `--accent-foreground`, `--warning-border`, modal overlay, selection overlays, and inspect overlays so Tailwind utilities resolve through the same CSS-variable token path as existing styles.
- `apps/web/src/index.css` - documented the token utility vocabulary next to the `@theme` block, including representative border/radius/shadow examples and the no-Preflight border reset expectation for `border border-border`.
- Token resolution remains CSS-variable-first: light, dark, and system modes update the existing token variables through `:root`, `[data-theme="dark"]`, and `html:not([data-theme])`; custom accent continues to update `--accent*` variables through the pre-hydration script and `applyAppearanceToDocument()`.

### Implementation requirements

- Tailwind no-Preflight setup must use the official layered CSS imports in `apps/web/src/index.css`:
  ```css
  @layer theme, base, utilities;
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/utilities.css" layer(utilities);

  @layer base {
    *, ::before, ::after, ::backdrop, ::file-selector-button {
      border: 0 solid;
    }
  }
  ```
- Keep Preflight excluded in Phase 1 and retain the project-owned border reset from Tailwind's Preflight contract in the base layer so `border border-*` token utilities render solid borders from the later utilities layer.
- Record the cascade-layer policy for retained `index.css` element/reset rules: any rule that can override migrated Tailwind utilities must move into `@layer base`, be constrained to non-migrated scopes, or be removed before the affected component migration lands.

## Verification

<!-- Commands run and results; screenshot artifact links/paths; exact baseline/development startup parameters or full commands; baseline/development service URLs; baseline/development namespace names; agent comparison scenario coverage; theme/accent matrix covered; observed drift; approved deviations -->

- `pnpm install` - passed; pnpm emitted existing workspace bin/link warnings for missing daemon dist CLI during install.
- `pnpm guard` - passed; residual JavaScript allowlist accepts `apps/web/postcss.config.mjs`.
- `pnpm --filter @open-design/web build` - passed with Next.js 16/Turbopack.
- `pnpm --filter @open-design/web build` - passed after adding the Open Design `@theme` token aliases and source variables.
