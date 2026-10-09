// casefile UI entry point. The shell (shell/shell.js) owns the header, routing and focus; screens
// live in views/ and are listed in routes.js.
import { startApp } from "./shell/shell.js";

startApp(document.getElementById("app"));
