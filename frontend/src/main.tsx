import { createRoot } from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/Toast";
import "./index.css";

const raiz = document.getElementById("root");
if (raiz) {
  createRoot(raiz).render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
}