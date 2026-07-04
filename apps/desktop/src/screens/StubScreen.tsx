interface StubScreenProps {
  title: string;
}

/** Placeholder for the Orchestrate/Evals routes — those cockpit screens are
 * M7c scope. This just marks the route as reachable and reserved. */
export function StubScreen({ title }: StubScreenProps) {
  return (
    <section className="screen stub-screen">
      <h1>{title}</h1>
      <p>Coming in M7c.</p>
    </section>
  );
}
