import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WidgetApp } from "./WidgetApp.tsx";
import "../styles.css";
import "./widget.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WidgetApp widgetKey={new URLSearchParams(window.location.search).get("key") ?? ""} />
  </StrictMode>,
);
