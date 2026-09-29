import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import { watchGutter } from "../../shared/gutter.ts"
import App from "./App.tsx"
import "./index.css"

watchGutter()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
