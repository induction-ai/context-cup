import { ICONS } from "../components/pixel_icon";

/** What the site's metadata and its generated images (favicon, touch icon,
 *  social card) share. The images are drawn outside the stylesheet, so these
 *  colours copy `$cc-*` in app/globals.scss; keep them in step. */
export const COLORS = {
  cream: "#f3ebdb",
  paper: "#f8f2e4",
  ink: "#151515",
};

export const SITE_NAME = "Context Cup";
export const SITE_DESCRIPTION =
  "A coding competition to make the most efficient agentic context engine.";

/** The site's public address, for the absolute links metadata needs (social
 *  cards, the sitemap). */
export const SITE_URL = new URL("https://www.contextcup.ai");

/** The site bar's checker flag, its light squares filled with paper so it
 *  reads on a dark browser tab too. For `ImageResponse`. */
export function Flag({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      shapeRendering="crispEdges"
    >
      <rect x={0} y={2} width={16} height={12} fill={COLORS.paper} />
      {ICONS.flag.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={COLORS.ink} />
      ))}
    </svg>
  );
}
