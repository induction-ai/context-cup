import { driverUrl } from "@/src/lib/links";

/** A driver's name, linked to its folder in the repo in a new tab. */
export function DriverLink({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={driverUrl(name)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {name}
    </a>
  );
}
