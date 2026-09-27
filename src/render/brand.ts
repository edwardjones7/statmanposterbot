export interface Brand {
  clientName: string;
  colors: {
    /** Canvas behind the card. */
    canvas: string;
    card: string;
    /** Card outline. */
    border: string;
    /** Divider above the date. */
    divider: string;
    /** Display name. */
    heading: string;
    /** Tweet body. */
    text: string;
    /** Handle and date. Must stay readable (WCAG AA), so not a "muted" grey. */
    secondary: string;
    /** @mentions, #hashtags and links. */
    accent: string;
  };
  /** Tiled background texture: a path (resolved by the platform loader) or a data URI. Empty = none. */
  texture: string;
  footer: {
    /** Shown under the card, e.g. "@clienthandle". Empty string hides it. */
    text: string;
    /** Logo shown next to the footer text: a path or a data URI. Empty = none. */
    logo: string;
  };
  /** Emoji artwork baked into the image. */
  emoji: "apple" | "twemoji";
  /** Set numbers (records, odds, percentages) in the mono font. */
  monoNumbers: boolean;
  showDate: boolean;
  /** IANA time zone the tweet timestamp is shown in. */
  timeZone: string;
  caption: {
    /** Line appended after the tweet text. */
    signoff: string;
    /** Always included; sport hashtags (#NFL, #CBB…) are added when the text mentions them. */
    hashtags: string[];
  };
}
