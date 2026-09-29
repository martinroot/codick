import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
// Bootstrap's behaviour, not its styles. The dropdown, modal, offcanvas and
// collapse components are driven by `data-bs-toggle` attributes, and
// without this bundle those attributes are inert markup: the stylesheet
// ships the component's appearance and none of its behaviour, so a control
// looks like a dropdown and does nothing when pressed.
//
// The bundle rather than the individual modules, so Popper comes with it —
// the dropdown positions itself with it.
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import "./index.css";
import App from "./App";
import { SystemActionsProvider } from "./contexts/SystemActions";
import { I18nProvider } from "./i18n";
import { exposePluginSDK } from "./plugins";
import { ThemeProvider } from "./themes";
import { HERMES_BASE_PATH } from "./lib/api";

// Expose the plugin SDK before rendering so plugins loaded via <script>
// can access React, components, etc. immediately.
exposePluginSDK();

createRoot(document.getElementById("root")!).render(
  <BrowserRouter basename={HERMES_BASE_PATH || undefined}>
    <I18nProvider>
      <ThemeProvider>
        <SystemActionsProvider>
          <App />
        </SystemActionsProvider>
      </ThemeProvider>
    </I18nProvider>
  </BrowserRouter>,
);
