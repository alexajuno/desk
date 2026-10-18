// A page that crashed, in place of React Router's bare "Unexpected Application Error!". Most often the app a tab has
// meets a desk of another version, since desk runs whichever commit Try, a test or a landing checked out, and a reload
// brings the app that matches: so it reloads once on its own. Crashing again within a minute shows the error, with a
// Reload button, rather than reloading in a loop.
import { useEffect } from "react";
import { useRouteError } from "react-router";

const AGAIN = 60_000; // ms within which a second crash stops the reloading

export function Crashed() {
  const error = useRouteError();
  const again = Date.now() - Number(sessionStorage.crashedAt ?? 0) < AGAIN;
  useEffect(() => {
    console.error(error);
    if (again) return;
    sessionStorage.crashedAt = Date.now();
    location.reload();
  }, [error, again]);
  if (!again) return null;
  return (
    <div className="crashed">
      <h1>This page crashed</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <button className="primary" type="button" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}
