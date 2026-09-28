import type { Ref } from "react";

/** Empty header strip: keeps the safe-area spacing and floats over the map when the drawer is full. */
export default function TopBar({ ref }: { ref?: Ref<HTMLElement> }) {
  return <header className="topbar" ref={ref} />;
}
