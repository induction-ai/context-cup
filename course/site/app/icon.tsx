import { Flag } from "@/src/lib/brand";
import { ImageResponse } from "next/og";

// The favicon: the site bar's flag, 2px to a grid unit.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(<Flag size={size.width} />, size);
}
