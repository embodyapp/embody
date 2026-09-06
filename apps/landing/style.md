# Visual Style Guide: Rhymezlikedimez (Robin Velghe)

## 1. Aesthetic Identity & Core Philosophy
* **Core Concept:** Nostalgic escapism, late-summer daydreams, and urban serenity.
* **Influences:** Franco-Belgian *ligne claire* (Tintin comic lineage), 1930s rubber-hose animation, mid-century modern architecture, hip-hop/lo-fi music culture, and California/European coastal leisure.
* **Overall Vibe:** Laid-back, warm, cinematic, stylish, and optimistic.

---

## 2. Color Palette & Lighting
* **Primary Tones:**
  * Canvas/Background: Cream / Warm Paper (`#FDF8F2` to `#F7EFE3`)
  * Golden Hour Yellow/Orange: `#FDB849`, `#F27A3D`
  * Dusty Sky Blue: `#7BB8D4`
  * Muted Lavender / Twilight Purple: `#A084B6`, `#56486E`
  * Palm Teal / Mint: `#4E9B8F`, `#A3D9C9`
  * Warm Terracotta / Clay: `#D66248`
* **Lighting Behavior:**
  * Constant golden-hour / late-afternoon sun.
  * Soft bloom, sun flares, and warm rim lighting along edges.
  * Colored shadows (deep indigo `#2C2230`, plum, or warm brown; never raw `#000000`).

---

## 3. Linework, Shading & Texture
* **Linework:**
  * Clean, vector-style, uniform medium-weight stroke (`2px` to `2.5px`).
  * Smooth curvature with rounded terminals and corner joins.
* **Shading:**
  * Flat cel-shading with deliberate hard cuts.
  * Minimal soft gradients, strictly reserved for skies and ambient lighting blooms.
* **Texture & Finish:**
  * Subtle noise / film grain overlay (2–5% opacity).
  * Paper tooth and light halftone dot accents on larger flat color areas to avoid a sterile digital appearance.

---

## 4. Subject Matter & Visual Motifs
* **Vehicles:** Classic sports cars (Porsche 911, vintage BMWs, Mercedes SL), convertibles, and mopeds.
* **Environment:** Palm trees, mid-century architecture (cantilevered roofs, pool decks, floor-to-ceiling glass), sunset horizons, coastal roads, and minimalist cityscapes.
* **Objects & Props:** Vinyl records, turntables, vintage boomboxes, oversized headphones, coffee mugs, and house plants (Monstera, Ficus).
* **Characters:** Relaxed, simplified anatomy with minimal facial features (dot/slit eyes, simple line smiles), oversized streetwear (puffy hoodies, bucket hats, baggy pants, retro sneakers).

---

## 5. UI & Web Design Implementation Reference

### Typography
* **Display / Headings:** Bold vintage rounded sans or 70s display faces (`Outfit`, `Cooper Black`, `Recoleta`, `ITC Avant Garde Bold`, or `Frankfurter`).
* **Body / UI:** Clean geometric or grotesque sans-serif (`Plus Jakarta Sans`, `Inter`, `Neue Haas Grotesk`, or `Satoshi`) with relaxed line-height.
* **Code / Monospace:** `JetBrains Mono` with crisp weight tokens.

### Component Styling
* **Surfaces & Cards:**
  * Background: Creamy off-whites (`#FFFDF9`, `#FAF3E8`) or soft pastel tint cards.
  * Border Radius: Large and soft (`16px`–`24px`).
  * Borders: Solid `2px`–`2.5px` stroke matching shadow tones (`#2C2230`).
  * Shadows: Hard-offset or diffused warm-tinted drop shadows:
    ```css
    box-shadow: 4px 4px 0 #2C2230;
    /* or diffused warm: */
    box-shadow: 0 12px 32px rgba(180, 80, 40, 0.08);
    ```
* **Buttons & Interactive Elements:**
  * Pill-shaped (`border-radius: 9999px`) or heavily rounded rectangles.
  * Chunky physical feel with solid border strokes and hard-offset drop shadows on hover (`transform: translate(-2px, -2px)`).

### Motion & Micro-interactions
* **Animation Curve:** Gentle, lazy spring physics (`cubic-bezier(0.25, 1, 0.5, 1)` or GSAP `back.out(1.4)`).
* **Looping Dynamics:** Infinite ambient motion (subtle floating objects, breeze in palm leaves, looping vinyl spin).
* **Hover States:** Subtle squash-and-stretch or gentle upward lift (`translateY(-4px)`).
