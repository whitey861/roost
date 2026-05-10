# Oar Fish Image Generation Prompts

Starter templates for Midjourney v6/v7 and Flux. The goal: outputs that match the kid-drawn doctrine. The benchmark: the current Oar Fish hoodie illustration. If a prompt produces anything glossier, smoother, or more "professional" than that, it has failed.

These are starting points, not pre-tested winners. The first job is to run them, score, iterate, and lock the working versions in `oarfish-winning-prompts.md`.

## Core style anchor

Paste this into every prompt before the subject description.

> Hand-drawn with permanent marker on white sketchbook paper, scanned. Wonky linework, uneven proportions, visible marker bleed and ink pooling. Loose cross-hatching for shading. Limited palette: deep purple ink with one accent colour. The drawing looks like a talented teenager with a sketchbook drew it, not a commercial illustrator. Raw and unrefined. Zine art energy. Garbage Pail Kids and 1990s skate zine references. No vector cleanup, no smooth gradients, no symmetry.

## Group A: Creature designs

### A1: Main line creature

> [Style anchor]. A [creature, e.g. four-eyed deep-sea anglerfish with kelp-tangled fins], full body, single subject centred. Decorative marks around it: small bubbles, scattered stars, scratchy lines. Marker drawing on paper background, deckle edge faintly visible.

Parameters:
- Midjourney: `--ar 1:1 --stylize 100 --weird 50`
- Flux: Flux Pro, prompt strength 0.85
- Negative: no vector art, no clean illustration, no AI gloss, no symmetry, no photoreal, no smooth gradients

### A2: Growl creature (darker line)

> [Style anchor], shifted darker. A [creature, e.g. hairy man with two long teeth and pale eyes, hunched in a doorway]. Heavier ink, more cross-hatching, oxblood accent instead of purple. The kid had a nightmare. Same hand, meaner subject. No gore, suggestion only.

Parameters:
- Midjourney: `--ar 1:1 --stylize 50 --weird 100`
- Flux: Flux Pro, prompt strength 0.9
- Negative: above plus no realistic horror, no splatter, no shock gore

### A3: Phrase piece graphic

> [Style anchor], for a text-only garment graphic. Hand-lettered phrase "[phrase]" in marker, all caps or all lowercase, wonky baseline, uneven kerning. One small decorative mark beside or below the text (star, eye, question mark, asterisk). White paper background.

Parameters:
- Midjourney: `--ar 1:1 --stylize 50`
- Flux: Flux Pro, prompt strength 0.85
- Negative: no typeset fonts, no perfect lettering, no clean vector, no logo design

Note: hand-lettering is the hardest test for AI. If outputs are weak, do the lettering by hand, scan, and overlay on AI-generated decorative marks.

## Group B: Atmosphere and environments

### B1: Banner or background art

> [Style anchor]. Atmospheric scene: [description, e.g. dark forest at night with two glowing eyes between trees]. Sketchy and loose, no creature shown clearly. Wide composition, atmosphere over detail.

Parameters:
- Midjourney: `--ar 16:9 --stylize 100`
- Flux: Flux Pro, prompt strength 0.8

### B2: Carousel slide art

> [Style anchor]. Single creature centred, more empty paper space than usual, room for hand-lettered text overlay later. Purple ink on cream paper background.

Parameters:
- Midjourney: `--ar 4:5 --stylize 50`
- Flux: Flux Pro, prompt strength 0.85

## Group C: Social content

### C1: Meme template visual

> [Style anchor]. [Meme idea, e.g. small cryptid with three eyes looking at a wallet, sad expression]. Rough sketch energy, joke is in the drawing. Single colour marker, loose, fast.

Parameters:
- Midjourney: `--ar 1:1 --stylize 25`
- Flux: Flux Schnell (faster, looser), prompt strength 0.7

### C2: BTS sketchbook page

> [Style anchor], styled as an open sketchbook page. Multiple small creature studies on one page, some half-drawn, marginalia, arrows, notes in marker. Coffee stain in corner. Looks like a real working sketchbook, not a finished piece.

Parameters:
- Midjourney: `--ar 4:5 --stylize 100 --weird 100`
- Flux: Flux Pro, prompt strength 0.9

## Test rubric

Score each output against the benchmark Oar Fish illustration on five dimensions, 1 to 5 each:

1. Marker medium believability (does it look like marker on paper?)
2. Linework looseness (wonky, not smooth)
3. Palette match (Oar Fish purples and accents)
4. Subject clarity (creature readable but not over-rendered)
5. Vibe (would this fit on a hoodie next to the existing Oar Fish?)

Below 18/25: reject. 18 to 21: keep iterating. 22 or above: save the exact prompt to `oarfish-winning-prompts.md` for reuse.

## Iteration tips

1. Generate four to eight variants per prompt before judging. Variance is high.
2. Lower stylize (Midjourney) or prompt strength (Flux) if outputs look too AI. Counterintuitive but usually correct for this aesthetic.
3. Do not fix wonkiness. First instinct will be to ask for cleaner lines. Resist.
4. Reject anything that looks like a cartoon mascot or Pixar character. AI defaults there given any opening.
5. If a Group A prompt is producing strong creatures, lock the exact wording before changing anything else.
6. Compare side-by-side with the benchmark in another tab. Memory drifts in 10 minutes.

## What AI image gen is for, and what it isn't

For:
- Ideation and rapid creature exploration
- Social content visuals (memes, atmosphere, sketchbook pages)
- Carousel slide art and banners
- Mood boards
- Mockup compositions

Not for:
- Final hoodie prints (every print starts from a real marker drawing)
- Customer or model photography (use real people, real environments)
- Variants of the existing Oar Fish mascot (the Oar Fish is the Oar Fish)
- Anything where the imperfection of human hands is the whole point

If a piece would go on a garment, generate the idea with AI, then redraw it by hand in marker. The hand-redraw is the doctrine, not optional.

## First action

1. Open the Oar Fish hoodie illustration as the visual benchmark
2. Run A1 with a placeholder creature like "small horned cat with too many legs"
3. Generate eight variants in Midjourney and eight in Flux
4. Score each against the rubric
5. Keep the highest scorer's exact prompt
6. Iterate the next prompt from there

Two hours of focused testing usually gets two or three locked prompts. That is enough to start.
