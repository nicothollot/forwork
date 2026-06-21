# Brand Reference

This document records the brand rules implemented in HL Intelligence. The supplied PDFs and SVGs are the source of truth. PDF text was extracted locally for review and relevant pages were rendered visually before implementation.

## Sources Inspected

- `Houlihan Lokey Brand Style Guide 2025-06.pdf`
  - Rendered pages 1-23.
  - Relevant pages: 9-14 for identity and logo rules, 16 for color, 17-18 for photography, 19-20 for typography, 21 for visual system.
- `Houlihan-Lokey-Color-Palette-2022-09-01.pdf`
  - Rendered page 1.
  - Relevant page: 1 for exact color values and palette intent.
- `Houlihan-Lokey-Image-Style-Guide-2025.pdf`
  - Rendered pages 1-20.
  - Relevant pages: 3-5 for image selection and technical guidance, 7-18 for light, depth, composition, diversity, portrait, and metaphor guidance.
- Supplied SVG logo assets listed in `AGENTS.md`.

## Official Colors

Primary palette:

| Color | Hex | RGB | CMYK | PMS |
| --- | --- | --- | --- | --- |
| Oxford Blue | `#002855` | `0 40 85` | `100 53 0 67` | `295 C` |
| Sapphire Blue | `#0067A5` | `0 103 165` | `93 59 9 1` | `641 C` |
| Roman Silver | `#7E8597` | `126 133 151` | `55 43 30 2` | `7544 C` |

Secondary palette:

| Color | Hex | RGB | CMYK | PMS |
| --- | --- | --- | --- | --- |
| Tufts Blue | `#508BC9` | `80 139 201` | `69 38 0 0` | `279 C` |
| Independence | `#525766` | `82 87 102` | `70 60 44 23` | `Cool Gray 10` |
| Metallic Sunburst | `#8C7337` | `140 115 55` | `41 47 91 18` | `1265 C` |
| Maximum Green | `#508225` | `80 130 37` | `73 28 100 13` | `7741 C` |
| Metallic Seaweed | `#1F808F` | `31 128 143` | `84 36 38 5` | `7713 C` |
| Rust | `#B54E15` | `181 78 21` | `21 79 100 11` | `1525 C` |
| Azure Blue | `#24A4F2` | `36 164 242` | `68 23 0 0` | `299 C` |

The color palette page states primary and secondary core colors are ADA-compliant except Roman Silver and Tufts Blue. The application uses Oxford Blue for primary text/actions, Sapphire Blue for focus/progress, Roman Silver/Independence for neutral UI, Metallic Sunburst for restrained emphasis, Maximum Green for success, and Rust for errors.

## Typography

Source: `Houlihan Lokey Brand Style Guide 2025-06.pdf`, page 19.

- Primary brand typeface: Usual.
- Approved weights shown: Light, Regular, Medium, Bold.
- PowerPoint and broadly available fallback typefaces: Segoe UI or Arial.
- Additional language support: Noto Sans for Chinese, Japanese, and Korean characters.

Source: `Houlihan Lokey Brand Style Guide 2025-06.pdf`, page 20.

- Secondary accent typeface: Hepta Slab.
- It should be used sparingly for call-outs and quotes.

Implementation: the app uses `"Usual", "Segoe UI", Arial, sans-serif`. Proprietary font files are not bundled.

## Logo Variants and Restrictions

Source: `Houlihan Lokey Brand Style Guide 2025-06.pdf`, pages 10-14.

- Primary logo with mark: one-line horizontal.
- Secondary logo with mark options: two-line left aligned, then stacked centered.
- Wordmark-only versions are approved for exterior building signage, stationery, and business cards.
- Always use provided logo files. Do not recreate the logo.
- Use the version with the best contrast and readability.
- Do not change the size relationship between symbol and logotype.
- Do not compress, stretch, or alter the aspect ratio.
- Do not place the logo over insufficient-contrast or visually busy backgrounds.
- Do not add shadows, gradients, or visual effects.
- Do not alter font, type case, colors, or the trinity symbol.
- Do not use old logo versions.

Implementation: the renderer uses a direct copy at `public/brand/hl-logo-horizontal.svg`, without modification.

## Clear Space and Sizing

Source: `Houlihan Lokey Brand Style Guide 2025-06.pdf`, pages 12-13.

- Clear space is based on the capital letter H in the logo.
- Minimum protective area: `1X` around the logo, where `X` is the H height.
- The same rule applies to all Houlihan Lokey logo versions.
- Horizontal logo with mark can reduce to 32 mm.
- Under 32 mm, use the two-line logo with mark or the one-line wordmark.
- Under 25 mm, use the two-line wordmark or the globe by itself.

## Spacing, Layout, and Background Treatments

Sources: `Houlihan Lokey Brand Style Guide 2025-06.pdf`, pages 16-21; `Houlihan-Lokey-Color-Palette-2022-09-01.pdf`, page 1.

- The palette guidance emphasizes open, white, negative spaces.
- Banking blues and silvers should remain at the forefront.
- Minimal organic, soulful earth tones may support the primary palette.
- Gradients and visual effects must not be applied to the logo.
- Brand example pages use dark/Oxford presentation environments, but the color palette page explicitly supports open white negative space. For an internal banking workflow tool, the app uses white work surfaces, restrained borders, Oxford headers, and selective accent color.

## Photography and Visual Examples

Sources: `Houlihan-Lokey-Image-Style-Guide-2025.pdf`, pages 3-18; `Houlihan Lokey Brand Style Guide 2025-06.pdf`, pages 17-18.

- Use crisp, clear, vivid high-resolution images.
- Prefer authentic, dynamic, editorial imagery.
- Use light, depth, composition, and diversity thoughtfully.
- Avoid pixelated, blurred, stretched, contrived, badly lit, flat, overly staged, stereotypical, or overly illustrative imagery.

Implementation: HL Intelligence is a document-processing utility, so no decorative photography is used. This avoids stock-like imagery and keeps the interface task-focused.

## Application-Interface Rules Derived

- Use the provided logo asset only.
- Keep visual design restrained, professional, and banker-oriented.
- Prefer open white work surfaces with clear hierarchy.
- Use accessible contrast and avoid Roman Silver/Tufts Blue as small body text on white.
- Avoid playful illustration, marketing hero sections, excessive rounded cards, gradients, and unnecessary animation.
- Use Segoe UI/Arial fallback if Usual is unavailable.

## Conflicts and Ambiguities

- The official color palette PDF and brand style guide list Tufts Blue as `#508BC9`. Several supplied RGB SVG logo files use `#4F8BC9` inside the trinity mark. Resolution: app design tokens use the explicit official palette value `#508BC9`; logo artwork is used as supplied and is not recolored.
- `Houlihan-Lokey-Color-Palette-2022-09-01.pdf` is reported by one file inspection tool as `0 page(s)`, but ImageMagick rendered one page and Ghostscript extracted the palette text. Resolution: the rendered one-page palette is treated as valid.
- Ghostscript reported repair warnings while extracting text from the main 2025 brand guide. Resolution: visual page renders were inspected alongside extracted text, and the explicit guide pages listed above were used.
