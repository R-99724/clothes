import { createRoot } from "react-dom/client";
import AccountApp from "./account-app";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(<AccountApp />);
