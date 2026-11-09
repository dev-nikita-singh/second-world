/** Entry of the `sw ui` browser app (bundled by src/ui/web/build.ts). */
import { render } from "preact";
import { initToken } from "./api.js";
import { App } from "./app.js";

initToken();
const root = document.getElementById("app");
if (root) render(<App />, root);
