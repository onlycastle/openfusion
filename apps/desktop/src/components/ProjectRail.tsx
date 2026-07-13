import { baseName, useProject, type Section } from "../ProjectContext";

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "harness", label: "Harness setting" },
  { id: "health", label: "Health" },
];

export function ProjectRail() {
  const { activeProjectDir, section, setSection } = useProject();

  if (activeProjectDir === null) {
    return <nav className="project-rail project-rail-empty" aria-label="Project sections">No project selected</nav>;
  }

  return (
    <nav className="project-rail" aria-label="Project sections">
      <div className="project-rail-head">{baseName(activeProjectDir)}</div>
      <ul className="section-list">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={s.id === section ? "section-item section-item-active" : "section-item"}
              aria-current={s.id === section ? "page" : undefined}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
