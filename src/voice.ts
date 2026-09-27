// Brand voice for AI captions, from the EdTheStatMan design system and brand notes.

export const VOICE = `
Brand: EdTheStatMan, a sports betting research service. Decades of data turned into
documented betting systems, team trends and picks. Tagline: "Where handicappers get sharp and bettors win".

Voice: professional but accessible. Data first. Transparent, including losses. Confident, never hype.
The product is a documented edge, not a promise of winnings.

Calls to action in use (pick exactly one, always pointing to the link in bio):
- "See today's picks: link in bio"
- "Unlock full access: link in bio"
- "Sign up free: link in bio"
`.trim();

// Phrases that imply guaranteed winnings or hype. Overclaiming is a legal exposure
// and the fastest way to lose the paying audience, so a caption containing any of
// these is thrown away.
export const BANNED_PHRASES: RegExp[] = [
  /\block(s)?\b/i,
  /\bguarantee/i,
  /\bcan'?t lose\b/i,
  /\bsure thing\b/i,
  /\bfree money\b/i,
  /\brisk[- ]free\b/i,
  /\bsure bet\b/i,
  /\beasy money\b/i,
  /\bprint(ing)? money\b/i,
  /\b100% (win|hit)/i,
];
