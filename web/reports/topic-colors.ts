import { PALETTE, rgb, type DitherColor } from "@/components/dither-kit/palette.ts";

// The topics donut's slice colours, shared with the topic rows' swatches (palette.ts has no deps,
// so the rows can use it without loading the lazy chart code).

/** Slices the donut shows; the rest of the topics are one grey "Other" slice. */
export const DONUT_SLICES = 5;
export const SLICE_COLORS: DitherColor[] = ["blue", "purple", "pink", "orange", "green"];
/** CSS colour of the i-th topic's slice, or null past the coloured slices. */
export const sliceColor = (i: number): string | null => {
  const color = Number.isInteger(i) && i >= 0 && i < DONUT_SLICES ? SLICE_COLORS[i] : undefined;
  return color ? rgb(PALETTE[color].fill) : null;
};
