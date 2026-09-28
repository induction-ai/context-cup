import { readFile } from "node:fs/promises";
import path from "node:path";
import { COLORS } from "@/src/lib/brand";
import { ImageResponse } from "next/og";

// The social card: the home page's hero art on cream, as it sits on the page.
export const alt =
  "A pixel-art go-kart racing under a Context Cup banner on a coastal road at sunset";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const HERO = { width: 936, height: 474 };

export default async function OpengraphImage() {
  const hero = await readFile(path.join(process.cwd(), "public", "hero.png"));
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          background: COLORS.cream,
        }}
      >
        <img
          src={`data:image/png;base64,${hero.toString("base64")}`}
          width={size.width}
          height={(size.width * HERO.height) / HERO.width}
          style={{ imageRendering: "pixelated" }}
        />
      </div>
    ),
    size
  );
}
