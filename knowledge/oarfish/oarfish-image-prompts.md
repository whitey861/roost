# Oar Fish Image Generation: Recraft Workflow

The Oar Fish kid-drawn doctrine is locked in a custom Recraft Brand Style trained on the existing Vol. 01 marker drawings. This replaces the earlier Midjourney and Flux approach, which had to fight AI defaults at every prompt. With a trained style, prompts get shorter, output stays consistent, and calibration becomes a one-time setup instead of an ongoing tax.

## The trained style

Name in Recraft: `Oar Fish marker` (adjust if named differently in the account)

References used for training:

- Oar Fish hoodie illustration
- Forest Ghost
- Desert Wanderer
- Sunwalker
- Anglerfish Cap art
- Horned Beast Tee art

Recraft `style_id`: `dad87807-a760-46e6-85f2-18bbb5461750`

Always pass this `style_id` to `generate_image` when working on Oar Fish output. Without it, generation falls back to the generic hand-drawn base style and won't match the trained doctrine.

The style handles, automatically, on every generation:

- Marker and ink texture
- Wonky linework and kid-drawn looseness
- Palette (Oar Fish purples, navy, beige, olive, oxblood)
- Paper background and visible bleed

The prompt only handles what the creature is and how it sits on the page.

## Prompt patterns

Format: `[creature or subject] + [composition] + [optional palette nudge]`

Short, literal, no negative prompts needed in most cases. The trained style already knows what Oar Fish looks like.

## Group A: Main line creatures

> A [creature, e.g. small four-eyed cat with tangled limbs], full body, single subject centred on white paper.

Variations:

- Add "half-emerging from [environment]" for atmospheric pieces
- Add "shown from [angle]" for compositional variety
- Add "with [bubbles | stars | scratchy lines] around it" for finished hoodie graphics

## Group B: Growl line creatures

Until a separate Growl style is trained, override the palette in the prompt:

> A [creature, e.g. hairy man with two long teeth and pale eyes], full body, oxblood and black instead of purple, heavier ink, more cross-hatching.

All Growl content rules from `oarfish-brand.md` apply: no gore, no shock, suggestion only.

## Group C: Phrase pieces

> Hand-lettered phrase "[phrase]" in marker, all caps (or all lowercase), uneven baseline, wonky kerning, on white paper. One small decorative mark beside the text (star, eye, asterisk, question mark).

Recraft V3 is strong at text-in-image. If hand-lettering still drifts toward typeset, do it by hand on paper, scan, and overlay.

## Group D: Atmosphere and backgrounds

> Atmospheric scene: [description, e.g. dark forest at night with two glowing eyes between trees]. Sketchy and loose, no creature shown clearly. Wide composition, atmosphere over detail.

## Group E: Social content

### Meme template visual

> [Meme idea, e.g. small cryptid with three eyes looking at a wallet, sad expression]. Sketchy, fast, rough.

### BTS sketchbook page

> An open sketchbook page with multiple small creature studies, some half-drawn, marginalia, arrows, notes in marker. Coffee stain in corner. Looks like a real working sketchbook.

## Test rubric

Style consistency is mostly automatic now. Score on:

1. Subject clarity (creature readable but not over-rendered)
2. Composition (works where it needs to go: hoodie back, IG square, carousel)
3. Brand fit (would this sit next to existing Oar Fish on the shop page?)

Below 9/15: reject. 9 to 12: iterate. 13 or above: save the prompt exactly as written to `oarfish-winning-prompts.md`.

## When to retrain or extend the style

Three triggers:

1. Style drifts on multiple consecutive prompts. Add more references and retrain.
2. Growl line ships its first real designs. Train a separate `Oar Fish Growl` style.
3. Vol. 03 lands with a notably new direction. Either retrain or branch.

Never retrain on AI-generated output. That compounds drift. Only use real hand-drawn references.

## What still needs human hands

Per the brand bible's production rule, every print on a garment starts from a real marker drawing. Recraft is for:

- Ideation and creature exploration
- Social content visuals (memes, atmosphere, sketchbook pages)
- Carousel art and banners
- Mood boards
- Mockups

Not for: final hoodie or tee prints, customer photography, anything where the imperfection of human hands is the whole point.

The garment workflow stays: ideate in Recraft if useful, then redraw by hand in real marker on real paper, scan, then print on garment.

## Cultural sensitivity

Cryptid rules from `oarfish-brand.md` apply to AI-generated creatures the same way they apply to hand-drawn ones. No Aboriginal Dreaming or Torres Strait Islander sacred figures. No Wendigo or other living Indigenous mythology. When in doubt, invent.

## Roost integration

Recraft has an API. A future Oar Fish workspace tool could generate creatures on demand from chat ("draw a small horned beetle for the next Growl drop"). 

Recraft `style_id`: `dad87807-a760-46e6-85f2-18bbb5461750`

Always pass this `style_id` to `generate_image` when working on Oar Fish output. Without it, generation falls back to the generic hand-drawn base style and won't match the trained doctrine.

