import { COLORS, Flag } from "@/src/lib/brand";
import { ImageResponse } from "next/og";

// The home-screen icon: the flag on cream, since iOS fills transparency with
// black and rounds the corners off.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: COLORS.cream,
        }}
      >
        <Flag size={128} />
      </div>
    ),
    size
  );
}
