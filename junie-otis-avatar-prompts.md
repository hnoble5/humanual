# Humanual Coaches — Avatar Image Prompts (draft v1)

Written to work in most image generators (Adobe Firefly, Midjourney, DALL·E, etc.).
Firefly is a good fit if you're staying in Adobe: it's trained on licensed content, which matters for a commercial app.

**Goal:** a matching pair of flat, illustrated characters that are clearly not real people (supports the "AI, not human" message), easy to rebuild as vectors in Illustrator, and rig-friendly for Character Animator.

---

## Shared style block (paste into every prompt)

> flat vector illustration, clean simple shapes, soft rounded linework, limited color palette, friendly modern app mascot style, head-and-shoulders portrait, facing forward, centered, plain light background, gentle soft shading, approachable and calm, minimal detail, consistent character design

**Negative prompt / avoid** (if your tool supports it):

> photorealistic, 3D render, anime, chibi, exaggerated proportions, busy background, text, logo, watermark, harsh shadows, glossy, childish, creepy, uncanny

---

## Junie

### Main portrait
> [shared style block], a warm, wise young woman with a calm knowing half-smile, round wire-rim glasses, soft wavy shoulder-length hair loosely tucked behind one ear, cozy oversized knit cardigan over a simple top, color palette of sage green, warm honey, and cream, kind relaxed eyes, quietly perceptive expression, feels like a trusted friend who always knows what to say

### Expressions (for Character Animator swaps)
- **Listening:** ...head tilted slightly, soft attentive eyes, closed gentle smile
- **Reassuring:** ...warm open smile, eyebrows softly raised, slight nod
- **Thinking:** ...eyes glancing up and to the side, finger lightly at chin
- **Amused:** ...small knowing smile, eyes slightly crinkled, dry gentle humor
- **Concerned:** ...eyebrows gently drawn together, soft serious expression, caring not alarmed

---

## Otis

### Main portrait
> [shared style block], a calm, dry-witted young man with a relaxed half-smile and one eyebrow slightly raised, short slightly messy hair under a knit beanie, light stubble, sleeves of a simple henley rolled up, color palette of slate blue, charcoal, and a pop of mustard yellow, steady unbothered eyes, amused and unflappable expression, feels like a straight-talking friend who has already seen through the nonsense

### Expressions
- **Listening:** ...steady direct gaze, neutral relaxed mouth, slight head tilt
- **Verdict:** ...small confident smirk, one eyebrow raised
- **Thinking:** ...eyes narrowed slightly, mouth to one side, analyzing
- **Amused:** ...dry half-grin, eyes glancing sideways
- **Concerned:** ...brows level and serious, calm steady expression, attentive

---

## Pair shot (for the landing page)
> [shared style block], two friendly illustrated characters side by side: a warm woman in round glasses and a sage green cardigan with a knowing smile, and a dry-witted man in a slate blue henley and mustard beanie with a raised eyebrow, both looking toward the viewer, same art style and line weight, balanced composition, plain light background with space above for a headline

---

## Tips for your Adobe workflow
- **Generate several, then rebuild.** Use the best result as reference and redraw it in Illustrator with clean layers (head, hair, eyes, eyebrows, mouth, body). That gives you full ownership and a rig-ready file.
- **Character Animator naming.** Name layers with its conventions (Head, Left Eye, Right Eye, Mouth, Left Eyebrow, etc.) so auto-rigging and mouth visemes work.
- **Keep both in one style.** Same line weight, shading, and proportions so they read as a matched pair.
- **App sizes:** test at 40px (chat bubble) and 200px (picker). Simplify anything that turns to mush at small sizes.
- **Before launch:** check the generator's terms on commercial use, and avoid naming living artists or existing characters in prompts.
