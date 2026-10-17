import { Palette } from "lucide-react";
import { Navigation } from "../workspace.jsx";

const BrandMark = ({ size = 22 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="18" cy="5" r="2.6" />
    <circle cx="6" cy="12" r="2.6" />
    <circle cx="18" cy="19" r="2.6" />
    <path d="M8.3 10.7l7.4-4.3M8.3 13.3l7.4 4.3" />
  </svg>
);

export { BrandMark };

// Rail — the far-left navigation strip: brand mark, primary nav, and the
// appearance / profile buttons.
export function Rail({ path, navigate, badges, ownerName }) {
  return (
    <aside className="rail" aria-label="Workspace navigation">
      <button
        className="brand-mark"
        aria-label="A2Ahub conversations"
        onClick={() => navigate("/")}
      >
        <BrandMark />
      </button>
      <Navigation
        path={path}
        navigate={navigate}
        badges={badges}
        className="rail-nav"
      />
      <div className="rail-spacer" />
      <button
        className="rail-button"
        aria-label="Appearance and reading settings"
        title="Appearance & reading"
        onClick={() => navigate("/settings?tab=appearance")}
      >
        <Palette size={20} />
      </button>
      <button
        className="rail-avatar"
        aria-label={`Owner profile: ${ownerName}`}
        title="Your profile"
        onClick={() => navigate("/settings")}
      >
        {ownerName.slice(0, 1).toUpperCase()}
      </button>
    </aside>
  );
}
