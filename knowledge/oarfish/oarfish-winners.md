# Oar Fish Winners Knowledge Base

This is the Drop Brain memory layer. Every entry is one creative artifact that performed above benchmark, with enough metadata for retrieval and pattern matching.

## Entry format

Each winner is a separate markdown file in `/winners/{type}/{id}.md`.

### Required frontmatter

```yaml
---
id: w-2026-001
type: ad | email | caption | hook | product-copy | subject-line | meme | carousel
channel: meta | tiktok | instagram | x | klaviyo | shopify | sms
date: 2026-05-01
campaign: vol-01-launch | evergreen | restock | etc
product: forest-ghost-hoodie | null
metric: ctr | open-rate | cvr | save-rate | revenue | engagement-rate
metric-value: 8.4%
benchmark: 2.1%
tags: [hoodie, launch, lore, hand-drawn, weird-fit]
---
```

### Body

The actual creative as it ran. Include image alt text or describe the visual if the win was visual.

### Notes

Two to four sentences on why we think it worked. Be specific. Avoid post-hoc rationalisation. If it was lucky, say so.

## Example entry

```
---
id: w-2026-007
type: subject-line
channel: klaviyo
date: 2026-04-20
campaign: vol-01-launch
product: forest-ghost-hoodie
metric: open-rate
metric-value: 49.8%
benchmark: 28.0%
tags: [launch, lore, no-emoji, three-words]
---

Subject: The Forest Ghost arrives.

Notes: Three words. Definite article. Present tense. The creature gets named like a person, not described. No emoji. Scarcity sat in the body, not the subject. Audience already knew the lore from Friday's carousel.
```

## Retrieval rules

When generating new creative:

1. Match tags and channel first
2. Match product or creature type if relevant
3. Pull at least three entries before generating
4. Cite winner IDs in working notes (not in the final output)
5. If retrieval returns nothing relevant, say so before generating

## What does not go in winners

- Anything that won by paid amplification alone
- Anything that broke brand rules but still converted (track separately as "compromises" if at all)
- Anything from the pre-Vol-01 era before brand voice was locked
- Generic platform best practices not specific to Oar Fish

## Seed entries to load now

Until real performance data exists, seed the knowledge base with these as proxy winners. Replace with real winners once Vol. 01 ships.

1. Brand-voice exemplars (the strongest lines from oarfish.store and the brand brief), tagged `voice-exemplar`, type `caption`
2. Current Vol. 01 product copy (hoodies, tees, cap), tagged `voice-exemplar`, type `product-copy`
3. The launch-week post pack as drafted, tagged `seed`, type per format

The seed entries get retrieved as voice anchors. They get retired or downgraded as soon as real performers exist.
