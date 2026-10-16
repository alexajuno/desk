import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { setNavigate } from "./app/nav";
import { router } from "./app/routes";
import { watchTheme } from "./frame/theme";
import { startFrame } from "./store/frame";
import { issues } from "./store/issues";
import { connect } from "./sync/socket";
import { installTooltips } from "./ui/tooltip";
// desk's own stylesheets, shared with the old pages while both exist, so both look the same.
import "../../../desk/static/desk.css";
import "../../../desk/static/sessions.css";
import "./index.css";

watchTheme();
installTooltips();
connect(issues);
startFrame();
setNavigate((to, opts) => router.navigate(to, opts));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
