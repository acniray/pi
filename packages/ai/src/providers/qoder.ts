import { createQoderProvider } from "./qoder/native.ts";

export const qoderProvider = () => createQoderProvider("global");
