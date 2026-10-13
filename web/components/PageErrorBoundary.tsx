import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";

// A page that throws while rendering shows this in its place; the sidebar and the rest of the desk
// keep working. The Shell keys it by section, so moving to another page starts it fresh.

export class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[Jun Desk] page crashed:", error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-24 text-center">
        <h2 className="text-lg font-semibold">This page hit a problem</h2>
        <p className="text-sm text-muted-foreground">Something went wrong while showing it. The rest of the desk still works.</p>
        <code className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{error.message}</code>
        <div className="mt-2 flex gap-2">
          <Button variant="outline" type="button" onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button type="button" onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </div>
    );
  }
}
