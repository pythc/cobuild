export interface SuiteRuntime {
  native: boolean;
  platform: string;
  relay: boolean;
}
let runtime: SuiteRuntime | undefined;
export const suiteRuntime = () => runtime;
export async function loadSuiteRuntime() {
  const response = await fetch("/api/selfhost/config", {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Cannot load suite configuration");
  runtime = await response.json();
}
